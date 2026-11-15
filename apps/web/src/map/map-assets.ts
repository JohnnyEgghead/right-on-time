// SPDX-License-Identifier: AGPL-3.0-or-later
// The map's bundled glyph and sprite files (F-452; SPECIFICATIONS 6.10, SD-39): Protomaps' Noto Sans glyph ranges (OFL-1.1, the
// license text beside them) and the light sprite sheet (MIT), kept under ./assets and answered on the page's own origin at
// /map-assets/. The web process serves them before the page gate: they are public map furniture, like /_next/static.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const MAP_ASSET_PREFIX = '/map-assets/';
export const MAP_ASSETS_DIR = path.resolve(import.meta.dirname, 'assets');

const TYPES: Record<string, string> = {
  '.pbf': 'application/x-protobuf',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

/** The file a /map-assets/ path names and its media type, or null (not a file of the bundled set, or a path that leaves it). */
export function mapAsset(pathname: string, dir = MAP_ASSETS_DIR): { file: string; type: string } | null {
  if (!pathname.startsWith(MAP_ASSET_PREFIX)) return null;
  let segments: string[];
  try {
    segments = pathname.slice(MAP_ASSET_PREFIX.length).split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segments.length === 0 || segments.some((s) => s === '' || s === '.' || s === '..' || /[/\\\u0000]/.test(s))) return null;
  const file = path.join(dir, ...segments);
  const type = TYPES[path.extname(file)];
  if (!type || !file.startsWith(dir + path.sep)) return null;
  try {
    return statSync(file).isFile() ? { file, type } : null;
  } catch {
    return null;
  }
}

/** The bytes of a bundled map file. */
export const readMapAsset = (file: string): Buffer => readFileSync(file);
