// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1717: the location data of a photo the phone could not convert to a JPEG. That photo is sent as picked (photo.ts, F-1035), so its own
// bytes would carry whatever the file stores inside itself, including where it was taken. This removes the places a location lives, and
// keeps only what draws the picture (F-1784): a JPEG keeps its picture segments, JFIF and Adobe and ends at its first EOI; a PNG loses its eXIf chunk and every text chunk. A type this
// does not read (HEIC, RAW/DNG, any other) is not sent as the file: its bytes are the short text below, which is neither a JPEG nor a PNG, so the
// server flags the item for the dispatcher (API-103 validation_failed, F-931, owner ruling 546d6f1e) and no place leaves the phone. It is not
// an empty file: the outbox store refuses empty bytes, so an empty file never leaves the phone (F-1781). Platform-free, so the tests run it on node.

/** F-1781: what is sent for a photo this cannot clean: 10 bytes of text, no picture, no location. The server flags it as unreadable. */
export const UNREADABLE_PHOTO = new Uint8Array([...'unreadable'].map((c) => c.charCodeAt(0)));
const NONE = UNREADABLE_PHOTO;

const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));

/**
 * F-1784: an allowlist, not a denylist. A JPEG keeps its picture segments (DQT, DHT, SOFn, DRI, DNL, SOS and the scan data after each
 * SOS), APP0 JFIF and APP14 Adobe; every other segment (every other APPn, so Exif, XMP, MPF and the rest, and COM) is dropped, wherever
 * it sits (before the first scan or between the scans of a progressive file), and the file ends at the first EOI, so a second image
 * appended after it (an MPF secondary with its own Exif) is cut off.
 */
function jpeg(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  let scans = 0;
  while (i < b.length) {
    if (b[i] !== 0xff) return NONE;
    const marker = b[i + 1];
    if (marker === undefined) return NONE;
    if (marker === 0xff) { i += 1; continue; } // fill byte
    if (marker === 0xd9) { out.push(b.subarray(i, i + 2)); return scans > 0 ? join(out) : NONE; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; } // no length, no picture data here
    const len = ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0);
    if (len < 2 || i + 2 + len > b.length) return NONE;
    const seg = b.subarray(i, i + 2 + len);
    const picture = marker === 0xdb || marker === 0xc4 || marker === 0xdd || marker === 0xdc || marker === 0xda
      || (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc8 && marker !== 0xcc);
    const jfif = marker === 0xe0 && ascii(b, i + 4, 5) === 'JFIF\0';
    const adobe = marker === 0xee && ascii(b, i + 4, 5) === 'Adobe';
    if (picture || jfif || adobe) out.push(seg);
    i += 2 + len;
    if (marker === 0xda) {
      scans += 1;
      const from = i;
      // the scan data runs to the next marker that is not a stuffed 0xFF00, a restart or a fill byte
      while (i < b.length && !(b[i] === 0xff && (b[i + 1] ?? 0) !== 0x00 && !((b[i + 1] ?? 0) >= 0xd0 && (b[i + 1] ?? 0) <= 0xd7) && b[i + 1] !== 0xff)) i += 1;
      out.push(b.subarray(from, i));
    }
  }
  return NONE; // no end of picture: not a photo this reads
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] ?? 0) * 0x1000000) + (((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0));
    const type = ascii(b, i + 4, 4);
    const end = i + 12 + len;
    if (end > b.length) return NONE;
    // F-1784: every text chunk goes (a raw profile such as IPTC can hold place names under any keyword), and the eXIf chunk
    const holdsPlace = type === 'eXIf' || type === 'iTXt' || type === 'tEXt' || type === 'zTXt';
    if (!holdsPlace) out.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') return join(out);
  }
  return NONE;
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The photo's bytes with its location data removed; the unreadable-photo text for a type this does not read (see the header). */
export function stripLocation(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpeg(bytes);
  if (bytes.length > 8 && PNG_SIGNATURE.every((v, k) => bytes[k] === v)) return png(bytes);
  return NONE;
}
