// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TEXT-21, NFR-04 (the inbox's map preview picture: PMTiles tile ids, and a picture that holds a pin and the credit, never a coordinate)
import { describe, expect, it } from 'vitest';
import { renderPreviewSvg, tileId } from './preview.ts';

describe('the preview picture (API-164)', () => {
  // why: FR-TEXT-21
  it('numbers tiles as PMTiles v3 does (every smaller zoom first, then the Hilbert curve)', () => {
    expect([tileId(0, 0, 0), tileId(1, 0, 0), tileId(1, 0, 1), tileId(1, 1, 1), tileId(1, 1, 0), tileId(2, 3, 0)]).toEqual([0, 1, 2, 3, 4, 20]);
  });

  // why: NFR-04
  it('draws the pin and the OpenStreetMap credit and writes no coordinate, with no map file at all', () => {
    const svg = renderPreviewSvg(null, { lon: -83.0123, lat: 39.9612 });
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('<circle');
    expect(svg).toContain('© OpenStreetMap');
    expect(svg).not.toMatch(/83\.0123|39\.9612/);
  });

  // why: FR-TEXT-21
  it('leaves the pin on plain ground when the map file cannot be read', () => {
    expect(renderPreviewSvg('/nonexistent/columbus.pmtiles', { lon: -83, lat: 39.96 })).toContain('<circle');
  });
});
