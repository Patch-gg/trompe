"""fal adapters for the image-edit models under test, with a content-addressed result cache.

Each adapter knows its endpoint, whether it takes a mask (and which colour means "edit"), and how to
phrase the request. Prices are the per-image numbers fal lists today (token-priced models estimated).
"""
import hashlib
import io
import json
import os
import time

import fal_client
import numpy as np
import requests
from PIL import Image

from common import OUT

CACHE = os.path.join(OUT, 'cache')
os.makedirs(CACHE, exist_ok=True)

NEGATIVE = 'new objects, people, text, watermark, changed perspective, warped geometry, blurry'


def prompt_first(style):
    return (f'Turn this untextured gray 3D render into a photorealistic photo of {style}. Keep exactly the '
            'same camera, perspective, geometry and edges, and the same light direction and shadows. Do not '
            'add, remove or move any objects; only give the existing surfaces realistic materials.')


def prompt_continue(style):
    return (f'This is a partly textured render of {style}. Replace only the plain gray untextured surfaces with '
            'photorealistic materials that seamlessly continue the already textured areas. Keep the textured '
            'areas, the camera, perspective, geometry, edges, light direction and shadows exactly the same. Do '
            'not add, remove or move any objects.')


def prompt_masked(style):
    return (f'Fill the masked area with photorealistic materials that seamlessly continue the surrounding '
            f'textured surfaces: {style}. Keep the camera, perspective, geometry, edges, light direction and '
            'shadows exactly the same. Do not add new objects.')


def caption_first(style):  # FLUX.3 Klein wants a full caption of the target image
    return (f'A photorealistic photo of {style}, with exactly the layout, camera perspective, edges, light '
            'direction and shadows of image 1; the gray untextured surfaces of image 1 now have realistic '
            'materials, and no objects are added or removed.')


def caption_continue(style):
    return (f'A photorealistic photo of {style}, identical to image 1 in layout, camera perspective, edges, '
            'lighting and in every already textured area, where the plain gray untextured surfaces of image 1 '
            'now continue those textures seamlessly with realistic materials; no objects are added or removed.')


class Model:
    key = endpoint = None
    mask = None            # None | 'white' (white = edit) | 'black' (black = edit)
    price = 0.0

    def args(self, img_url, mask_url, style, first, seed):
        raise NotImplementedError


class Klein(Model):
    key, endpoint, price = 'flux3-klein', 'blackforestlabs/flux-3/klein/edit-image', 0.009

    def args(self, img_url, mask_url, style, first, seed):
        return {'prompt': (caption_first if first else caption_continue)(style), 'image_urls': [img_url],
                'image_size': {'width': 1024, 'height': 1024}, 'seed': seed, 'output_format': 'png',
                'enable_prompt_expansion': False, 'num_images': 1}


class Fibo2(Model):
    key, endpoint, price, mask = 'fibo2', 'bria/fibo-2/edit', 0.04, 'white'

    def args(self, img_url, mask_url, style, first, seed):
        a = {'instruction': (prompt_first(style) if first else prompt_masked(style)),
             'image_urls': [img_url], 'seed': seed}
        if mask_url:
            a['mask_url'] = mask_url
        return a


class Qwen3(Model):
    key, endpoint, price = 'qwen-image-3', 'alibaba/qwen-image-3/edit', 0.04

    def args(self, img_url, mask_url, style, first, seed):
        return {'prompt': (prompt_first if first else prompt_continue)(style), 'image_urls': [img_url],
                'seed': seed, 'image_size': {'width': 1024, 'height': 1024}, 'output_format': 'png',
                'enable_prompt_expansion': False, 'negative_prompt': NEGATIVE, 'num_images': 1}


class Flux3(Model):
    key, endpoint, price = 'flux3', 'blackforestlabs/flux-3/edit-image', 0.048

    def args(self, img_url, mask_url, style, first, seed):
        return {'prompt': (prompt_first if first else prompt_continue)(style), 'image_urls': [img_url],
                'aspect_ratio': '1:1', 'resolution': '1k', 'output_format': 'png',
                'enable_prompt_expansion': False}


