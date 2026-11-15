// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-IOS-1, F-1264 (the iPhone app icon was still the placeholder blue RT tile; the web icons use the DK-117 mark)
// The iPhone app's icon file and how it is drawn (scripts/app-icon.mts): 1024 x 1024 with no alpha channel, the kit frame's own mark on a
// white tile at the .appicon proportion, and the app still named Right On Time. The pixel-for-pixel match with a fresh rsvg-convert draw
// runs on the owner's Mac (`node apps/tech-native/scripts/app-icon.mts --check`; rsvg-convert is not on the CI runners).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_JSON, decodePng, encodeRgbPng, FRAME, ICON, MARK_SHARE, markSvg, pngInfo, SIZE, tileSvg } from '../scripts/app-icon.mts';

describe('the iPhone app icon (F-1264)', () => {
  // why: FR-IOS-1 App Store Connect takes a 1024 px icon with no alpha channel; the file is 8-bit RGB, every pixel opaque
  it('is a 1024 x 1024 RGB PNG with no alpha channel', () => {
    const png = readFileSync(ICON);
    expect(pngInfo(png)).toEqual({ width: SIZE, height: SIZE, depth: 8, colorType: 2, interlace: 0 });
    const { rgba } = decodePng(png);
    expect(rgba.length).toBe(SIZE * SIZE * 4);
    expect([...rgba.subarray(0, 4)]).toEqual([255, 255, 255, 255]); // the white tile at its corner
    const mid = (620 * SIZE + 330) * 4; // inside the drop, left of the flame
    expect(rgba[mid + 2]! > rgba[mid]!).toBe(true); // the drop's teal, not white
  });

  // why: FR-IOS-1 F-1264 the icon is the DK-117 .appicon mark itself, read from the kit frame, on a white tile at 42/66 of its side
  it('draws the kit frame\'s own mark at the .appicon proportion', () => {
    const frame = readFileSync(FRAME, 'utf8');
    const mark = markSvg(frame);
    expect(mark).toContain('url(#bwDrop)');
    expect(mark).toContain('url(#bwFlame)');
    expect(frame).toMatch(/\.appicon \{ width: 66px; height: 66px;[^}]*background: #fff;/);
    expect(frame).toMatch(/\.appicon svg\.mark \{ width: 42px; height: 42px; \}/);
    expect(MARK_SHARE).toBe(42 / 66);
    const svg = tileSvg(mark);
    expect(svg).toContain(`<rect width="${SIZE}" height="${SIZE}" fill="#ffffff"/>`);
    expect(svg).toContain(`width="${SIZE * MARK_SHARE}" height="${SIZE * MARK_SHARE}" viewBox="0 0 32 32"`);
    expect(svg).toContain(mark.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, ''));
    expect(() => markSvg('<html></html>')).toThrow(/no `const MARK`/);
  });

  // why: FR-IOS-1 the file the script writes reads back as the same pixels, and a pixel that is not opaque is refused (no alpha slips in)
  it('writes RGB that reads back pixel for pixel, and refuses a see-through pixel', () => {
    const rgba = Buffer.from([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 1, 2, 3, 255]);
    const png = encodeRgbPng(2, 2, rgba);
    expect(pngInfo(png).colorType).toBe(2);
    expect(decodePng(png).rgba.equals(rgba)).toBe(true);
    expect(() => encodeRgbPng(1, 1, Buffer.from([0, 0, 0, 128]))).toThrow(/not opaque/);
  });

  // why: FR-IOS-1 the app's name stays Right On Time (owner answer e4cf66d3; no new look), with this file as its icon
  it('keeps the app named Right On Time with this icon', () => {
    const expo = (JSON.parse(readFileSync(APP_JSON, 'utf8')) as { expo: { name: string; icon: string } }).expo;
    expect([expo.name, expo.icon]).toEqual(['Right On Time', './assets/icon.png']);
  });
});
