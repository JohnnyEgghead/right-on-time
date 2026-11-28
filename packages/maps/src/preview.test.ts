// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TEXT-21, NFR-04 (the inbox's map preview picture: PMTiles tile ids, and a picture that holds a pin and the credit, never a coordinate)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEADER_BYTES } from './pmtiles.ts';
import { renderPreviewSvg, tileId, varint } from './preview.ts';

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

  // why: FR-TEXT-21 K-06 a varint cut mid-way read undefined past the buffer's end and never ended (the loop and its catch could not run); it throws within the test's timeout
  it('throws a bounded error for a varint cut mid-way or longer than 10 bytes, and still reads a whole one', () => {
    expect(() => varint(Buffer.from([0x80, 0x80]), { i: 0 })).toThrow(/past the end/);
    expect(() => varint(Buffer.from([]), { i: 0 })).toThrow(/past the end/);
    expect(() => varint(Buffer.alloc(40, 0x80), { i: 0 })).toThrow(/longer than 10 bytes/);
    const at = { i: 0 };
    expect(varint(Buffer.from([0xac, 0x02, 0x05]), at)).toBe(300);
    expect(at.i).toBe(2);
  });

  // why: FR-TEXT-21 K-06 a tile file whose root directory ends mid-varint left the reader looping; the picture now returns with the pin on plain ground
  it('draws the pin on plain ground from a map file whose directory is cut mid-varint', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bw-preview-'));
    try {
      const root = Buffer.from([0x05, 0x80]); // 5 entries, then an id delta that never ends
      const head = Buffer.alloc(HEADER_BYTES);
      head.writeBigUInt64LE(BigInt(HEADER_BYTES), 8);
      head.writeBigUInt64LE(BigInt(root.length), 16);
      head.writeUInt8(1, 97); // internal compression: none
      head.writeUInt8(1, 98);
      const file = path.join(dir, 'cut.pmtiles');
      writeFileSync(file, Buffer.concat([head, root]));
      const svg = renderPreviewSvg(file, { lon: -83, lat: 39.96 });
      expect(svg).toContain('<circle');
      expect(svg).not.toContain('<path');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
