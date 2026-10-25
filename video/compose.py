#!/usr/bin/env python3
"""Compose the demo video from scripts/capture.mjs output: 3D frames + type, picture-in-picture and counters.

  python3 video/compose.py            -> video/out/composed/NNNNN.jpg
Then video/audio.py renders the soundtrack and video/encode.sh muxes everything.

Branding is Patch's Seed Pixel direction (video/seedpixel.py): black, white and one pink; Patch Pixel for titles,
Chivo Mono for everything read, Chivo caps for the credit line that rides every frame. Text sits on black bars, never
on gradients, and nothing fades: things switch on a step of the soundtrack's clock.
"""
import json
import os
from concurrent.futures import ProcessPoolExecutor
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont

import seedpixel as sp
from seedpixel import BLACK, PINK, WHITE

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'video', 'out')
FONTS = os.path.join(ROOT, 'video', 'fonts')
W, H = 1920, 1080
MARGIN = 64

# credit before hype: what the village was made from, and by whom
PARENTS = ['village blockout', 'flux 3 klein', 'fibo 2']
TITLE = 'trompe'
SEED = sp.seed_of(PARENTS, TITLE)
CREDIT = ' + '.join(PARENTS) + ' · made by patch'


def _font(file, size, weight):
    f = ImageFont.truetype(os.path.join(FONTS, file), size)
    for name in (weight, weight.encode()):
        try:
            f.set_variation_by_name(name)
            break
        except Exception:
            continue
    return f


@lru_cache(maxsize=None)
def mono(size, weight='Regular'):
    """Chivo Mono: Light (300) for timestamps and asides, Regular (400) for text, Medium (500) for what matters."""
    return _font('ChivoMono.ttf', size, weight)


@lru_cache(maxsize=None)
def chivo(size, weight='Medium'):
    """Chivo caps, for the credit line only."""
    return _font('Chivo.ttf', size, weight)


def clock():
    """The soundtrack's clock, in the brand's units: a row is a sixteenth, a beat, a bar."""
    beat = TIMELINE['beats']['period']
    return beat / 4, beat, beat * 4


@lru_cache(maxsize=256)
def thumb(path, size):
    return Image.open(path).convert('RGB').resize((size, size), Image.LANCZOS)


def caps(d, x, y, s, size, fill=WHITE, upper=True, track=0.08):
    """Chivo caps on the baseline at (x, y) with +8% tracking. Returns the width drawn."""
    f = chivo(size)
    s = s.upper() if upper else s
    x0 = x
    for ch in s:
        d.text((x, y), ch, font=f, fill=fill, anchor='ls')
        x += d.textlength(ch, font=f) + track * size
    return x - x0 - track * size


def caps_width(d, s, size, upper=True, track=0.08):
    f = chivo(size)
    s = s.upper() if upper else s
    return sum(d.textlength(ch, font=f) for ch in s) + track * size * (len(s) - 1)


def credit_line(d, left=(TITLE + ' · village-07', CREDIT)):
    """The credit line at the foot of every frame: what it is and its parents on the left, the seed on the right."""
    size, lead = 19, 27
    y2 = H - 34
    for i, s in enumerate(left):
        y = y2 - lead * (1 - i)
        w = caps_width(d, s, size)
        d.rectangle([MARGIN - 8, y - 18, MARGIN + w + 8, y + 6], fill=BLACK)
        caps(d, MARGIN, y, s, size)
    hexs = sp.seed_hex(SEED)
    w1, w2 = caps_width(d, 'seed', size), caps_width(d, hexs, size, upper=False)
    x = W - MARGIN
    d.rectangle([x - w1 - 8, y2 - lead - 18, x + 8, y2 - lead + 6], fill=BLACK)
    caps(d, x - w1, y2 - lead, 'seed', size)
    d.rectangle([x - w2 - 8, y2 - 18, x + 8, y2 + 6], fill=BLACK)
    caps(d, x - w2, y2, hexs, size, fill=PINK, upper=False)


