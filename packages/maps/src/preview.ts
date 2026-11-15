// SPDX-License-Identifier: AGPL-3.0-or-later
// The inbox's map preview picture (API-164, FR-TEXT-21, HC-04, NFR-04): an SVG drawn on the server from the branch's own PMTiles file, the roads
// around the destination, the destination pin and the OpenStreetMap credit. It holds no van position: the picture is the same before and
// after the van moves. A PMTiles v3 reader (header, directories, tile bytes) and a minimal Mapbox Vector Tile decoder (the road lines only),
// both over node:fs and node:zlib, so the picture adds no dependency.
import { closeSync, openSync, readSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { HEADER_BYTES } from './pmtiles.ts';

export interface PreviewPoint { lon: number; lat: number }

const WIDTH = 600;
const HEIGHT = 300;
const ZOOM = 14;
const TILE_PX = 512;

function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, offset);
  return buf.subarray(0, n);
}
const u64 = (b: Buffer, at: number): number => Number(b.readBigUInt64LE(at));

function varint(b: Buffer, at: { i: number }): number {
  let r = 0;
  let mul = 1;
  for (;;) {
    const byte = b[at.i++]!;
    r += (byte & 0x7f) * mul;
    if (byte < 0x80) return r;
    mul *= 128;
  }
}

/** The PMTiles tile id of z/x/y: the tiles of every smaller zoom first, then the Hilbert curve position (PMTiles v3 spec). */
export function tileId(z: number, x: number, y: number): number {
  let acc = 0;
  for (let t = 0; t < z; t++) acc += 4 ** t;
  const n = 2 ** z;
  let d = 0;
  let px = x;
  let py = y;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (px & s) > 0 ? 1 : 0;
    const ry = (py & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { px = n - 1 - px; py = n - 1 - py; }
      [px, py] = [py, px];
    }
  }
  return acc + d;
}

interface Entry { id: number; offset: number; length: number; run: number }

function parseDirectory(raw: Buffer): Entry[] {
  const at = { i: 0 };
  const n = varint(raw, at);
  const out: Entry[] = [];
  let last = 0;
  for (let i = 0; i < n; i++) { last += varint(raw, at); out.push({ id: last, offset: 0, length: 0, run: 0 }); }
  for (const e of out) e.run = varint(raw, at);
  for (const e of out) e.length = varint(raw, at);
  for (let i = 0; i < n; i++) {
    const v = varint(raw, at);
    out[i]!.offset = v === 0 && i > 0 ? out[i - 1]!.offset + out[i - 1]!.length : v - 1;
  }
  return out;
}

function findEntry(dir: Entry[], id: number): Entry | null {
  let lo = 0;
  let hi = dir.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = dir[mid]!;
    if (e.id <= id) lo = mid + 1;
    else hi = mid - 1;
  }
  const e = dir[hi];
  if (!e) return null;
  if (e.run === 0) return e; // a leaf directory pointer
  return id < e.id + e.run ? e : null;
}