class NanoBanana21(Model):
    key, endpoint, price = 'nano-banana-2.1', 'google/nano-banana-2.1/edit', 0.05

    def args(self, img_url, mask_url, style, first, seed):
        return {'prompt': (prompt_first if first else prompt_continue)(style), 'image_urls': [img_url],
                'resolution': '1K', 'aspect_ratio': '1:1', 'seed': seed, 'output_format': 'png',
                'num_images': 1}


class GptImage25(Model):
    key, endpoint, price, mask = 'gpt-image-2.5', 'openai/gpt-image-2.5/flare/edit', 0.05, 'white'

    def args(self, img_url, mask_url, style, first, seed):
        a = {'prompt': (prompt_first(style) if first else prompt_masked(style)), 'image_urls': [img_url],
             'image_size': {'width': 1024, 'height': 1024}, 'quality': 'medium', 'output_format': 'png',
             'num_images': 1}
        if mask_url:
            a['mask_url'] = mask_url
        return a


class Ideogram45(Model):
    key, endpoint, price, mask = 'ideogram-4.5', 'ideogram/v4.5/edit', 0.06, 'black'

    def args(self, img_url, mask_url, style, first, seed):
        a = {'image_url': img_url, 'prompt': (prompt_first(style) if first else prompt_masked(style)),
             'quality': 'medium', 'seed': seed, 'num_images': 1,
             'edit_precision': 'regular' if first else 'high'}
        if mask_url and not first:   # Ideogram rejects masks that are all-edit
            a['mask_url'] = mask_url
        return a


MODELS = {m.key: m() for m in (Klein, Fibo2, Qwen3, Flux3, NanoBanana21, GptImage25, Ideogram45)}


def _png_bytes(arr):
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format='PNG')
    return buf.getvalue()


_upload_cache = {}


def upload(arr):
    data = _png_bytes(arr)
    h = hashlib.sha256(data).hexdigest()
    if h not in _upload_cache:
        _upload_cache[h] = fal_client.upload(data, 'image/png')
    return _upload_cache[h]


def run(model, image, mask, style, first, seed=7, log=print):
    """Call a model; returns (HxWx3 uint8 at the input size, info dict). Cached on all inputs."""
    mask_img = None
    if model.mask and mask is not None:
        edit = mask if model.mask == 'white' else ~mask
        mask_img = (edit.astype(np.uint8) * 255)
    img_bytes = _png_bytes(image)
    h = hashlib.sha256()
    for part in (model.endpoint, img_bytes, mask_img.tobytes() if mask_img is not None else b'', style,
                 str(first), str(seed), json.dumps(model.args('IMG', 'MASK', style, first, seed), sort_keys=True)):
        h.update(part if isinstance(part, bytes) else part.encode())
    key = h.hexdigest()[:24]
    png, meta = os.path.join(CACHE, key + '.png'), os.path.join(CACHE, key + '.json')
    if os.path.exists(png) and os.path.exists(meta):
        return np.asarray(Image.open(png).convert('RGB')), json.load(open(meta))
    img_url = upload(image)
    mask_url = upload(np.stack([mask_img] * 3, -1)) if mask_img is not None else None
    args = model.args(img_url, mask_url, style, first, seed)
    t0 = time.time()
    result = fal_client.subscribe(model.endpoint, arguments=args)
    dt = time.time() - t0
    images = result.get('images') or ([result['image']] if result.get('image') else [])
    url = images[0]['url']
    out = Image.open(io.BytesIO(requests.get(url, timeout=120).content)).convert('RGB')
    info = {'model': model.key, 'endpoint': model.endpoint, 'seconds': round(dt, 1), 'price': model.price,
            'out_size': list(out.size), 'first': first}
    if out.size != (image.shape[1], image.shape[0]):
        out = out.resize((image.shape[1], image.shape[0]), Image.LANCZOS)
    out.save(png)
    json.dump(info, open(meta, 'w'))
    log(f'{model.key}: {dt:.1f}s, native size {info["out_size"]}')
    return np.asarray(out), info
