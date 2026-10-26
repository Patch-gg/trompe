#!/usr/bin/env python3
"""The README's header and footer in Patch's brand (Lights Down), in Day and Evening for GitHub's light and dark modes.

  PATCH_BRAND_KIT=<kit folder> python3 docs/readme/make_art.py

A README is somewhere people read, so it is the world: black ink by day, white ink in the evening, the patch pink in
both. Drawn at 2x for sharp screens, on a transparent ground so it sits on GitHub's own page colour. Needs Patch's
brand kit (Patch Pixel and the logo masters); see video/lightsdown.py.
"""
import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'video'))
import lightsdown as ld  # noqa: E402

STYLES = {'day': ((0, 0, 0), (102, 102, 102)), 'evening': ((255, 255, 255), (153, 153, 153))}


def logo_rects(name, ink):
    """A logo master's cells, with its ink swapped for this style's (the patch stays pink)."""
    rects, size = ld.logo(name)
    quiet = STYLES['day'][1] if ink == (0, 0, 0) else STYLES['evening'][1]
    out = []
    for x, y, w, h, col in rects:
        if col == ld.PINK:
            out.append((x, y, w, h, col))
        elif col in ((153, 153, 153), (102, 102, 102)):
            out.append((x, y, w, h, quiet))
        else:
            out.append((x, y, w, h, ink))
    return out, size


def header(style):
    ink, quiet = STYLES[style]
    img = Image.new('RGBA', (1600, 400), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rects, _ = logo_rects('patch-lockup-white', ink)
    ld.draw_rects(d, rects, 0, 0, 6)                                  # 3 px cells on screen
    d.text((0, 254), 'trompe.', font=ld.pixel(144), fill=ink, anchor='ls')          # 8 px cells: the headline size
    d.text((0, 352), 'Texture a whole game level from a gray blockout.', font=ld.funnel(52, 'Medium'),
           fill=quiet, anchor='ls')
    img.save(os.path.join(HERE, f'header-{style}.png'), optimize=True)


def footer(style):
    ink, quiet = STYLES[style]
    img = Image.new('RGBA', (1000, 72), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rects, _ = logo_rects('patch-address-white', ink)
    ld.draw_rects(d, rects, 0, 0, 8)                                  # 4 px cells on screen
    d.text((460, 44), 'Mashups, mods and browser games.', font=ld.funnel(30, 'Regular'), fill=quiet, anchor='ls')   # patch.gg's line
    img.save(os.path.join(HERE, f'footer-{style}.png'), optimize=True)


if __name__ == '__main__':
    for s in STYLES:
        header(s)
        footer(s)
    print('wrote', sorted(f for f in os.listdir(HERE) if f.endswith('.png')))
