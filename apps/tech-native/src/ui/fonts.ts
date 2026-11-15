// SPDX-License-Identifier: AGPL-3.0-or-later
// The native app's Inter faces (assets/fonts, made by scripts/make-fonts.py from the kit's variable Inter). A style names a face by
// its PostScript name and sets no fontWeight, so iOS draws that exact face and never synthesizes bold.
export const FONT_WEIGHTS = [400, 500, 550, 600, 650, 680, 700, 720, 740, 750, 760, 770, 780] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];

/** The fontFamily of the Inter face at a CSS weight (the PostScript name the font file carries). */
export const inter = (w: FontWeight): string => `Inter-W${w}`;

/** The font files, for app.json's expo-font plugin (embedded at build time). */
export const FONT_FILES: readonly string[] = FONT_WEIGHTS.map((w) => `./assets/fonts/Inter-W${w}.ttf`);