/** The raw (decompressed) bytes of tile z/x/y, or null when the file holds none. */
export function readTile(file: string, z: number, x: number, y: number): Buffer | null {
  const fd = openSync(file, 'r');
  try {
    const head = readAt(fd, 0, HEADER_BYTES);
    const rootOff = u64(head, 8);
    const rootLen = u64(head, 16);
    const leafOff = u64(head, 40);
    const dataOff = u64(head, 56);
    const internal = head.readUInt8(97);
    const tiles = head.readUInt8(98);
    const unpack = (b: Buffer, kind: number): Buffer => (kind === 2 ? gunzipSync(b) : b);
    const id = tileId(z, x, y);
    let dir = parseDirectory(unpack(readAt(fd, rootOff, rootLen), internal));
    for (let depth = 0; depth < 4; depth++) {
      const e = findEntry(dir, id);
      if (!e) return null;
      if (e.run > 0) return unpack(readAt(fd, dataOff + e.offset, e.length), tiles);
      dir = parseDirectory(unpack(readAt(fd, leafOff + e.offset, e.length), internal));
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/** A road line of a tile: its kind and its points in the tile's extent units. */
interface Road { kind: string; lines: [number, number][][]; extent: number }

function fields(b: Buffer, start: number, end: number): { tag: number; wire: number; num: number; from: number; to: number }[] {
  const out: { tag: number; wire: number; num: number; from: number; to: number }[] = [];
  const at = { i: start };
  while (at.i < end) {
    const key = varint(b, at);
    const tag = key >> 3;
    const wire = key & 7;
    if (wire === 0) { const num = varint(b, at); out.push({ tag, wire, num, from: 0, to: 0 }); }
    else if (wire === 2) { const len = varint(b, at); out.push({ tag, wire, num: 0, from: at.i, to: at.i + len }); at.i += len; }
    else if (wire === 1) at.i += 8;
    else if (wire === 5) at.i += 4;
    else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
  return out;
}

/** The road lines of the `roads` layer of a tile (Protomaps schema); every other layer is skipped. */
export function decodeRoads(tile: Buffer): Road[] {
  const roads: Road[] = [];
  for (const layer of fields(tile, 0, tile.length).filter((f) => f.tag === 3 && f.wire === 2)) {
    const lf = fields(tile, layer.from, layer.to);
    const name = lf.find((f) => f.tag === 1)!;
    if (tile.toString('utf8', name.from, name.to) !== 'roads') continue;
    const extent = lf.find((f) => f.tag === 5)?.num ?? 4096;
    const keys = lf.filter((f) => f.tag === 3).map((f) => tile.toString('utf8', f.from, f.to));
    const values = lf.filter((f) => f.tag === 4).map((f) => {
      const s = fields(tile, f.from, f.to).find((x) => x.tag === 1);
      return s ? tile.toString('utf8', s.from, s.to) : '';
    });
    for (const feat of lf.filter((f) => f.tag === 2)) {
      const ff = fields(tile, feat.from, feat.to);
      if (ff.find((f) => f.tag === 3)?.num !== 2) continue; // lines only
      let kind = '';
      const tags = ff.find((f) => f.tag === 2);
      if (tags) {
        const at = { i: tags.from };
        while (at.i < tags.to) {
          const k = varint(tile, at);
          const v = varint(tile, at);
          if (keys[k] === 'kind') kind = values[v] ?? '';
        }
      }
      const geom = ff.find((f) => f.tag === 4);
      if (!geom) continue;
      const at = { i: geom.from };
      const lines: [number, number][][] = [];
      let cur: [number, number][] = [];
      let x = 0;
      let y = 0;
      while (at.i < geom.to) {
        const cmd = varint(tile, at);
        const op = cmd & 7;
        const count = cmd >> 3;
        for (let c = 0; c < count; c++) {
          if (op === 7) continue;
          const dx = varint(tile, at);
          const dy = varint(tile, at);
          x += (dx >> 1) ^ -(dx & 1);
          y += (dy >> 1) ^ -(dy & 1);
          if (op === 1) { if (cur.length > 1) lines.push(cur); cur = []; }
          cur.push([x, y]);
        }
      }
      if (cur.length > 1) lines.push(cur);
      roads.push({ kind, lines, extent });
    }
  }
  return roads;
}

const STROKE: Record<string, number> = { highway: 6, major_road: 4, medium_road: 3, minor_road: 2 };

const tileCoord = (p: PreviewPoint): { x: number; y: number } => {
  const n = 2 ** ZOOM;
  const rad = (p.lat * Math.PI) / 180;
  return { x: ((p.lon + 180) / 360) * n, y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n };
};

/**
 * The picture: roads from the PMTiles file `file` around `dest` (none when `file` is null or unreadable: the pin on its plain ground), the pin,
 * and the OpenStreetMap credit. A coordinate is never written into the markup: every point is a pixel of the picture.
 */
export function renderPreviewSvg(file: string | null, dest: PreviewPoint): string {
  const c = tileCoord(dest);
  const paths: string[] = [];
  const byWidth = new Map<number, string[]>();
  if (file) {
    try {
      const x0 = Math.floor(c.x - WIDTH / 2 / TILE_PX);
      const x1 = Math.floor(c.x + WIDTH / 2 / TILE_PX);
      const y0 = Math.floor(c.y - HEIGHT / 2 / TILE_PX);
      const y1 = Math.floor(c.y + HEIGHT / 2 / TILE_PX);
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const tile = readTile(file, ZOOM, tx, ty);
          if (!tile) continue;
          for (const road of decodeRoads(tile)) {
            if (!(road.kind in STROKE)) continue; // paths and service lanes are noise at this size
            const w = STROKE[road.kind]!;
            for (const line of road.lines) {
              const pts = line.map(([gx, gy]) => [Math.round((tx + gx / road.extent - c.x) * TILE_PX + WIDTH / 2), Math.round((ty + gy / road.extent - c.y) * TILE_PX + HEIGHT / 2)] as const);
              if (!pts.some(([px, py]) => px >= 0 && px <= WIDTH && py >= 0 && py <= HEIGHT)) continue;
              const d = pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px} ${py}`).join('');
              (byWidth.get(w) ?? byWidth.set(w, []).get(w)!).push(d);
            }
          }
        }
      }
      for (const [w, ds] of [...byWidth].sort((p, q) => p[0] - q[0])) paths.push(`<path d="${ds.join('')}" fill="none" stroke="#9aa3ad" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`);
    } catch {
      paths.length = 0; // an unreadable file leaves the pin on plain ground; the picture never fails the card
    }
  }
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">`
    + `<rect width="${WIDTH}" height="${HEIGHT}" fill="#eef1f4"/>${paths.join('')}`
    + `<circle cx="${cx}" cy="${cy}" r="9" fill="#d33" stroke="#fff" stroke-width="3"/>`
    + `<text x="${WIDTH - 6}" y="${HEIGHT - 6}" font-family="sans-serif" font-size="11" text-anchor="end" fill="#555">© OpenStreetMap</text></svg>`;
}
