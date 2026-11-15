// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of CMP-05 (P3-MAP-WEB) need the map to load, and the harness web app has no proxy in front of it, so
// /maps/<branch>.pmtiles would answer 404 there. This answers those requests from the repo's own verified map files
// (.build/data/maps, filled by `pnpm run setup:maps`) with the byte ranges the pmtiles protocol asks for, which is what the
// stack's proxy does (API-106). Nothing leaves the machine: it is a context route, answered locally.
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright';

const MAPS_DIR = process.env.MAPS_DIR ?? path.resolve(import.meta.dirname, '../../.build/data/maps');
const BRANCH_FILE = /^\/maps\/(columbus|dayton|springfield)\.pmtiles$/;

/** True when the 3 branch files are on disk (a look case that needs them says how to get them when they are not). */
export const mapFilesPresent = (): boolean => ['columbus', 'dayton', 'springfield'].every((b) => existsSync(path.join(MAPS_DIR, `${b}.pmtiles`)));

export async function serveMapFiles(context: BrowserContext): Promise<void> {
  await context.route('**/maps/*.pmtiles', async (route) => {
    const url = new URL(route.request().url());
    if (!BRANCH_FILE.test(url.pathname)) return route.continue();
    const file = path.join(MAPS_DIR, path.basename(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: 'missing' });
    const size = statSync(file).size;
    const m = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers()['range'] ?? '');
    const start = m ? Number(m[1]) : 0;
    const end = m ? Math.min(m[2] ? Number(m[2]) : size - 1, size - 1) : size - 1;
    const body = Buffer.alloc(end - start + 1);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, body, 0, body.length, start);
    } finally {
      closeSync(fd);
    }
    const headers = { 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream', 'content-length': String(body.length) };
    return m ? route.fulfill({ status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}` }, body }) : route.fulfill({ status: 200, headers, body });
  });
}
