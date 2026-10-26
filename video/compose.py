#!/usr/bin/env python3
"""Compose the demo video from scripts/capture.mjs output: 3D frames + type, the model's views and progress.

  python3 video/compose.py            -> video/out/composed/NNNNN.jpg
Then video/audio.py renders the soundtrack and video/encode.sh muxes everything.

Branding is Patch's Lights Down (video/lightsdown.py). Video is play: black ground, white type, the clip in a plain
frame with the pink patch touching its top-left corner, type beside or under the clip and never on it, one caption
line at a time. The hook plays full bleed, then the clip steps back into its frame and its label writes in.
"""
import json
import os
from concurrent.futures import ProcessPoolExecutor
from functools import lru_cache

from PIL import Image, ImageDraw

import lightsdown as ld
from lightsdown import BLACK, LINE, PINK, QUIET, WHITE

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'video', 'out')
W, H = 1920, 1080
M = 64                                   # margin: 8 cells
FULL = (0, 0, W, H)
FRAME = (M, M, M + 1408, M + 792)        # the clip once it hangs: 16:9 on whole cells (176 x 99), x0 y0 x1 y1
COL = FRAME[2] + 40                      # the label column, to W - M
COL_W = W - M - COL
CAPTION_Y = FRAME[3] + 72                # caption baseline under the frame

# name the maker, then the parents in plain words
MAKER = '@patch_gg'
TITLE = 'trompe'
PARENTS = ['village blockout +', 'flux 3 klein + fibo 2']
CATALOGUE = ['No. 01 · open source', 'github.com/Patch-gg/trompe']


def clock():
    """The soundtrack's clock in the brand's note values: s16 (a sixteenth), lay (an eighth), beat, bar."""
    beat = TIMELINE['beats']['period']
    return beat / 4, beat / 2, beat, beat * 4


def hang_at():
    """The hook plays full bleed, then hangs on the second downbeat."""
    return TIMELINE['beats']['bars'][1]


def clip_rect(t_abs, sec):
    if sec != 'hook':
        return FRAME
    _, lay, _, _ = clock()
    u = (t_abs - hang_at()) / lay
    return FULL if u <= 0 else FRAME if u >= 1 else ld.stepped_rect(FULL, FRAME, u, 8, ld.GLIDE)


@lru_cache(maxsize=64)
def thumb(path, size):
    return Image.open(path).convert('RGB').resize((size, size), Image.LANCZOS)


def caption(d, s, t, num=None):
    """One line under the frame. The words wait in grey and turn white one by one, a sixteenth apart."""
    if t < 0:
        return
    s16, *_ = clock()
    x, y = FRAME[0], CAPTION_Y
    if num:
        d.text((x, y), num, font=ld.mono(28, 'Regular'), fill=QUIET, anchor='ls')
        x += 64
    f = ld.funnel(40, 'Medium')
    words = s.split(' ')
    lit = min(len(words), int(t / s16) + 1)
    for i, word in enumerate(words):
        d.text((x, y), word, font=f, fill=WHITE if i < lit else QUIET, anchor='ls')
        x += d.textlength(word + ' ', font=f)


def wall_label(d, t, note):
    """The label beside the frame, bottom-aligned with it: maker, title, parents, a note, the catalogue line. Its
    lines write in one per sixteenth."""
    if t < 0:
        return
    s16, *_ = clock()
    lines = ([('mono', MAKER, 24, 'Medium', WHITE, 38), ('title', TITLE, 45, None, WHITE, 62)]
             + [('mono', p, 22, 'Regular', WHITE, 31) for p in PARENTS]
             + [('gap', '', 0, None, None, 16)]
             + [('mono', n, 22, 'Regular', QUIET, 31) for n in note]
             + [('gap', '', 0, None, None, 16)]
             + [('mono', c, 18, 'Regular', QUIET, 26) for c in CATALOGUE])
    y = FRAME[3] - 6 - sum(lh for *_, lh in lines[1:])
    shown = int(t / s16) + 1
    i = 0
    for kind, s, size, weight, fill, lh in lines:
        if kind != 'gap':
            if i >= shown:
                return
            i += 1
            if kind == 'title':
                d.text((COL, y), s, font=ld.pixel(size), fill=fill, anchor='ls')   # Patch Pixel, 5 px cells
            else:
                d.text((COL, y), s, font=ld.mono(size, weight), fill=fill, anchor='ls')
        y += lh


def progress(d, x, y, share):
    """20 cells: filled in ink, the head (the cell being painted now) in pink, the rest in line grey."""
    n, size, gap = 20, 12, 3
    filled = min(n, int(share * n))
    for i in range(n):
        col = WHITE if i < filled else PINK if i == filled and share < 1 else LINE
        d.rectangle([x + i * (size + gap), y, x + i * (size + gap) + size - 1, y + size - 1], fill=col)


def paint_column(img, d, p, data, t_in):
    """What the model sees and what it paints, two plain frames, then the progress and its numbers."""
    run = os.path.join(ROOT, 'runs', TIMELINE['run'])
    views, cost = paint_progress(data, p)
    size = 300
    for k, (name, label) in enumerate((('state', 'model sees'), ('gen', 'model paints'))):
        y = FRAME[1] + 32 + k * 348
        d.text((COL, y - 12), label, font=ld.mono(20), fill=QUIET, anchor='ls')
        img.paste(thumb(os.path.join(run, f"view_{p['pip']}_{name}.jpg"), size), (COL, y))
    progress(d, COL, FRAME[3] - 140, views / data['views'])
    d.text((COL, FRAME[3] - 84), f"{views}/{data['views']} views · ${cost:.2f}", font=ld.mono(22, 'Medium'),
           fill=WHITE, anchor='ls')
    d.text((COL, FRAME[3] - 54), fmt_time(p['elapsed']) + ' on fal', font=ld.mono(20), fill=QUIET, anchor='ls')


