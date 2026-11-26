// SPDX-License-Identifier: AGPL-3.0-or-later
// The customer's signature as SD-32 keeps it (CTL-TEC-07-14; FR-TECH-14): the finger strokes the pad drew, made into a PNG of at
// most 1200 x 400 px at the finish. Pure and platform-free: the strokes are drawn on a 1-bit canvas (round pen, the pad's points
// scaled to the PNG's pixels) and encoded as a grayscale PNG whose zlib stream uses stored blocks, so no compressor is needed on the
// phone. A 1200 x 301 signature is 45,451 bytes of rows, far under the server's 512 KB cap (SIGNATURE_MAX_BYTES).

export type Stroke = { x: number; y: number }[];

/** The largest signature PNG kept, in pixels (SD-32). */
export const SIG_MAX = { width: 1200, height: 400 } as const;
/** The pen's width in the pad's points (the drawn line on the phone and in the PNG). */
export const PEN = 2.6;

/** The PNG's pixel size for a pad of w x h points: the pad scaled up to fit the largest size, SIG_MAX (SD-32), keeping its shape. */
export function sigSize(w: number, h: number): { width: number; height: number; scale: number } {
  const scale = Math.min(SIG_MAX.width / w, SIG_MAX.height / h);
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)), scale };
}

/** Whether the strokes hold any mark (a tap with no movement still counts: a dot). */
export const signed = (strokes: readonly Stroke[]): boolean => strokes.some((s) => s.length > 0);

/** The strokes on a 1-bit canvas: true where the pen drew. */
export function rasterize(strokes: readonly Stroke[], w: number, h: number): { width: number; height: number; ink: Uint8Array } {
  const { width, height, scale } = sigSize(w, h);
  const ink = new Uint8Array(width * height);
  const r = Math.max(1, (PEN * scale) / 2);
  const dot = (cx: number, cy: number) => {
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(height - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) ink[y * width + x] = 1;
  };
  for (const s of strokes) {
    for (let i = 0; i < s.length; i++) {
      const a = s[i] as { x: number; y: number };
      const b = s[i + 1] ?? a;
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * scale / (r / 2)));
      for (let k = 0; k <= steps; k++) dot((a.x + ((b.x - a.x) * k) / steps) * scale, (a.y + ((b.y - a.y) * k) / steps) * scale);
    }
  }
  return { width, height, ink };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: readonly Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (const b of p) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(b: Uint8Array): number {
  let a = 1, s = 0;
  for (const x of b) {
    a = (a + x) % 65521;
    s = (s + a) % 65521;
  }
  return ((s << 16) | a) >>> 0;
}

const u32 = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = ascii(type);
  return concat([u32(data.length), t, data, u32(crc32([t, data]))]);
}

/** A zlib stream of stored (uncompressed) deflate blocks. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let at = 0; at < raw.length || at === 0; at += 65535) {
    const part = raw.subarray(at, Math.min(raw.length, at + 65535));
    const last = at + 65535 >= raw.length ? 1 : 0;
    blocks.push(new Uint8Array([last, part.length & 0xff, part.length >>> 8, ~part.length & 0xff, (~part.length >>> 8) & 0xff]), part);
    if (raw.length === 0) break;
  }
  blocks.push(u32(adler32(raw)));
  return concat(blocks);
}

/** A 1-bit grayscale PNG of the canvas: ink black on white. */
function encodePng(c: { width: number; height: number; ink: Uint8Array }): Uint8Array {
  const rowBytes = Math.ceil(c.width / 8);
  const raw = new Uint8Array((rowBytes + 1) * c.height);
  for (let y = 0; y < c.height; y++) {
    const o = y * (rowBytes + 1);
    raw[o] = 0; // filter: none
    for (let x = 0; x < c.width; x++) {
      if (!c.ink[y * c.width + x]) raw[o + 1 + (x >> 3)] = (raw[o + 1 + (x >> 3)] as number) | (0x80 >> (x & 7)); // 1 is white
    }
    // the padding bits after the last pixel stay 0: never drawn
  }
  const ihdr = concat([u32(c.width), u32(c.height), new Uint8Array([1, 0, 0, 0, 0])]);
  return concat([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0))]);
}

/** The signature's PNG (SD-32: at most 1200 x 400 px) from the strokes on a pad of w x h points. */
export const signaturePng = (strokes: readonly Stroke[], w: number, h: number): Uint8Array => encodePng(rasterize(strokes, w, h));
