// SPDX-License-Identifier: AGPL-3.0-or-later
// The photo the native job suite picks (P6-NATIVE-JOB; xcuitest/run.sh adds it to the simulator's photo library, which has no camera):
// an RGB PNG of noise, width x height, stored with no compression, so its file is about 3 bytes a pixel and over API-103's 10 MB cap,
// the SD-32 case the phone must shrink (a 3200 x 1200 PNG becomes a 2048 x 768 JPEG). Deterministic (a fixed xorshift seed).
//   node xcuitest/noise-png.mjs <out.png> <width> <height>        prints "<width>x<height> <bytes>"
import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const [out, w, h] = process.argv.slice(2);
const width = Number(w), height = Number(h);
if (!out || !(width > 0) || !(height > 0)) {
  console.error('usage: noise-png.mjs <out.png> <width> <height>');
  process.exit(2);
}
const row = width * 3 + 1;
const raw = Buffer.alloc(row * height);
let x = 0x9e3779b9;
for (let i = 0; i < raw.length; i++) {
  if (i % row === 0) continue; // filter byte: none
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  raw[i] = x & 0xff;
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr.set([8, 2, 0, 0, 0], 8);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
writeFileSync(out, png);
console.log(`${width}x${height} ${png.length}`);
