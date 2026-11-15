// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapStyle } from './map-model.ts';
import { MAP_ASSETS_DIR, mapAsset } from './map-assets.ts';

/** Every font name a symbol layer's text-font expression can pick (literal strings in the expression). */
function fontNames(value: unknown): string[] {
  if (typeof value === 'string') return /^Noto Sans/.test(value) ? [value] : [];
  return Array.isArray(value) ? value.flatMap(fontNames) : [];
}

describe('the bundled map glyphs and sprites (F-452)', () => {
  const layers = mapStyle('http://x', 'columbus.pmtiles').layers as { type: string; layout?: Record<string, unknown> }[];

  // why: FR-MAP-1 every font stack the kept symbol layers name has glyph files in the bundled set, starting with the range 0-255
  it('has the glyph range 0-255 for every font stack a symbol layer names', () => {
    const stacks = new Set(layers.filter((l) => l.type === 'symbol').flatMap((l) => fontNames(l.layout?.['text-font'])));
    expect([...stacks].sort()).toEqual(['Noto Sans Italic', 'Noto Sans Medium', 'Noto Sans Regular']);
    for (const s of stacks) expect(mapAsset(`/map-assets/fonts/${encodeURIComponent(s)}/0-255.pbf`), s).not.toBeNull();
  });

  // why: FR-MAP-1 every sprite name a symbol layer's icon-image can pick is in the bundled sheet, at both pixel densities
  it('has the sprite sheet at 1x and 2x with the icons the symbol layers name', () => {
    for (const f of ['light.json', 'light.png', 'light@2x.json', 'light@2x.png']) expect(mapAsset(`/map-assets/sprites/${encodeURIComponent(f)}`), f).not.toBeNull();
    const sheet = JSON.parse(readFileSync(path.join(MAP_ASSETS_DIR, 'sprites/light.json'), 'utf8')) as Record<string, unknown>;
    for (const name of ['arrow', 'capital', 'townspot', 'train_station', 'generic_shield-1char', 'generic_shield-5char', 'US:I-3char']) expect(sheet, name).toHaveProperty(name);
  });

  // why: SD-39 the OFL-1.1 text ships beside the glyph files, and the sprite sheet's MIT notice beside the sprites
  it('keeps the OFL-1.1 text beside the glyph files and the MIT notice beside the sprites', () => {
    expect(readFileSync(path.join(MAP_ASSETS_DIR, 'fonts/OFL-1.1.txt'), 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(readFileSync(path.join(MAP_ASSETS_DIR, 'sprites/LICENSE-tangrams-icons-MIT.txt'), 'utf8')).toContain('The MIT License');
    expect(existsSync(path.join(MAP_ASSETS_DIR, 'fonts/Noto Sans Regular'))).toBe(true);
  });

  // why: NFR-12 a path cannot leave the bundled folder, and only the 3 file kinds of the set are answered
  it('refuses a path outside the set', () => {
    for (const bad of ['/map-assets/', '/map-assets/../server.ts', '/map-assets/fonts/%2e%2e/%2e%2e/server.ts', '/map-assets/fonts/Noto%20Sans%20Regular/9999-10000.pbf', '/map-assets/fonts', '/map-assets/fonts/%00', '/other/x.pbf', '/map-assets/fonts/OFL-1.1.sh']) {
      expect(mapAsset(bad), bad).toBeNull();
    }
    expect(mapAsset('/map-assets/fonts/Noto%20Sans%20Regular/0-255.pbf')?.type).toBe('application/x-protobuf');
  });
});
