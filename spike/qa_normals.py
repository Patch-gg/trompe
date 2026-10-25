"""Hallucination check, take 2: compare Marigold normals of a generated view with the true geometry normals.

Normals need no scale fit, and a 3D object painted onto a flat wall shows up as normals that bend away from
the wall. Writes out/qa/normals_<label>.jpg: image | angular error heatmap | flagged (> 35 deg) in red.
"""
import io
import itertools
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


def marigold_normals(img, label):
    raw = os.path.join(QA, f'raw_normals_{label}.png')
    if not os.path.exists(raw):
        url = models.upload(img)
        r = fal_client.subscribe('fal-ai/marigold-v2', arguments={'image_url': url, 'prediction_type': 'normals'})
        Image.open(io.BytesIO(requests.get(r['image']['url'], timeout=120).content)).convert('RGB').save(raw)
    out = Image.open(raw)
    if out.size != (img.shape[1], img.shape[0]):
        out = out.resize((img.shape[1], img.shape[0]), Image.BILINEAR)
    n = np.asarray(out, np.float32) / 127.5 - 1.0
    return n / np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-6)


def check(label, img, view):
    pred = marigold_normals(img, label)
    cam = view.nrm @ view.R.T.astype(np.float32)          # world -> camera (x right, y up, z toward viewer)
    g = view.alpha
    best = None
    for sx, sy, sz in [(1, 1, 1)]:   # Marigold encoding: x right, y up, z toward the camera
        p = pred * np.array([sx, sy, sz], np.float32)
        ang = np.degrees(np.arccos(np.clip((p * cam).sum(-1), -1, 1)))
        med = np.median(ang[g])
        if best is None or med < best[0]:
            best = (med, (sx, sy, sz), ang)
    med, conv, ang = best
    flag = ndimage.binary_opening(g & (ang > 35), iterations=3)
    pct = 100 * flag.sum() / g.sum()
    heat = (np.clip(ang / 60, 0, 1)[..., None] * np.array([255, 60, 30]) +
            (1 - np.clip(ang / 60, 0, 1))[..., None] * np.array([20, 20, 20])).astype(np.uint8)
    heat[~g] = 0
    over = img.copy()
    over[flag] = (0.4 * over[flag] + 0.6 * np.array([255, 30, 30])).astype(np.uint8)
    Image.fromarray(np.concatenate([img, heat, over], 1)).save(os.path.join(QA, f'normals_{label}.jpg'), quality=90)
    print(f'{label}: axes={conv} median angle err={med:.1f} deg, flagged {pct:.1f}% of geometry pixels')


def main():
    runs = os.path.join(common.OUT, 'runs')
    cases = [
        ('klein_v1_ext', 'base/exterior/flux3-klein/v1_out.jpg', 'exterior', 'v1'),
        ('gpt25_v1_ext', 'base/exterior/gpt-image-2.5/v1_out.jpg', 'exterior', 'v1'),
        ('klein+fibo2_v3_ext', 'hybrid/exterior/flux3-klein+fibo2/v3_out.jpg', 'exterior', 'v3'),
    ]
    if len(sys.argv) > 1:
        cases = [c for c in cases if c[0] in sys.argv[1:]]
    scene = common.load_scene('exterior')
    for label, rel, _, vn in cases:
        img = np.asarray(Image.open(os.path.join(runs, rel)).convert('RGB'))
        check(label, img, scene.views[vn])


if __name__ == '__main__':
    main()
