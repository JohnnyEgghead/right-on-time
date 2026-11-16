// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1717 (the original of a photo the phone could not convert was sent as the file held it, with the place it was taken)
import { describe, expect, it } from 'vitest';
import { compressPhoto, type Encoder } from './photo.ts';
import { stripLocation, UNREADABLE_PHOTO } from './location-strip.ts';

const bytes = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
/** A JPEG segment: marker, 2-byte length, payload. */
const seg = (marker: number, payload: number[]): number[] => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const GPS = bytes('GPS 39.9612N 82.9988W');
const exif = seg(0xe1, [...bytes('Exif\0\0'), ...GPS]);
const xmp = seg(0xe1, [...bytes('http://ns.adobe.com/xap/1.0/\0'), ...bytes('<x:xmpmeta GPSLatitude="39.9612"/>')]);
const app0 = seg(0xe0, bytes('JFIF\0'));
const scan = [...seg(0xda, [0, 1, 2]), 9, 8, 7, 0xff, 0xd9];
const gpsJpeg = new Uint8Array([0xff, 0xd8, ...app0, ...exif, ...xmp, ...scan]);
const cleanJpeg = new Uint8Array([0xff, 0xd8, ...app0, ...scan]);

const has = (b: Uint8Array, needle: string): boolean => Buffer.from(b).includes(Buffer.from(needle));
const chunk = (type: string, data: number[]): number[] => [0, 0, (data.length >> 8) & 0xff, data.length & 0xff, ...bytes(type), ...data, 0, 0, 0, 0];
const pngOf = (...chunks: number[][]): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunks.flat(), ...chunk('IEND', [])]);

describe('the location data of a photo sent as picked (F-1717)', () => {
  // why: F-1717 a test photo that carries GPS data is sent as bytes with no location data
  it('removes the Exif and XMP segments of a JPEG and keeps the rest of the file', () => {
    expect(has(gpsJpeg, 'GPS 39.9612N')).toBe(true);
    const out = stripLocation(gpsJpeg);
    expect(has(out, 'GPS 39.9612N')).toBe(false);
    expect(has(out, 'GPSLatitude')).toBe(false);
    expect([...out]).toEqual([...cleanJpeg]);
  });

  // why: F-1717 a PNG's Exif chunk and XMP text go; its picture chunks stay
  it('removes the eXIf chunk and the XMP text of a PNG', () => {
    const png = pngOf(chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]), chunk('eXIf', GPS), chunk('iTXt', [...bytes('XML:com.adobe.xmp\0'), ...bytes('GPSLatitude')]), chunk('IDAT', [1, 2, 3]));
    const out = stripLocation(png);
    expect(has(out, 'GPS 39.9612N')).toBe(false);
    expect(has(out, 'GPSLatitude')).toBe(false);
    expect(has(out, 'IDAT')).toBe(true);
    expect(has(out, 'IHDR')).toBe(true);
  });

  // why: F-1717, F-1781 a type the phone cannot clean (HEIC, RAW) is sent as the short unreadable text, never empty (the store refuses empty) and never with the place inside it
  it('sends a type it does not read as the unreadable text, with no place', () => {
    for (const hopeless of [new Uint8Array([...bytes('\0\0\0\x18ftypheic'), ...GPS]), new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00])]) {
      const out = stripLocation(hopeless);
      expect([...out]).toEqual([...UNREADABLE_PHOTO]);
      expect(out.length).toBeGreaterThan(0);
      expect(has(out, 'GPS')).toBe(false);
    }
  });

  // why: F-1717 the photo that leaves the phone under the unreadable mark is the stripped one
  it('queues the stripped bytes for a photo the encoder cannot convert', async () => {
    const enc: Encoder = { jpeg: async () => null, original: async () => gpsJpeg };
    const c = await compressPhoto({ uri: 'file:///gps.jpg', width: 4000, height: 3000 }, enc);
    expect(c.ok).toBe(false);
    expect(has(c.bytes, 'GPS 39.9612N')).toBe(false);
    expect([...c.bytes]).toEqual([...cleanJpeg]);
  });
});

// why: F-1784 the strip keeps only what draws the picture: a place stored after the first scan or after the first EOI does not survive
describe('the strip is an allowlist (F-1784)', () => {
  const mpf = seg(0xe2, [...bytes('MPF\0'), 1, 2, 3]);
  it('cuts a secondary image with its own Exif that follows the primary EOI (MPF trailer)', () => {
    const second = [0xff, 0xd8, ...exif, ...scan];
    const out = stripLocation(new Uint8Array([0xff, 0xd8, ...app0, ...mpf, ...scan, ...second]));
    expect(has(out, 'GPS 39.9612N')).toBe(false);
    expect([...out]).toEqual([...cleanJpeg]);
  });

  it('drops an APP1 between the scans of a progressive JPEG and keeps both scans', () => {
    const scan1 = [...seg(0xda, [0, 1]), 5, 6, 0xff, 0x00, 7];
    const scan2 = [...seg(0xda, [0, 2]), 8, 9, 0xff, 0xd9];
    const dht = seg(0xc4, [1, 2, 3]);
    const out = stripLocation(new Uint8Array([0xff, 0xd8, ...app0, ...scan1, ...exif, ...xmp, ...dht, ...scan2]));
    expect(has(out, 'GPS 39.9612N')).toBe(false);
    expect([...out]).toEqual([0xff, 0xd8, ...app0, ...scan1, ...dht, ...scan2]);
  });

  it('drops a comment segment and keeps Adobe APP14', () => {
    const adobe = seg(0xee, bytes('Adobe\0\0'));
    const out = stripLocation(new Uint8Array([0xff, 0xd8, ...app0, ...seg(0xfe, bytes('taken at 39.96,-82.99')), ...adobe, ...scan]));
    expect(has(out, 'taken at')).toBe(false);
    expect([...out]).toEqual([0xff, 0xd8, ...app0, ...adobe, ...scan]);
  });

  it('drops a PNG text chunk of any keyword, such as an IPTC raw profile with place names', () => {
    const png = pngOf(chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]), chunk('zTXt', [...bytes('Raw profile type iptc\0'), ...bytes('Columbus, Ohio')]), chunk('IDAT', [1, 2, 3]));
    const out = stripLocation(png);
    expect(has(out, 'Columbus')).toBe(false);
    expect(has(out, 'IDAT')).toBe(true);
  });
});

