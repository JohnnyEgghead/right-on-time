// SPDX-License-Identifier: AGPL-3.0-or-later
// The iPhone app's icon (P6-NATIVE-STEPS part d; F-1264): the DK-117 .appicon Brightwater mark (a cool water drop holding a warm flame) on a
// white tile, the same mark the web technician app's icons use (P6-OFFICE-FOLLOWS), at 1024 x 1024 px with no alpha channel (App Store
// Connect refuses an icon with one). The mark is read from the kit frame itself (mockups/pages/r1-ios-b.html, `const MARK`), placed as the
// frame's .appicon places it (a 42 px mark centered on a 66 px tile, so 42/66 of the tile), drawn by rsvg-convert, and written as an 8-bit
// RGB PNG. The app's name stays Right On Time (owner answer e4cf66d3; manager ruling Nov 9, 2026: no new look).
//   node apps/tech-native/scripts/app-icon.mts --write   draw assets/icon.png from the kit's mark
//   node apps/tech-native/scripts/app-icon.mts --check   a fresh rsvg-convert draw of the mark matches assets/icon.png pixel for pixel,
//                                                       the file is 1024 x 1024 with no alpha channel, and app.json names Right On Time
// Exit 0 pass, 1 a difference, 2 usage or no rsvg-convert. rsvg-convert (librsvg) runs on the owner's Mac only; it is never bundled.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
export const FRAME = path.join(ROOT, 'mockups', 'pages', 'r1-ios-b.html');
export const ICON = path.join(ROOT, 'apps', 'tech-native', 'assets', 'icon.png');
export const APP_JSON = path.join(ROOT, 'apps', 'tech-native', 'app.json');
export const SIZE = 1024;
/** DK-117 .appicon: a 66 px tile holding a 42 px mark. */
export const MARK_SHARE = 42 / 66;

/** The kit's mark: the <svg class="mark" viewBox="0 0 32 32"> of r1-ios-b.html's `const MARK`, as the frame holds it. */
export function markSvg(frameHtml: string): string {
  const m = /const MARK = `\s*(<svg class="mark" viewBox="0 0 32 32"[\s\S]*?<\/svg>)`;/.exec(frameHtml);
  if (!m?.[1]) throw new Error('app-icon: no `const MARK` <svg class="mark"> in the kit frame');
  return m[1];
}

