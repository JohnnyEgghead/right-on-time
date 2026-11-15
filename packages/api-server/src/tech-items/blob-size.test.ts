// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1276: imageSize walks the JPEG marker grammar the way the decoder does, so the size stored with a photo is the frame header's.
import { describe, expect, it } from 'vitest';
import { imageSize } from './blob.ts';

const SOI = [0xff, 0xd8];
const app0 = [0xff, 0xe0, 0x00, 0x04, 0x41, 0x42];
/** A baseline frame header (SOF0) for width x height, 3 components. */
const sof = (w: number, h: number) => [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0];
const size = (...parts: number[][]) => imageSize(new Uint8Array(parts.flat()), 'image/jpeg');

describe('imageSize of a JPEG', () => {
  // why: F-1276 the plain case still answers the first frame header
  it('reads the size of a frame after an APP0 segment', () => {
    expect(size(SOI, app0, sof(8000, 6000))).toEqual({ width: 8000, height: 6000 });
  });

  // why: F-1276 TEM (FF 01) carries no length; reading one after it landed the walk inside a later segment and gave a false size
  it('steps over TEM, which has no length', () => {
    expect(size(SOI, [0xff, 0x01], app0, sof(8000, 6000))).toEqual({ width: 8000, height: 6000 });
  });

  // why: F-1276 RST0 to RST7 (FF D0 to FF D7) carry no length either, and the decoder accepts them before the frame header
  it('steps over each of RST0 to RST7, which have no length', () => {
    for (let m = 0xd0; m <= 0xd7; m++) expect(size(SOI, [0xff, m], app0, sof(8000, 6000)), m.toString(16)).toEqual({ width: 8000, height: 6000 });
  });

  // why: F-1276 a long APP15 segment after TEM is skipped by its own length: the old walk read FF EF as a length of 0xFFEF and left the file
  it('reaches the real frame header after TEM and a long APP15 segment', () => {
    const seg = [0xff, 0xef, 0xff, 0xff, ...new Array(0xfffd).fill(0)];
    expect(size(SOI, [0xff, 0x01], seg, sof(8000, 8000))).toEqual({ width: 8000, height: 8000 });
  });

  // why: F-1276 a file with no frame header and no marker we know still answers null, never a size
  it('answers null for bytes that are not a JPEG', () => {
    expect(imageSize(new Uint8Array([1, 2, 3, 4, 5]), 'image/jpeg')).toBeNull();
    expect(size(SOI, [0xff, 0x01, 0x00, 0x00])).toBeNull();
  });
});
