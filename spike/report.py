"""Aggregate run metrics into a markdown table and build contact sheets."""
import glob
import json
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import common

RUNS = os.path.join(common.OUT, 'runs')
TILE = 320


def font(size):
    for p in ('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf'):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def nanmean(xs):
    xs = [x for x in xs if x is not None and not (isinstance(x, float) and np.isnan(x))]
    return float(np.mean(xs)) if xs else float('nan')


def load():
    return [json.load(open(p)) for p in sorted(glob.glob(os.path.join(RUNS, '*', '*', '*', 'metrics.json')))]


def table(summaries):
    groups = {}
    for s in summaries:
        groups.setdefault((s['tag'], s['model']), []).append(s)
    rows = []
    for (tag, label), ss in groups.items():
        first = [v for s in ss for v in s['views'] if v['first']]
        later = [v for s in ss for v in s['views'] if not v['first']]
        rows.append({
            'run': tag, 'chain': label,
            'first: edge offset px': nanmean([v['align_mean_px'] for v in first]),
            'first: edges lost %': 100 * nanmean([v['edge_miss'] for v in first]),
            'first: drift px': nanmean([v['drift_px'] for v in first]),
            'fill: kept-area dE': nanmean([v.get('keep_dE') for v in later]),
            'fill: seam (hard)': nanmean([v.get('seam') for v in later]),
            'fill: seam (feather)': nanmean([v.get('seam_feather') for v in later]),
            's/chain': nanmean([sum(v['seconds'] for v in s['views']) for s in ss]),
            '$/chain': nanmean([sum(v['price'] for v in s['views']) for s in ss]),
        })
    rows.sort(key=lambda r: (r['run'], r['fill: seam (feather)']))
    keys = list(rows[0])
    lines = ['| ' + ' | '.join(keys) + ' |', '|' + '---|' * len(keys)]
    for r in rows:
        lines.append('| ' + ' | '.join(f'{r[k]:.2f}' if isinstance(r[k], float) else str(r[k]) for k in keys) + ' |')
    return '\n'.join(lines)


def sheet(path, scene, entries, cols, clay=None):
    """entries: [(row label, run dir)], cols: [(file name, column label)]."""
    f, fs = font(20), font(16)
    W = 260 + TILE * len(cols)
    H = 40 + TILE * (len(entries) + (1 if clay else 0))
    img = Image.new('RGB', (W, H), (18, 18, 18))
    d = ImageDraw.Draw(img)
    for j, (_, label) in enumerate(cols):
        d.text((260 + j * TILE + 8, 10), label, font=fs, fill=(230, 230, 230))
    y = 40
    if clay:
        d.text((10, y + TILE // 2 - 12), 'gray input', font=f, fill=(230, 230, 230))
        for j, c in enumerate(clay):
            if c:
                img.paste(Image.open(os.path.join(common.OUT, scene, c)).resize((TILE - 4, TILE - 4)),
                          (260 + j * TILE, y))
        y += TILE
    for label, run_dir in entries:
        for k, line in enumerate(label.split('\n')):
            d.text((10, y + TILE // 2 - 12 + 24 * k), line, font=f, fill=(230, 230, 230))
        for j, (fn, _) in enumerate(cols):
            p = os.path.join(run_dir, fn)
            if os.path.exists(p):
                img.paste(Image.open(p).resize((TILE - 4, TILE - 4)), (260 + j * TILE, y))
        y += TILE
    img.save(path, quality=90)
    return path


def main():
    summaries = load()
    md = table(summaries)
    open(os.path.join(common.OUT, 'metrics.md'), 'w').write(md + '\n')
    print(md)
    base_order = [l for l in ('ideogram-4.5', 'flux3-klein', 'nano-banana-2.1', 'flux3', 'qwen-image-3',
                              'fibo2', 'gpt-image-2.5')]
    base_cols = [('v1_out.jpg', 'v1 from clay'), ('v2_out.jpg', 'v2 raw'), ('v2_comp.jpg', 'v2 pasted'),
                 ('v3_comp.jpg', 'v3 pasted'), ('v4_heldout.jpg', 'held-out v4 (pink = gap)')]
    hyb = [('Klein only', ('base', 'flux3-klein')),
           ('Klein + Fibo 2', ('hybrid', 'flux3-klein+fibo2')),
           ('Klein + Fibo 2\nquality-aware', ('hybrid-qa', 'flux3-klein+fibo2')),
           ('Klein + Nano Banana', ('hybrid', 'flux3-klein+nano-banana-2.1')),
           ('Klein + Ideogram', ('hybrid', 'flux3-klein+ideogram-4.5'))]
    hyb_cols = [('v2_out.jpg', 'v2 raw fill'), ('v2_comp.jpg', 'v2 pasted'), ('v3_comp.jpg', 'v3 pasted'),
                ('v4_heldout.jpg', 'held-out v4'), ('texture.jpg', 'texture atlas')]
    for scene in ('exterior', 'interior'):
        print(sheet(os.path.join(common.OUT, f'sheet_base_{scene}.jpg'), scene,
                    [(m, os.path.join(RUNS, 'base', scene, m)) for m in base_order], base_cols,
                    clay=[f'view_{v}_beauty.png' for v in ('v1', 'v2', 'v2', 'v3', 'v4')]))
        print(sheet(os.path.join(common.OUT, f'sheet_hybrid_{scene}.jpg'), scene,
                    [(lab, os.path.join(RUNS, t, scene, m)) for lab, (t, m) in hyb], hyb_cols))


if __name__ == '__main__':
    main()
