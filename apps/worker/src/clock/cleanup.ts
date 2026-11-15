// SPDX-License-Identifier: AGPL-3.0-or-later
// Cleanup (SPECIFICATIONS section 2 background work: after a reset, and hourly real time). Deletes photo and signature
// files no row references, prunes delay samples older than 24 real hours and clock_move rows of earlier world epochs.
//
// The file sweep (F-474): applyBlob (packages/api-server/src/tech-items/blob.ts) renames a photo into place BEFORE its
// row commits, so for the length of a send a new file has no row. The sweep therefore leaves every file younger than
// CLEANUP_MIN_AGE_MS by its modification time, far longer than a send's transaction, and reads the referenced names
// after it has listed the folder: a row committed between the 2 reads only keeps a file. Files sit at
// PHOTOS_DIR/<yyyy-mm>/<name> (blobFile); a temp file a crashed write left behind is unreferenced and old, so it goes too.
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { createPool } from '@bw/db';

type Pool = ReturnType<typeof createPool>;

/** Files younger than this are never swept (F-474: older than any send's transaction). */
export const CLEANUP_MIN_AGE_MS = 10 * 60_000;
/** Section 2: hourly, besides after each confirmed reset. */
export const CLEANUP_EVERY_MS = 60 * 60_000;
/** SD-43 / FR-HLTH-3: delay samples are kept 24 real hours. */
export const DELAY_SAMPLE_KEEP_HOURS = 24;

export interface CleanupReport {
  filesDeleted: number;
  clockMovesPruned: number;
  delaySamplesPruned: number;
}

async function listFiles(dir: string): Promise<{ rel: string; mtimeMs: number }[]> {
  const out: { rel: string; mtimeMs: number }[] = [];
  let months: string[];
  try {
    months = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return out; // no photo was ever stored
    throw e;
  }
  for (const m of months) {
    const sub = path.join(dir, m);
    if (!(await stat(sub)).isDirectory()) continue;
    for (const f of await readdir(sub)) {
      const s = await stat(path.join(sub, f));
      if (s.isFile()) out.push({ rel: `${m}/${f}`, mtimeMs: s.mtimeMs });
    }
  }
  return out;
}

/** A stored file's small copy name (SD-32), the name api-server's thumbFile writes. The worker does not import the web's handlers. */
export const thumbOf = (file: string): string => `${file}.thumb.jpg`;

/** 1 cleanup run at real time `real` (record_stamp for the file ages and the delay samples). */
export async function cleanup(d: { pool: Pool; photosDir: string; real: Date }): Promise<CleanupReport> {
  const files = await listFiles(d.photosDir);
  const old = files.filter((f) => d.real.getTime() - f.mtimeMs >= CLEANUP_MIN_AGE_MS);
  let filesDeleted = 0;
  if (old.length > 0) {
    const refs = await d.pool.query<{ file: string }>('SELECT file FROM world.photo UNION SELECT file FROM world.signature UNION SELECT payload->>\'file\' FROM world.tech_item WHERE payload ? \'file\'');
    // SD-32: a photo's small copy (<file>.thumb.jpg, packages/api-server/src/tech-items/thumb.ts) is referenced by its photo's row.
    const referenced = new Set(refs.rows.flatMap((r) => [r.file, thumbOf(r.file)]));
    for (const f of old) {
      if (referenced.has(f.rel)) continue;
      await rm(path.join(d.photosDir, f.rel), { force: true });
      filesDeleted += 1;
    }
  }
  const moves = await d.pool.query(
    'DELETE FROM system.clock_move WHERE world_epoch < (SELECT world_epoch FROM system.demo_clock WHERE id = 1)');
  const samples = await d.pool.query(
    `DELETE FROM system.delay_sample WHERE emitted_real < $1::timestamptz - interval '${DELAY_SAMPLE_KEEP_HOURS} hours'`, [d.real]);
  return { filesDeleted, clockMovesPruned: moves.rowCount ?? 0, delaySamplesPruned: samples.rowCount ?? 0 };
}
