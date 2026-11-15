// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-3 (SPECIFICATIONS SD-32, UI-SPECIFICATION API-175 size thumb, UD-55): the photo small copy sharp makes
import { describe, expect, it } from 'vitest';
import { makeThumb, thumbErrorCode, thumbFile, THUMB_LONGEST, THUMB_MAX_PIXELS, ThumbTooLarge } from './thumb.ts';
import { bluish, claimingSize, halvesJpeg, pixel, progressiveJpeg, reddish, sizeOf } from './test-images.ts';
import { thumbOf } from '../../../../apps/worker/src/clock/cleanup.ts';

describe('the photo small copy (SD-32)', () => {
  it('scales a 2048 x 1536 photo so its longest side is 320 px, as a JPEG with no orientation left to apply', async () => {
    // why: FR-TECH-3 (UD-55, F-1235) a tile reads a copy whose longest side is 320 px, not the 400-840 KB photo
    expect(await sizeOf(await makeThumb(await halvesJpeg(2048, 1536)))).toEqual({ format: 'jpeg', width: THUMB_LONGEST, height: 240, orientation: 1 });
  });

  it('turns the copy upright by the photo\'s EXIF orientation', async () => {
    // why: FR-TECH-3 (SD-32) an iPhone photo held upright is stored sideways with orientation 6; its tile must not be sideways
    const out = await makeThumb(await halvesJpeg(640, 480, 6));
    expect(await sizeOf(out)).toMatchObject({ width: 240, height: 320, orientation: 1 });
    // Orientation 6 turns the stored picture a quarter turn clockwise: its left half (red) is the copy's top.
    expect(reddish(await pixel(out, 120, 20))).toBe(true);
    expect(bluish(await pixel(out, 120, 300))).toBe(true);
  });

  it('never enlarges a photo already smaller than 320 px', async () => {
    // why: FR-TECH-3 (SD-32) a 200 px photo's copy is 200 px: copied at its own size
    expect(await sizeOf(await makeThumb(await halvesJpeg(200, 150)))).toMatchObject({ width: 200, height: 150 });
  });

  it('refuses bytes sharp cannot decode, so the caller can fall back', async () => {
    // why: FR-TECH-3 (SD-32) a JPEG header with no picture behind it has no small copy; the send and the tile read must not break on it
    const head = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0, 0xff, 0xd9]);
    await expect(makeThumb(head)).rejects.toThrow();
  });

  it('still makes the copy of a progressive photo at the pixel limit, 2048 x 2048', async () => {
    // why: FR-TECH-3 (SD-32, F-1265) the apps compress a photo to a longest side of 2048 px, so every app-made photo is within the limit
    expect(THUMB_MAX_PIXELS).toBe(2048 * 2048);
    expect(await sizeOf(await makeThumb(await progressiveJpeg(2048, 2048)))).toMatchObject({ format: 'jpeg', width: 320, height: 320 });
  });

  it('refuses a progressive photo over the pixel limit before decoding it, named so the caller logs a skip', async () => {
    // why: FR-TECH-3 (SD-32, F-1265) a progressive JPEG decodes whole before it shrinks; 16383 x 16383 in 2.25 MB OOM-killed web at 256m
    const big = await progressiveJpeg(4096, 4096);
    await expect(makeThumb(big)).rejects.toBeInstanceOf(ThumbTooLarge);
    // The reviewer's 16383 x 16383 claim on a small picture's bytes: refused from the header, so sharp never sees it (a decode
    // would answer a different error on pixels that do not match the header).
    const claim = claimingSize(await progressiveJpeg(64, 64), 16383, 16383);
    const e = await makeThumb(claim).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ThumbTooLarge);
    expect(e).toMatchObject({ width: 16383, height: 16383 });
    // 1 pixel over the limit is over it.
    await expect(makeThumb(claimingSize(await progressiveJpeg(64, 64), 2049, 2048))).rejects.toBeInstanceOf(ThumbTooLarge);
  });

  it('names an oversized photo\'s refusal a skip and every other a failure, for the log line', async () => {
    // why: FR-TECH-3 (SD-32, F-1265) the send and the thumb read log photo_thumb_too_large for a skip, photo_thumb_failed otherwise
    expect(thumbErrorCode(new ThumbTooLarge(4096, 4096))).toBe('photo_thumb_too_large');
    expect(thumbErrorCode(new Error('VipsJpeg: premature end of input file'))).toBe('photo_thumb_failed');
  });

  it('names the copy beside its photo, the name Cleanup keeps with the photo\'s row', () => {
    // why: FR-TECH-3 (SD-32) Cleanup counts a small copy as referenced by its photo's row, so both sides must spell the name alike
    expect(thumbFile('2026-09/0b1e')).toBe('2026-09/0b1e.thumb.jpg');
    expect(thumbOf('2026-09/0b1e')).toBe(thumbFile('2026-09/0b1e'));
  });
});