def typed(d, x, y, parts, t, size, cursor_beats=2):
    """A line typed on word by word on the row grid, on a black bar. The newest word is hot (pink, black type) for
    one row; a pink block cursor follows the text and blinks for two beats after the last word.

    parts: [(text, weight)] runs; only the last run is typed word by word, earlier runs appear at once.
    """
    row, beat, _ = clock()
    if t < 0:
        return
    *lead, (body, weight) = parts
    words = body.split(' ')
    k = min(len(words), int(t / row) + 1)
    runs = [(s, w) for s, w in lead] + [(' '.join(words[:k]), weight)]
    asc, desc = mono(size, weight).getmetrics()
    padx, pady = round(0.25 * size), round(0.08 * size)
    widths = [d.textlength(s, font=mono(size, w)) for s, w in runs]
    total = sum(widths)
    done_at = (len(words) - 1) * row
    blink = t - done_at
    cursor = k < len(words) or (blink < cursor_beats * beat and int(blink / (beat / 2)) % 2 == 0)
    cw = round(0.6 * size)
    right = x + total + (round(0.15 * size) + cw if cursor else 0)
    d.rectangle([x - padx, y - asc - pady, right + padx, y + desc + pady], fill=BLACK)
    cx = x
    for (s, w), wd in zip(runs, widths):
        d.text((cx, y), s, font=mono(size, w), fill=WHITE, anchor='ls')
        cx += wd
    if blink < row:   # the newest word is alive for one row
        hot = words[k - 1]
        hw = d.textlength(hot, font=mono(size, weight))
        hx = x + total - hw
        d.rectangle([hx - padx, y - asc - pady, hx + hw + padx, y + desc + pady], fill=PINK)
        d.text((hx, y), hot, font=mono(size, weight), fill=BLACK, anchor='ls')
    if cursor:
        gap = round(0.15 * size)
        d.rectangle([x + total + gap, y - round(0.72 * size), x + total + gap + cw, y + round(0.08 * size)], fill=PINK)


def caption(d, num, s, t):
    parts = ([(num + '  ', 'Light')] if num else []) + [(s[:1].lower() + s[1:], 'Medium')]
    typed(d, MARGIN, H - 132, parts, t, 40)


def hook_line(d, t):
    typed(d, MARGIN, H - 140, [('gray blockout -> textured level, in minutes', 'Medium')], t, 52)   # Chivo Mono has no →


def title_mark(d):
    """Top left on footage: the title in Patch Pixel, its full stop the seed."""
    d.rectangle([MARGIN - 12, MARGIN - 12, MARGIN + sp.layout(TITLE + '.')[1] * 4 + 12, MARGIN + 36 + 12], fill=BLACK)
    sp.pixel_text(d, TITLE + '.', MARGIN, MARGIN, 4)


def log_line(d, tag, items):
    """A release-log line under the title mark: the tag in 500, values in 500, what they count in 300."""
    size, y = 27, MARGIN + 104
    runs = [('[' + tag + ']', 'Medium')]
    for i, (value, label) in enumerate(items):
        runs += [(' · ' if i else ' ', 'Light'), (value, 'Medium')] + ([(' ' + label, 'Light')] if label else [])
    asc, desc = mono(size).getmetrics()
    w = sum(d.textlength(s, font=mono(size, wt)) for s, wt in runs)
    d.rectangle([MARGIN - 7, y - asc - 2, MARGIN + w + 7, y + desc + 2], fill=BLACK)
    x = MARGIN
    for s, wt in runs:
        d.text((x, y), s, font=mono(size, wt), fill=WHITE, anchor='ls')
        x += d.textlength(s, font=mono(size, wt))


