// SPDX-License-Identifier: AGPL-3.0-or-later
// SD-32 on the native phone (CTL-TEC-06-03; F-978): the photo the system picker hands over is made a JPEG, longest side 2048 px,
// quality 0.8, before it is stored, so the photo that reaches API-103 fits the server's 10 MB cap and its type. iOS decodes every
// photo type the camera and the library make (HEIC, RAW/DNG, PNG), so the encoder is the platform's (expo-image-manipulator, through
// the Encoder port; photo-expo.ts on the phone). A JPEG still over the cap is encoded again at a lower quality, then smaller, as the
// web app does (apps/web/src/tech/job/photo.ts). A photo the phone could not encode at all is kept as picked, without its location data (F-1717), marked unreadable. The
// native transport still sends the picked file's bytes under that mark (net/transport.ts; see F-1035), and the server flags the photo for the
// office (F-931); the web app, which holds no file, sends no bytes. Never a refusal that keeps it on the phone.
import { PHOTO_MAX_BYTES } from '@bw/api';
import { stripLocation, UNREADABLE_PHOTO } from './location-strip.ts';

export const LONGEST_SIDE = 2048;
export const QUALITY = 0.8;
/** The steps tried after the first JPEG is over the cap: lower qualities at full size, then smaller sides. */
export const STEPS: readonly { side: number; quality: number }[] = [
  { side: LONGEST_SIDE, quality: QUALITY },
  { side: LONGEST_SIDE, quality: 0.6 }, { side: LONGEST_SIDE, quality: 0.4 }, { side: 1600, quality: 0.4 }, { side: 1024, quality: 0.4 },
];

/** The scaled size: the longest side at most `side`, never enlarged. */
export function fitSize(width: number, height: number, side = LONGEST_SIDE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= side) return { width, height };
  const k = side / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** The platform's JPEG encoder: the picked image at a pixel size and quality, or null when it cannot be decoded. */
export interface Encoder {
  jpeg(uri: string, size: { width: number; height: number }, quality: number): Promise<{ uri: string; bytes: Uint8Array; width: number; height: number } | null>;
  /** The picked file's own bytes (the unreadable case). */
  original(uri: string): Promise<Uint8Array>;
}

export type Compressed =
  | { ok: true; uri: string; bytes: Uint8Array; width: number; height: number; type: 'image/jpeg' }
  | { ok: false; reason: 'unreadable'; bytes: Uint8Array };

const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** SD-32: the picked photo as a JPEG that fits API-103, or the photo as picked when the phone cannot encode it. */
export async function compressPhoto(picked: { uri: string; width: number; height: number }, enc: Encoder): Promise<Compressed> {
  for (const s of STEPS) {
    let out;
    try {
      out = await enc.jpeg(picked.uri, fitSize(picked.width, picked.height, s.side), s.quality);
    } catch {
      out = null;
    }
    if (!out || !isJpeg(out.bytes)) break;
    if (out.bytes.byteLength <= PHOTO_MAX_BYTES) return { ok: true, type: 'image/jpeg', ...out };
  }
  // F-1717: the original goes without its location data (location-strip.ts), never as the file holds it.
  return { ok: false, reason: 'unreadable', bytes: stripLocation(await enc.original(picked.uri).catch(() => UNREADABLE_PHOTO)) };
}
