// SPDX-License-Identifier: AGPL-3.0-or-later
// Real images for the small copy tests (SD-32): unlike testing.ts's jpeg() header, sharp can decode these. Tests only.
import sharp from 'sharp';

/** A JPEG of w x h: the left half red, the right half blue, with EXIF orientation `orientation` (1 = upright as stored). */
export async function halvesJpeg(w: number, h: number, orientation = 1): Promise<Uint8Array> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(x < w / 2 ? [220, 20, 20] : [20, 20, 220], (y * w + x) * 3);
  return new Uint8Array(await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).withMetadata({ orientation }).toBuffer());
}

/** A progressive JPEG of w x h in 1 gray (F-1265: progressive is the kind that decodes whole before it shrinks). */
export async function progressiveJpeg(w: number, h: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width: w, height: h, channels: 3, background: '#808080' } }).jpeg({ quality: 80, progressive: true }).toBuffer());
}

/** A copy of a JPEG whose first frame header (SOF) claims w x h: the claim a header read sees, whatever pixels follow. */
export function claimingSize(jpeg: Uint8Array, w: number, h: number): Uint8Array {
  const b = new Uint8Array(jpeg);
  for (let i = 2; i + 9 < b.length; i += 2 + ((b[i + 2]! << 8) | b[i + 3]!)) {
    const m = b[i + 1]!;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      b.set([h >> 8, h & 0xff, w >> 8, w & 0xff], i + 5);
      return b;
    }
  }
  throw new Error('no frame header');
}

/** A white PNG of w x h (a signature's type). */
export async function whitePng(w: number, h: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width: w, height: h, channels: 3, background: '#ffffff' } }).png().toBuffer());
}

/** The RGB of 1 pixel of an image. */
export async function pixel(image: Uint8Array, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}
export const reddish = (p: number[]): boolean => p[0]! > 150 && p[2]! < 100;
export const bluish = (p: number[]): boolean => p[2]! > 150 && p[0]! < 100;

/** Pixel size and EXIF orientation (1 when absent) of an image. */
export async function sizeOf(image: Uint8Array): Promise<{ format: string | undefined; width: number | undefined; height: number | undefined; orientation: number }> {
  const m = await sharp(image).metadata();
  return { format: m.format, width: m.width, height: m.height, orientation: m.orientation ?? 1 };
}
