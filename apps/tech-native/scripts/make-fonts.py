#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# The native app's Inter faces (P6-NATIVE-SHELL): static instances of the kit's own variable Inter (mockups/src/fonts/
# Inter-latin-wght.woff2, the file the frames and the web app render with), 1 per CSS weight the native screens use, so a native
# 650 or 750 is the same outlines and advances as the frame's (React Native's fontWeight takes only multiples of 100).
# Each face keeps "Inter" as its typographic family (name ID 16) and is reached by its PostScript name, Inter-W<weight>.
#   python3 apps/tech-native/scripts/make-fonts.py        (fontTools 4.x; writes apps/tech-native/assets/fonts/Inter-W<weight>.ttf)
# A new weight is added to WEIGHTS and to apps/tech-native/src/ui/fonts.ts; the font test checks the 2 lists agree.
import os
import sys

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

WEIGHTS = [400, 500, 550, 600, 650, 680, 700, 720, 740, 750, 760, 770, 780]
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SOURCE = os.path.join(ROOT, 'mockups', 'src', 'fonts', 'Inter-latin-wght.woff2')
OUT = os.path.join(ROOT, 'apps', 'tech-native', 'assets', 'fonts')


def face(weight: int) -> TTFont:
    # F-1076: reproducible bytes. recalcTimestamp=False keeps the source's head.modified (else the save stamps the run's time, so two
    # runs, or two lanes, write different bytes for the same face and merge as a binary add/add conflict).
    f = instancer.instantiateVariableFont(TTFont(SOURCE, recalcTimestamp=False), {'wght': weight}, updateFontNames=False)
    f.flavor = None  # a plain TrueType file: iOS registers .ttf from the bundle (UIAppFonts)
    name = f['name']
    for nid in (16, 17, 21, 22, 25):
        name.removeNames(nameID=nid)
    style = f'W{weight}'
    for nid, value in ((1, f'Inter {style}'), (2, 'Regular'), (3, f'Inter-{style};kit'), (4, f'Inter {style}'), (6, f'Inter-{style}'),
                       (16, 'Inter'), (17, style)):
        name.setName(value, nid, 3, 1, 0x409)
    f['OS/2'].usWeightClass = weight
    f['OS/2'].fsSelection = (f['OS/2'].fsSelection & ~0b1100001) | 0b1000000  # REGULAR bit only: no bold or italic synthesis
    f['head'].macStyle = 0
    if 'STAT' in f:
        del f['STAT']
    return f


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    for w in WEIGHTS:
        path = os.path.join(OUT, f'Inter-W{w}.ttf')
        face(w).save(path)
        print(f'make-fonts: {os.path.relpath(path, ROOT)} ({os.path.getsize(path)} bytes)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
