"""Hallucination check: does the generated image's monocular depth agree with the real geometry?

Runs fal-ai/marigold-v2 (depth) on a generated view, fits it to the rendered depth with a robust affine fit
(trying both depth and inverse-depth conventions), and flags pixels whose relative error exceeds 25%.
Writes out/qa/<label>.jpg: generated image | flagged pixels in red.
"""
import io
import os
import sys

import fal_client
import numpy as np
import requests
from PIL import Image
from scipy import ndimage

import common
import models

QA = os.path.join(common.OUT, 'qa')
os.makedirs(QA, exist_ok=True)


def marigold_depth(img, label):
    raw = os.path.join(QA, f'raw_{label}.png')
    if not os.path.exists(raw):
        url = models.upload(img)
        r = fal_client.subscribe('fal-ai/marigold-v2', arguments={'image_url': url, 'prediction_type': 'depth'})
        Image.open(io.BytesIO(requests.get(r['image']['url'], timeout=120).content)).convert('RGB').save(raw)
    out = Image.open(raw)
    if out.size != (img.shape[1], img.shape[0]):
        out = out.resize((img.shape[1], img.shape[0]), Image.NEAREST)
    return np.asarray(out, np.float32)


def uncolormap(vis):
    """fal returns Marigold depth as a colour-mapped PNG; recover the scalar via the closest colormap entry."""
    from matplotlib import colormaps
    px = vis.reshape(-1, 3) / 255.0
    best = None
    for name in ('Spectral', 'Spectral_r', 'turbo', 'viridis', 'inferno', 'magma', 'plasma', 'gray'):
        lut = colormaps[name](np.linspace(0, 1, 512))[:, :3]
        d = ((px[::97, None, :] - lut[None]) ** 2).sum(-1)
        err = np.sqrt(d.min(1)).mean()
        if best is None or err < best[0]:
            best = (err, name, lut)
    err, name, lut = best
    idx = np.empty(len(px), np.int64)
    for i in range(0, len(px), 65536):
        idx[i:i + 65536] = ((px[i:i + 65536, None, :] - lut[None]) ** 2).sum(-1).argmin(1)
    return (idx / 511.0).reshape(vis.shape[:2]), name, err


def robust_fit(x, y, iters=3, keep=0.8):
    sel = np.ones(len(x), bool)
    for _ in range(iters):
        A = np.stack([x[sel], np.ones(sel.sum())], 1)
        coef, *_ = np.linalg.lstsq(A, y[sel], rcond=None)
        res = np.abs(coef[0] * x + coef[1] - y)
        sel = res <= np.quantile(res, keep)
    return coef


def check(label, img, view):
    vis = marigold_depth(img, label)
    m, cmap, cerr = uncolormap(vis)
    z = -((view.pos - view.C[None, None, :].astype(np.float32)) @ view.R.T.astype(np.float32))[..., 2]
    g = view.alpha & (z > 0.1)
    best = None
    for name, target in (('depth', z), ('inverse', 1.0 / np.maximum(z, 0.1))):
        coef = robust_fit(m[g], target[g])
        pred = coef[0] * m + coef[1]
        zp = pred if name == 'depth' else 1.0 / np.maximum(pred, 1e-3)
        err = np.abs(zp - z) / z
        score = np.median(err[g])
        if best is None or score < best[0]:
            best = (score, name, err)
    _, conv, err = best
    flag = g & (err > 0.25)
    flag = ndimage.binary_opening(flag, iterations=2)
    pct = 100 * flag.sum() / g.sum()
    over = img.copy()
    over[flag] = (0.4 * over[flag] + 0.6 * np.array([255, 30, 30])).astype(np.uint8)
    Image.fromarray(np.concatenate([img, over], 1)).save(os.path.join(QA, f'{label}.jpg'), quality=90)
    print(f'{label}: colormap={cmap} (fit {cerr:.3f}) convention={conv} median rel err={best[0]:.3f} '
          f'flagged={pct:.1f}% of geometry pixels')
    return pct


def main():
    runs = os.path.join(common.OUT, 'runs')
    cases = [
        ('klein_v1_ext', 'base/exterior/flux3-klein/v1_out.jpg', 'exterior', 'v1'),
        ('gpt25_v1_ext', 'base/exterior/gpt-image-2.5/v1_out.jpg', 'exterior', 'v1'),
        ('fibo2_v1_ext', 'base/exterior/fibo2/v1_out.jpg', 'exterior', 'v1'),
        ('klein+fibo2_v3_ext', 'hybrid/exterior/flux3-klein+fibo2/v3_out.jpg', 'exterior', 'v3'),
        ('klein_v1_int', 'base/interior/flux3-klein/v1_out.jpg', 'interior', 'v1'),
        ('fibo2_v1_int', 'base/interior/fibo2/v1_out.jpg', 'interior', 'v1'),
    ]
    if len(sys.argv) > 1:
        cases = [c for c in cases if c[0] in sys.argv[1:]]
    scenes = {}
    for label, rel, scene, vn in cases:
        if scene not in scenes:
            scenes[scene] = common.load_scene(scene)
        img = np.asarray(Image.open(os.path.join(runs, rel)).convert('RGB'))
        check(label, img, scenes[scene].views[vn])


if __name__ == '__main__':
    main()
