// SPDX-License-Identifier: AGPL-3.0-or-later
// SD-32 on the phone (CTL-TEC-06-03; F-978, F-69): every photo is compressed to a JPEG, longest side 2048 px, quality 0.8,
// before it is stored, so the photo that reaches API-103 fits the server's 10 MB cap and its type. The browser decodes the
// picked file (createImageBitmap, or an <img> where that refuses the type: WebKit decodes HEIC and its RAW types there),
// draws it scaled on a canvas and encodes a JPEG. A JPEG still over the cap (only a picture of noise could be) is encoded
// again at a lower quality, then smaller, until it fits.
//
// A file this browser cannot decode at all (F-69: a DNG where the engine has no decoder) cannot be shrunk. It is kept as
// it was picked, marked unreadable; the send (uploadBody) then sends it with no bytes, which API-103 answers flagged
// validation_failed and lists for the dispatcher (SPECIFICATIONS 5.1 step 10, owner ruling 546d6f1e, F-931). So it leaves
// the phone, and the office is told, instead of waiting on the phone forever behind a refusal no one sees.
import { PHOTO_MAX_BYTES } from '@bw/api';

export const LONGEST_SIDE = 2048;
export const QUALITY = 0.8;
/** The steps tried after the first JPEG is over the cap: lower qualities at full size, then smaller sides. */
const STEPS: readonly { side: number; quality: number }[] = [
  { side: LONGEST_SIDE, quality: 0.6 }, { side: LONGEST_SIDE, quality: 0.4 }, { side: 1600, quality: 0.4 }, { side: 1024, quality: 0.4 },
];

export type Compressed =
  | { ok: true; bytes: Uint8Array; width: number; height: number; type: 'image/jpeg' }
  | { ok: false; reason: 'unreadable'; bytes: Uint8Array; type: string };

/** The scaled size: the longest side at most `side`, never enlarged. */
export function fitSize(width: number, height: number, side = LONGEST_SIDE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= side) return { width, height };
  const k = side / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

interface Drawable { width: number; height: number; source: CanvasImageSource; close(): void }

async function decode(file: Blob): Promise<Drawable | null> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close() };
  } catch {
    // Not decodable as a bitmap here: try the image element, which decodes more types in WebKit.
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    if (img.naturalWidth === 0 || img.naturalHeight === 0) return null;
    return { width: img.naturalWidth, height: img.naturalHeight, source: img, close: () => undefined };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function encode(d: Drawable, side: number, quality: number): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  const size = fitSize(d.width, d.height, side);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.drawImage(d.source, 0, 0, size.width, size.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob || blob.type !== 'image/jpeg') return null;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), ...size };
}

/** SD-32: the picked file as a JPEG that fits API-103, or the file as picked when this browser cannot decode it. */
export async function compressPhoto(file: Blob): Promise<Compressed> {
  const d = await decode(file);
  if (!d) return { ok: false, reason: 'unreadable', bytes: new Uint8Array(await file.arrayBuffer()), type: file.type || 'application/octet-stream' };
  try {
    for (const s of [{ side: LONGEST_SIDE, quality: QUALITY }, ...STEPS]) {
      const out = await encode(d, s.side, s.quality);
      if (!out) break;
      if (out.bytes.byteLength <= PHOTO_MAX_BYTES) return { ok: true, type: 'image/jpeg', ...out };
    }
  } finally {
    d.close();
  }
  return { ok: false, reason: 'unreadable', bytes: new Uint8Array(await file.arrayBuffer()), type: file.type || 'application/octet-stream' };
}

/** A JPEG (photo) or PNG (signature) by its first bytes (the 2 types of SD-32). */
export function isJpegOrPng(b: Uint8Array): boolean {
  const jpeg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  return jpeg || png;
}

/**
 * F-978: the body API-103 is sent for a stored photo or signature. Bytes the server would refuse unread (over the 10 MB cap,
 * or not a JPEG or PNG: a photo this phone could not shrink) go as no bytes, so the server answers the key flagged
 * validation_failed and lists it for the dispatcher, instead of a 413 or 422 that keeps it on the phone.
 */
export function uploadBody(bytes: Uint8Array): Uint8Array {
  return bytes.byteLength > PHOTO_MAX_BYTES || !isJpegOrPng(bytes) ? new Uint8Array(0) : bytes;
}
