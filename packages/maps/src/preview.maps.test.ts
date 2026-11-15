// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TEXT-21 (the inbox's map preview drawn from the real Columbus map file: roads around the destination)
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAPS_DIR } from './manifest.ts';
import { renderPreviewSvg } from './preview.ts';

describe('the preview picture over the real map file', () => {
  // why: FR-TEXT-21
  it('draws roads around a Columbus destination, in a picture small enough for a card', () => {
    const svg = renderPreviewSvg(path.join(process.env.MAPS_DIR ?? MAPS_DIR, 'columbus.pmtiles'), { lon: -83.0, lat: 39.96 });
    expect(svg).toMatch(/<path d="M-?\d+ -?\d+L/);
    expect(svg.length).toBeLessThan(200_000);
  });
});
