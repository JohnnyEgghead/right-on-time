// SPDX-License-Identifier: AGPL-3.0-or-later
// The photo small copy (SPECIFICATIONS SD-32; UI-SPECIFICATION API-175 size thumb, UD-55; F-1235): a JPEG made from the stored
// photo with sharp, turned upright by its EXIF orientation, scaled so its longest side is 320 px (a photo already that small is
// copied at its own size, never enlarged), quality 0.8, written write-once beside the photo as <file>.thumb.jpg.
//   - API-103 makes it in the same request that stores the photo (a kept one, or one refused and kept), after the photo's own
//     file and before the rows commit; a failure there never fails the send (the photo is the item; its copy is remade on read).
//   - API-175 size=thumb answers it, and makes and writes it first when it is missing (stored before this rule, or lost).
//   - Cleanup counts it as referenced by its photo's row (apps/worker/src/clock/cleanup.ts thumbOf).
// sharp's libvips runs with its cache off and 1 thread: a send or a tile read makes 1 small copy, and the web process keeps a
// small memory cap (infra/compose.yaml), so nothing is held between calls.
// F-1265: the upload bounds a photo's bytes (10 MB), not its pixels, and a progressive JPEG decodes whole before it shrinks, so a
// small file can claim a picture that OOM-kills web (16383 x 16383 in 2.25 MB did, under web's 256m). A photo's pixels are read
// from its frame header first (blob.ts imageSize, no decode), and one over THUMB_MAX_PIXELS gets no copy (ThumbTooLarge); sharp's
// limitInputPixels holds the same bound as a backstop should the two header reads ever disagree.
import sharp from 'sharp';
import { imageSize, writeBlobFile } from './blob.ts';

/** SD-32: the small copy's longest side, in pixels. */
export const THUMB_LONGEST = 320;
/** The small copy's JPEG quality: 0.8, which is 80 on sharp's scale of 1 to 100 (SD-32). */
const THUMB_QUALITY = 80;

/**
 * SD-32: the most pixels a photo may have and still get a small copy: 2048 x 2048, the largest picture the apps' compression makes
 * (longest side 2048 px). Its decode adds about 16 MiB (progressive, measured on the Mac); 8000 x 8000 added about 190 MiB.
 */
export const THUMB_MAX_PIXELS = 2048 * 2048;

/** A photo over THUMB_MAX_PIXELS: no copy is made, and its pixels are never decoded. */
export class ThumbTooLarge extends Error {
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    super(`a ${width} x ${height} photo is over the small copy's ${THUMB_MAX_PIXELS} pixel limit`);
    this.name = 'ThumbTooLarge';
    this.width = width;
    this.height = height;
  }
}

sharp.cache(false);
sharp.concurrency(1);

/** The small copy's stored name beside its photo: <yyyy-mm>/<key>.thumb.jpg. */
export const thumbFile = (file: string): string => `${file}.thumb.jpg`;

/**
 * The small copy's bytes from a photo's bytes. Throws ThumbTooLarge for a photo over THUMB_MAX_PIXELS (checked from its frame
 * header before any decode), and an Error when it has no JPEG frame header or sharp cannot decode it.
 */
export async function makeThumb(photo: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const size = imageSize(photo, 'image/jpeg');
  if (!size) throw new Error('the photo has no JPEG frame header');
  if (size.width * size.height > THUMB_MAX_PIXELS) throw new ThumbTooLarge(size.width, size.height);
  const out = await sharp(photo, { failOn: 'error', limitInputPixels: THUMB_MAX_PIXELS })
    .rotate()
    .resize(THUMB_LONGEST, THUMB_LONGEST, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY })
    .toBuffer();
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength) as Uint8Array<ArrayBuffer>;
}

/** The log line's errorCode for a copy that could not be made: a named skip for an oversized photo, else a failure. */
export const thumbErrorCode = (e: unknown): 'photo_thumb_too_large' | 'photo_thumb_failed' =>
  (e instanceof ThumbTooLarge ? 'photo_thumb_too_large' : 'photo_thumb_failed');

/** Make and store a photo's small copy; answers its bytes. Throws as makeThumb does, or on a write failure. */
export async function writeThumb(photosDir: string, file: string, photo: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await makeThumb(photo);
  await writeBlobFile(photosDir, thumbFile(file), bytes);
  return bytes;
}
