"""Patch's brand for the video: Direction 46 · Lights Down.

Video is play: black ground, white type, and the footage is the brightest thing on screen. Clips play clean in plain
rectangles; type sits beside or under them, never on them, one line at a time, with one accent: the pink patch
touching the frame's top-left corner. Moves ease in time and step in space (whole cells, at the moments an eased
curve crosses each step). Nothing fades.

The logo, Patch Pixel and the mark's geometry come from Patch's brand kit, which is not part of this repo (Patch Pixel
is Patch's own typeface, all rights reserved). Put the kit at ./brand-kit (ignored by git) or point PATCH_BRAND_KIT
at it.
"""
import os
import re
from functools import lru_cache

from PIL import ImageFont

KIT = os.environ.get('PATCH_BRAND_KIT', os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'brand-kit'))
FONTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fonts')

BLACK = (0, 0, 0)
WHITE = (255, 255, 255)
PINK = (245, 60, 209)
QUIET = (153, 153, 153)   # --play-quiet: second lines, timecodes
LINE = (51, 51, 51)       # --play-line: hairlines, never text
CELL = 8                  # one 8 px cell under everything


def _variable(path, size, weight):
    f = ImageFont.truetype(path, size)
    for name in (weight, weight.encode()):
        try:
            f.set_variation_by_name(name)
            break
        except Exception:
            continue
    return f


@lru_cache(maxsize=None)
def funnel(size, weight='Medium'):
    """Funnel Sans, for text: 400 (Regular) and 500 (Medium)."""
    return _variable(os.path.join(FONTS, 'FunnelSans.ttf'), size, weight)


@lru_cache(maxsize=None)
def mono(size, weight='Regular'):
    """Red Hat Mono, for labels and numbers: 400 (Regular) and 500 (Medium)."""
    return _variable(os.path.join(FONTS, 'RedHatMono.ttf'), size, weight)


@lru_cache(maxsize=None)
def pixel(size, bold=False):
    """Patch Pixel, for titles and the headline: multiples of 9 px only (the cell is size / 9)."""
    assert size % 9 == 0, 'Patch Pixel is set at multiples of 9 px'
    name = 'PatchPixel-Bold.ttf' if bold else 'PatchPixel-Regular.ttf'
    return ImageFont.truetype(os.path.join(KIT, '04 Type', 'Patch Pixel', name), size)


# ---------- the logo, from the kit's SVG masters (10 units a cell, whole-cell rectangles only) ----------
@lru_cache(maxsize=None)
def logo(name):
    """[(x, y, w, h, colour)] in cells for a master such as 'patch-lockup-white', plus its size in cells."""
    svg = open(os.path.join(KIT, '01 Logo', 'SVG', name + '.svg'), encoding='utf-8').read()
    w, h = (int(v) // 10 for v in re.search(r'viewBox="0 0 (\d+) (\d+)"', svg).groups())
    rects = []
    for fill, d in re.findall(r'<path fill="#([0-9A-Fa-f]{6})"[^>]* d="([^"]+)"', svg):
        col = tuple(int(fill[i:i + 2], 16) for i in (0, 2, 4))
        for x, y, rw, rh in re.findall(r'M(\d+) (\d+)h(\d+)v(\d+)h-\d+z', d):
            rects.append((int(x) // 10, int(y) // 10, int(rw) // 10, int(rh) // 10, col))
    return rects, (w, h)


def draw_rects(d, rects, x, y, c):
    for rx, ry, rw, rh, col in rects:
        d.rectangle([x + rx * c, y + ry * c, x + (rx + rw) * c - 1, y + (ry + rh) * c - 1], fill=col)


# ---------- motion: ease in time, step in space ----------
def cubic_bezier(p1x, p1y, p2x, p2y):
    def coord(t, a, b):
        return 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3

    def f(u):
        u = max(0.0, min(1.0, u))
        lo, hi = 0.0, 1.0
        for _ in range(40):
            mid = (lo + hi) / 2
            if coord(mid, p1x, p2x) < u:
                lo = mid
            else:
                hi = mid
        return coord((lo + hi) / 2, p1y, p2y)
    return f


LAY = cubic_bezier(.16, 1, .3, 1)       # arrivals
GLIDE = cubic_bezier(.65, 0, .35, 1)    # moves
LIFT = cubic_bezier(.55, 0, .75, .1)    # exits
CUT = cubic_bezier(1, 0, 0, 1)          # switches


def steps(u, n, ease):
    """How many of an n-step move have happened at progress u: step i jumps when ease crosses (i - 0.5) / n."""
    e = ease(max(0.0, min(1.0, u)))
    return min(n, max(0, int(e * n + 0.5)))


def stepped_rect(a, b, u, n=8, ease=GLIDE):
    """A rectangle moving from a to b in n whole steps, each edge on a whole cell."""
    k = steps(u, n, ease) / n
    return tuple(round((av + (bv - av) * k) / CELL) * CELL for av, bv in zip(a, b))


def logo_animation(t, beat):
    """The logo animation, on a clock whose beat is `beat` seconds (the kit times it at 77 BPM, beat 0.779 s).

    The tile is there; the patch walks to each corner in five cell steps on glide's times (half a beat a corner),
    comes home and presses one cell onto the tile for a step; then the wordmark steps in three cells on lay's times.
    Returns (patch position in cells, wordmark offset in cells or None while it hasn't arrived).
    """
    k = beat / 0.779
    walk = [(0, 0), (5, 0), (5, 5), (0, 5), (0, 0)]
    leg = 0.39 * k
    step = 0.097 * k
    if t < 4 * leg:
        i = int(t // leg)
        (ax, ay), (bx, by) = walk[i], walk[i + 1]
        s = steps((t - i * leg) / leg, 5, GLIDE) / 5
        pos = (round(ax + (bx - ax) * s), round(ay + (by - ay) * s))
    elif t < 4 * leg + step:
        pos = (1, 1)          # the press
    else:
        pos = (0, 0)
    word_at = 1.75 * k
    if t < word_at:
        return pos, None
    return pos, 3 - steps((t - word_at) / (0.39 * k), 3, LAY)
