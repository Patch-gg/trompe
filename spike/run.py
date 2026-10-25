"""Run image-edit models through the same sequential texturing chain on each scene.

Chain per (scene, model): v1 from pure clay -> project; v2 and v3 see the projected texture plus clay
and fill the rest -> project; v4 is held out and rendered from the resulting texture.

Usage (FAL_KEY in the environment):
  .venv/bin/python run.py --tag base                                   # every model, every scene
  .venv/bin/python run.py --tag hybrid --first flux3-klein --cont fibo2 [--quality-ratio 0.4] [--blend match]
"""
import argparse
import json
import os
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
from PIL import Image

import common
import metrics
import models

STYLE = {
    'exterior': ('a sunlit Mediterranean village square: weathered limestone and ochre plaster walls with '
                 'wooden doors and shuttered windows, worn stone paving, a carved stone fountain, old wooden '
                 'crates'),
    'interior': ('an abandoned industrial hall: cracked dusty concrete floor with debris, peeling painted '
                 'plaster walls, rusted steel beams, grimy window frames, old wooden crates and a rusty '
                 'machine'),
}
RUNS = os.path.join(common.OUT, 'runs')
compute_lock = threading.Lock()


def save(arr, path):
    Image.fromarray(arr).save(path, quality=92)


def chain(scene, first_model, cont_model, views, tag, label, quality_ratio, blend_mode):
    d = os.path.join(RUNS, tag, scene.name, label)
    os.makedirs(d, exist_ok=True)
    logf = open(os.path.join(d, 'log.txt'), 'w')

    def log(msg):
        line = f'[{tag}/{scene.name}/{label}] {msg}'
        print(line, flush=True)
        logf.write(line + '\n')
        logf.flush()

    tex = common.Texture(scene, quality_ratio=quality_ratio)
    rows = []
    for i, vn in enumerate(views):
        view = scene.views[vn]
        first = i == 0
        model = first_model if first else cont_model
        with compute_lock:
            state, known = tex.state(view)
            mask = view.alpha.copy() if first else common.edit_mask(view, known)
        out, info = models.run(model, state, mask, STYLE[scene.name], first, log=log)
        with compute_lock:
            hard = metrics.blend(state, out, known, view.alpha, 'hard')
            m = metrics.view_metrics(view, state, out, hard, known, first)
            comp = hard if blend_mode == 'hard' else metrics.blend(state, out, known, view.alpha, blend_mode)
            n_new = tex.project(view, comp)
        save(state, os.path.join(d, f'{vn}_state.jpg'))
        save((mask * 255).astype(np.uint8), os.path.join(d, f'{vn}_mask.png'))
        save(out, os.path.join(d, f'{vn}_out.jpg'))
        save(comp, os.path.join(d, f'{vn}_comp.jpg'))
        row = {'scene': scene.name, 'model': model.key, 'view': vn, 'new_texels': n_new, **info, **m}
        rows.append(row)
        log(' '.join(f'{k}={v:.3g}' if isinstance(v, float) else f'{k}={v}' for k, v in row.items()
                     if k not in ('scene', 'endpoint')))
    held = scene.views['v4']
    with compute_lock:
        st, known4 = tex.state(held)
        hole = held.alpha & ~known4
        tint = np.where(hole[..., None], (0.5 * st + 0.5 * np.array([255, 0, 200])).astype(np.uint8), st)
        cov = tex.coverage(held)
        tex.save_preview(os.path.join(d, 'texture.jpg'))
    save(tint.astype(np.uint8), os.path.join(d, 'v4_heldout.jpg'))
    summary = {'tag': tag, 'scene': scene.name, 'model': label, 'first_model': first_model.key,
               'cont_model': cont_model.key, 'quality_ratio': quality_ratio, 'blend': blend_mode,
               'heldout_coverage': cov, 'views': rows}
    json.dump(summary, open(os.path.join(d, 'metrics.json'), 'w'), indent=1)
    log(f'done, held-out coverage {cov:.3f}')
    return summary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tag', default='base')
    ap.add_argument('--models', default=','.join(models.MODELS), help='one chain per model (ignored with --first)')
    ap.add_argument('--first', help='model for the first view of a hybrid chain')
    ap.add_argument('--cont', help='model for the continuation views of a hybrid chain')
    ap.add_argument('--scenes', default='exterior,interior')
    ap.add_argument('--views', default='v1,v2,v3')
    ap.add_argument('--quality-ratio', type=float, default=None)
    ap.add_argument('--blend', default='hard', choices=metrics.BLENDS)
    ap.add_argument('--workers', type=int, default=14)
    a = ap.parse_args()
    scenes = {s: common.load_scene(s) for s in a.scenes.split(',')}
    views = a.views.split(',')
    if a.first:
        pairs = [(models.MODELS[a.first], models.MODELS[a.cont or a.first])]
    else:
        pairs = [(models.MODELS[m], models.MODELS[m]) for m in a.models.split(',')]
    jobs = []
    for s in scenes.values():
        for fm, cm in pairs:
            label = fm.key if fm is cm else f'{fm.key}+{cm.key}'
            jobs.append((s, fm, cm, label))
    results, failed = [], []
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(chain, s, fm, cm, views, a.tag, label, a.quality_ratio, a.blend): (s.name, label)
                for s, fm, cm, label in jobs}
        for f in as_completed(futs):
            try:
                results.append(f.result())
            except Exception as e:
                failed.append(futs[f])
                print(f'FAILED {futs[f]}: {e}', flush=True)
                traceback.print_exc()
    print('finished', len(results), 'chains; failed:', failed, flush=True)


if __name__ == '__main__':
    main()