def smooth(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def end_card(d, t, data):
    """A headline for trompe, then the logo animation, patch.gg and the credit line. It holds to the end."""
    s16, lay, beat, bar = clock()
    card = 5 * beat
    if t < card:
        lines = [('pixel', 'trompe.', 108), ('funnel', 'texture a whole game level from a gray blockout.', 44),
                 ('mono', 'open source · github.com/Patch-gg/trompe', 26)]
        x, ys = 192, (470, 548, 612)
        for i, ((kind, s, size), y) in enumerate(zip(lines, ys)):
            if t < i * s16:
                break
            if kind == 'pixel':
                d.text((x, y), s[:-1], font=ld.pixel(size), fill=WHITE, anchor='ls')
                w = d.textlength(s[:-1], font=ld.pixel(size))
                d.text((x + w, y), '.', font=ld.pixel(size), fill=WHITE, anchor='ls')
            elif kind == 'funnel':
                d.text((x, y), s, font=ld.funnel(size, 'Medium'), fill=QUIET, anchor='ls')
            else:
                d.text((x, y), s, font=ld.mono(size), fill=WHITE, anchor='ls')
        return
    t -= card
    c = 16
    rects, (lw, lh) = ld.logo('patch-lockup-white')
    x0, y0 = (W - lw * c) // 2, 392
    patch_pos, word = ld.logo_animation(t, beat)
    tile = [r for r in rects if r[4] == WHITE and r[0] < 7]
    wordmark = [r for r in rects if r[0] >= 10]
    ld.draw_rects(d, tile, x0, y0, c)
    px, py = patch_pos
    d.rectangle([x0 + px * c, y0 + py * c, x0 + (px + 3) * c - 1, y0 + (py + 3) * c - 1], fill=PINK)
    if word is None:
        return
    ld.draw_rects(d, [(rx + word, ry, rw, rh, col) for rx, ry, rw, rh, col in wordmark], x0, y0, c)
    if word > 0:
        return
    f = ld.pixel(36)
    w1, w2 = d.textlength('patch', font=f), d.textlength('.gg', font=f)
    ax = (W - w1 - w2) // 2
    d.text((ax, y0 + lh * c + 92), 'patch', font=f, fill=WHITE, anchor='ls')
    d.text((ax + w1, y0 + lh * c + 92), '.gg', font=f, fill=QUIET, anchor='ls')
    credit = f"{TITLE} · {' '.join(PARENTS)} · made by {MAKER}"
    d.text((W // 2, H - M), credit, font=ld.mono(18), fill=QUIET, anchor='ms')


def fmt_time(s):
    return f'{int(s // 60)}:{int(s % 60):02d}'


def compose(i):
    tl = TIMELINE
    f = tl['frames'][i]
    data = tl['data']
    sec = f['section']
    t_abs = f['time']
    t_in = t_abs - f['sectionStart']
    img = Image.new('RGB', (W, H), BLACK)
    d = ImageDraw.Draw(img)
    if sec == 'end':
        end_card(d, t_in, data)
    else:
        rect = clip_rect(t_abs, sec)
        clip = Image.open(os.path.join(OUT, 'frames', f['frame'])).convert('RGB')
        if rect != FULL:
            clip = clip.resize((rect[2] - rect[0], rect[3] - rect[1]), Image.LANCZOS)
        img.paste(clip, rect[:2])
        if rect == FRAME:
            _, lay, _, _ = clock()
            d.rectangle([FRAME[0] - 24, FRAME[1] - 24, FRAME[0] - 1, FRAME[1] - 1], fill=PINK)   # the patch
            landed = hang_at() + lay
            note = ['128 views on fal · $4.44', '26 min, one view at a time']
            if sec == 'hook':
                caption(d, 'gray blockout to textured level, in minutes.', t_abs - landed)   # Funnel Sans has no →
                wall_label(d, t_abs - landed, note)
            elif sec == 'montage':
                caption(d, 'every surface painted by image models.', t_in)
                wall_label(d, 99, note)
            elif sec in ('plan', 'paint', 'result'):
                num, s_ = f['caption']
                caption(d, s_[:1].lower() + s_[1:] + '.', t_in, num)
                if sec == 'plan':
                    # counts climb with the markers the capture draws (same curves as scripts/capture.mjs)
                    spots = int(data['points'] * smooth(f['t'] / 0.35))
                    cams = int(data['views'] * smooth((f['t'] - 0.3) / 0.5))
                    wall_label(d, 99, [f'{spots} spots · {cams} cameras', 'where a player can stand'])
                elif sec == 'paint' and f.get('paint'):
                    paint_column(img, d, f['paint'], data, t_in)
                elif sec == 'result':
                    wall_label(d, t_in, [f"{data['views']} views on fal · ${data['cost']:.2f}",
                                         f"{round(data['seconds'] / 60)} min, one view at a time"])
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