/** The icon's drawing: a white 1024 px square, the mark at 42/66 of it, centered (iOS rounds the corners itself). */
export function tileSvg(mark: string): string {
  const inner = mark.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  const side = SIZE * MARK_SHARE;
  const at = (SIZE - side) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`
    + `<rect width="${SIZE}" height="${SIZE}" fill="#ffffff"/>`
    + `<svg x="${at}" y="${at}" width="${side}" height="${side}" viewBox="0 0 32 32">${inner}</svg></svg>`;
}

/** A PNG's header: width, height, bit depth and color type (2 RGB, 6 RGBA; any other type has an alpha channel or a palette). */
export function pngInfo(png: Buffer): { width: number; height: number; depth: number; colorType: number; interlace: number } {
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.toString('latin1', 12, 16) !== 'IHDR') throw new Error('app-icon: not a PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), depth: png[24] as number, colorType: png[25] as number, interlace: png[28] as number };
}

/** The chunks of a PNG of `type`, in order. */
function chunks(png: Buffer, type: string): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at);
    if (png.toString('latin1', at + 4, at + 8) === type) out.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  return out;
}

/** An 8-bit, non-interlaced RGB or RGBA PNG's pixels as RGBA bytes (row filters undone). */
export function decodePng(png: Buffer): { width: number; height: number; rgba: Buffer } {
  const h = pngInfo(png);
  if (h.depth !== 8 || (h.colorType !== 2 && h.colorType !== 6) || h.interlace !== 0) throw new Error(`app-icon: unsupported PNG (depth ${h.depth}, color type ${h.colorType})`);
  const bpp = h.colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(chunks(png, 'IDAT')));
  const stride = h.width * bpp;
  const cur = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  const rgba = Buffer.alloc(h.width * h.height * 4);
  for (let y = 0; y < h.height; y += 1) {
    const f = raw[y * (stride + 1)] as number;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? (cur[i - bpp] as number) : 0;
      const b = prev[i] as number;
      const c = i >= bpp ? (prev[i - bpp] as number) : 0;
      const x = line[i] as number;
      let v: number;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`app-icon: bad filter ${f}`);
      cur[i] = v & 0xff;
    }
    for (let px = 0; px < h.width; px += 1) {
      cur.copy(rgba, (y * h.width + px) * 4, px * bpp, px * bpp + 3);
      rgba[(y * h.width + px) * 4 + 3] = bpp === 4 ? (cur[px * bpp + 3] as number) : 255;
    }
    cur.copy(prev);
  }
  return { width: h.width, height: h.height, rgba };
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(b: Buffer): number {
  let c = -1;
  for (const x of b) c = (CRC[(c ^ x) & 0xff] as number) ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** An 8-bit RGB PNG (no alpha channel) of opaque RGBA pixels; refuses a pixel that is not fully opaque. */
export function encodeRgbPng(width: number, height: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const s = (y * width + x) * 4;
      if (rgba[s + 3] !== 255) throw new Error(`app-icon: pixel ${x},${y} is not opaque`);
      rgba.copy(raw, y * (width * 3 + 1) + 1 + x * 3, s, s + 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** rsvg-convert's draw of the kit's mark on its tile, as RGBA pixels. */
export function drawIcon(): { width: number; height: number; rgba: Buffer } {
  const dir = mkdtempSync(path.join(tmpdir(), 'bw-app-icon-'));
  try {
    writeFileSync(path.join(dir, 'icon.svg'), tileSvg(markSvg(readFileSync(FRAME, 'utf8'))));
    execFileSync('rsvg-convert', ['-w', String(SIZE), '-h', String(SIZE), '-f', 'png', '-o', path.join(dir, 'icon.png'), path.join(dir, 'icon.svg')]);
    return decodePng(readFileSync(path.join(dir, 'icon.png')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv: string[]): number {
  const mode = argv[0];
  if (mode !== '--write' && mode !== '--check') {
    console.error('usage: node apps/tech-native/scripts/app-icon.mts --write | --check');
    return 2;
  }
  try {
    execFileSync('rsvg-convert', ['--version'], { stdio: 'ignore' });
  } catch {
    console.error('app-icon: rsvg-convert is not installed (brew install librsvg)');
    return 2;
  }
  const drawn = drawIcon();
  if (mode === '--write') {
    writeFileSync(ICON, encodeRgbPng(drawn.width, drawn.height, drawn.rgba));
    console.log(`app-icon: wrote ${path.relative(ROOT, ICON)} (${drawn.width} x ${drawn.height}, RGB)`);
    return 0;
  }
  const file = readFileSync(ICON);
  const info = pngInfo(file);
  const problems: string[] = [];
  let have: { width: number; height: number; rgba: Buffer } = { width: 0, height: 0, rgba: Buffer.alloc(0) };
  try {
    have = decodePng(file);
  } catch (e) {
    problems.push((e as Error).message);
  }
  if (info.width !== SIZE || info.height !== SIZE) problems.push(`size ${info.width} x ${info.height}, not ${SIZE} x ${SIZE}`);
  if (info.colorType !== 2) problems.push(`color type ${info.colorType}: not RGB without an alpha channel`);
  let differ = 0;
  if (have.rgba.length === drawn.rgba.length) {
    for (let i = 0; i < have.rgba.length; i += 1) if (have.rgba[i] !== drawn.rgba[i]) differ += 1;
  } else {
    problems.push('pixel count differs from the fresh draw');
  }
  if (differ > 0) problems.push(`${differ} channel value(s) differ from a fresh rsvg-convert draw of the kit's mark`);
  const name = (JSON.parse(readFileSync(APP_JSON, 'utf8')) as { expo: { name: string; icon: string } }).expo;
  if (name.name !== 'Right On Time') problems.push(`app.json names the app ${name.name}`);
  if (name.icon !== './assets/icon.png') problems.push(`app.json's icon is ${name.icon}`);
  for (const p of problems) console.log(`app-icon: FAIL ${p}`);
  console.log(`app-icon: ${problems.length === 0 ? 'PASS' : 'FAIL'} ${path.relative(ROOT, ICON)} ${info.width} x ${info.height}, color type ${info.colorType}, ${differ} differing channel value(s); app name ${name.name}`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) process.exit(main(process.argv.slice(2)));