def chip(d, label, state):
    """State chip, top left: dotted while waiting, pink while alive, white once settled."""
    size = 22
    w = caps_width(d, label, size)
    x0, y0, x1, y1 = MARGIN - 14, MARGIN - 8, MARGIN + w + 14, MARGIN + 34
    if state == 'waiting':
        d.rectangle([x0, y0, x1, y1], fill=BLACK)
        sp.dotted_rect(d, x0, y0, x1, y1)
        caps(d, MARGIN, MARGIN + 21, label, size)
    else:
        d.rectangle([x0, y0, x1, y1], fill=PINK if state == 'alive' else WHITE)
        caps(d, MARGIN, MARGIN + 21, label, size, fill=BLACK)


def smooth(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def end_card(t, data):
    """Black. The title swarms out of its seed and settles; one pink flood on the downbeat; the log types on; the
    Patch lockup grows trompe's ring; patch.gg and the credit line at the foot."""
    row, beat, bar = clock()
    flood = bar <= t < bar + beat
    bg, ink = (PINK, BLACK) if flood else (BLACK, WHITE)
    img = Image.new('RGB', (W, H), bg)
    d = ImageDraw.Draw(img)
    cell = 14
    title = TITLE + '.'
    cells, tw = sp.layout(title, bold=True)
    x0, y0 = (W - tw * cell) // 2, 300
    dot = [(cx, cy) for cx, cy, gi in cells if gi == len(title) - 1]
    body = [(cx, cy) for cx, cy, gi in cells if gi != len(title) - 1]
    sx, sy = dot[0]
    sp.fill_cells(d, dot, cell, x0, y0, BLACK if flood else PINK)          # the seed lands first, and stays
    for x, y, landed in sp.swarm(body, (sx, sy), t - 0.1, flight=0.9, spread=0.8, seed=SEED):
        col = ink if landed else PINK
        X, Y = round(x0 + x * cell), round(y0 + y * cell)
        d.rectangle([X, Y, X + cell - 1, Y + cell - 1], fill=col)
    if flood:
        return img
    after = t - (bar + beat)
    if after < 0:
        return img
    lines = [('plan · paint · project · bake', 'Light', 38), ('open source soon · image models via fal', 'Regular', 30)]
    for i, (s, wt, size) in enumerate(lines):
        start = i * beat
        if after < start:
            continue
        w = d.textlength(s, font=mono(size, wt))
        typed(d, (W - w) / 2, 498 + 64 * i, [(s, wt)], after - start, size, cursor_beats=1 if i == 0 else 2)
    if after >= 2 * beat:
        c = 8
        lx = (W - 38 * c) // 2
        groups = len(sp.ring_groups(sp.ring_mask(SEED)))
        grow = after - 2 * beat - beat
        shown = 0 if grow < 0 else min(groups, int(grow / row) + 1)
        newest = shown - 1 if 0 <= grow < groups * row else None
        caps_w = caps_width(d, 'made by', 17)
        caps(d, (W - caps_w) / 2, 702, 'made by', 17)
        sp.lockup(d, lx, 730, c, mask=sp.ring_mask(SEED), groups_shown=shown, newest=newest)
        gg_cells, gw = sp.layout('patch.gg')
        gx = (W - gw * 5) // 2
        sp.fill_cells(d, [(cx, cy) for cx, cy, gi in gg_cells if gi != 5], 5, gx, 826, WHITE)
        sp.fill_cells(d, [(cx, cy) for cx, cy, gi in gg_cells if gi == 5], 5, gx, 826, PINK)   # its full stop: the seed
    credit_line(d, (TITLE + ' · open source soon', CREDIT))
    return img


def fmt_time(s):
    return f'{int(s // 60)}:{int(s % 60):02d}'


def compose(i):
    tl = TIMELINE
    f = tl['frames'][i]
    data = tl['data']
    sec = f['section']
    t_abs = f['time']
    start, end = f['sectionStart'], f['sectionEnd']
    t_in = t_abs - start
    if sec == 'end':
        img = end_card(t_in, data)
    else:
        img = Image.open(os.path.join(OUT, 'frames', f['frame'])).convert('RGB')
        d = ImageDraw.Draw(img)
        if sec == 'hook':
            sweep = TIMELINE['beats']['bars'][0]
            sweep_end = sweep + 3.4 * TIMELINE['beats']['period']
            if t_abs < sweep:
                chip(d, 'blockout', 'waiting')
            else:
                chip(d, 'ai textured', 'alive' if t_abs < sweep_end else 'settled')
                hook_line(d, t_abs - sweep - 0.35)
        else:
            title_mark(d)
        if sec == 'montage':
            caption(d, '', 'Every surface painted by image models', t_in)
        if f.get('caption'):
            num, s_ = f['caption']
            caption(d, num, s_, t_in)
        if sec == 'plan':
            # counts climb in step with the markers the capture draws (same curves as scripts/capture.mjs)
            spots = int(data['points'] * smooth(f['t'] / 0.35))
            cams = int(data['views'] * smooth((f['t'] - 0.3) / 0.5))
            log_line(d, 'plan', [(str(spots), 'spots'), (str(cams), 'cameras')])
        if sec == 'paint' and f.get('paint'):
            p = f['paint']
            views, cost = paint_progress(data, p)
            log_line(d, 'paint', [(f"{views}/{data['views']}", 'views'), (f'${cost:.2f}', ''), (fmt_time(p['elapsed']), '')])
            pip(img, d, p, t_in)
        if sec == 'result' and f.get('shot') == 1:
            log_line(d, 'bake', [(str(data['views']), 'views'), (f"${data['cost']:.2f}", ''), (fmt_time(data['seconds']), '')])
        credit_line(d)
    img.save(os.path.join(OUT, 'composed', f'{i:05d}.jpg'), quality=94)
    return i


def paint_progress(data, p):
    """Views and cost painted so far, counting a slot's views as its reveal passes them (same rounding for both)."""
    a, b = p['slotWaves']
    waves = data['waves']
    before = sum(len(w['views']) for w in waves[:a])
    cost = sum(w['cost'] for w in waves[:a])
    slot_views = sum(len(w['views']) for w in waves[a:b])
    slot_cost = sum(w['cost'] for w in waves[a:b])
    if slot_views == 0:
        return before, cost
    counted = slot_views if p['reveal'] >= 1 else min(slot_views, int(p['reveal'] * slot_views + 0.999))
    return before + counted, cost + slot_cost * counted / slot_views


def pip(img, d, p, t_in):
    """What the model sees and what it paints: clean footage in dotted frames on black, the live one edged pink."""
    if t_in < 0.2:
        return
    size, gap = 300, 24
    x1 = W - MARGIN - size
    x0 = x1 - gap - size
    y = MARGIN + 36
    run = os.path.join(ROOT, 'runs', TIMELINE['run'])
    d.rectangle([x0 - 16, y - 52, x1 + size + 16, y + size + 16], fill=BLACK)
    for x, name in ((x0, 'state'), (x1, 'gen')):
        img.paste(thumb(os.path.join(run, f"view_{p['pip']}_{name}.jpg"), size), (x, y))
    sp.dotted_rect(d, x0 - 6, y - 6, x0 + size + 5, y + size + 5)
    d.rectangle([x1 - 6, y - 6, x1 + size + 5, y + size + 5], outline=PINK, width=3)
    caps(d, x0 - 6, y - 18, 'model sees', 18)
    caps(d, x1 - 6, y - 18, 'model paints', 18)


def init(timeline):
    global TIMELINE
    TIMELINE = timeline


def main():
    timeline = json.load(open(os.path.join(OUT, 'timeline.json')))
    os.makedirs(os.path.join(OUT, 'composed'), exist_ok=True)
    n = len(timeline['frames'])
    with ProcessPoolExecutor(max_workers=24, initializer=init, initargs=(timeline,)) as ex:
        for k, _ in enumerate(ex.map(compose, range(n), chunksize=8)):
            if k % 200 == 0:
                print(f'composed {k}/{n}', flush=True)
    print('done', n)


TIMELINE = None
if __name__ == '__main__':
    main()
