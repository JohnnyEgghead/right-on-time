// SPDX-License-Identifier: AGPL-3.0-or-later
// PMTiles v3 header reader (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md): the first 127 bytes.
// FR-MAP-4 checks a downloaded map file's bounding box against the committed manifest, so setup reads the header itself
// (no pmtiles CLI, no network).
import { closeSync, openSync, readSync } from 'node:fs';

export const HEADER_BYTES = 127;

export interface PmtilesHeader {
  version: number;
  minZoom: number;
  maxZoom: number;
  /** [minLon, minLat, maxLon, maxLat] in degrees (the header stores each as degrees x 1e7, an int32). */
  bbox: [number, number, number, number];
}

/** Parse a header. Throws a plain Error naming what is wrong (the caller adds the file name). */
export function parsePmtilesHeader(head: Buffer): PmtilesHeader {
  if (head.length < HEADER_BYTES) throw new Error(`header is ${head.length} bytes, want ${HEADER_BYTES}`);
  if (head.toString('latin1', 0, 7) !== 'PMTiles') throw new Error('no PMTiles magic');
  const version = head.readUInt8(7);
  if (version !== 3) throw new Error(`PMTiles version ${version}, want 3`);
  const e7 = (at: number): number => head.readInt32LE(at) / 1e7;
  return { version, minZoom: head.readUInt8(100), maxZoom: head.readUInt8(101), bbox: [e7(102), e7(106), e7(110), e7(114)] };
}

export function readPmtilesHeader(file: string): PmtilesHeader {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    const n = readSync(fd, head, 0, HEADER_BYTES, 0);
    return parsePmtilesHeader(head.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}
