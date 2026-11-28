// SPDX-License-Identifier: AGPL-3.0-or-later
// Cleanup (SPECIFICATIONS section 2 background work: after a reset, and hourly real time). Deletes photo and signature
// files no row references, prunes delay samples older than 24 real hours and clock_move rows of earlier world epochs.
//
// The file sweep (F-474): applyBlob (packages/api-server/src/tech-items/blob.ts) renames a photo into place BEFORE its
// row commits, so for the length of a send a new file has no row. The sweep therefore leaves every file younger than
// CLEANUP_MIN_AGE_MS by its modification time, far longer than a send's transaction, and reads the referenced names
// after it has listed the folder: a row committed between the 2 reads only keeps a file. Files sit at
// PHOTOS_DIR/<yyyy-mm>/<name> (blobFile); a temp file a crashed write left behind is unreferenced and old, so it goes too.
//
// F-2006 J-25: a file or month folder that vanishes between the listing and its stat (an earlier sweep, a reset's own
// cleanup) is skipped, never a throw that ends the run. The file sweep and the 2 prunes run independently: one that
// fails leaves the others done, and the run then throws its first failure, so a failed part never reads as 0 pruned.
import * as fsp from 'node:fs/promises';
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

/** The file calls the sweep makes (a test passes one whose file vanishes between the listing and its stat). */
export interface CleanupFs {
  readdir(dir: string): Promise<string[]>;
  stat(file: string): Promise<{ isDirectory(): boolean; isFile(): boolean; mtimeMs: number }>;
  rm(file: string, opts: { force: true }): Promise<void>;
}
const NODE_FS: CleanupFs = { readdir: (d) => fsp.readdir(d), stat: (f) => fsp.stat(f), rm: (f, o) => fsp.rm(f, o) };

/** The answer of `call`, or null when its path is gone (ENOENT); any other error is thrown. */
async function unlessGone<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw e;
  }
}

async function listFiles(fs: CleanupFs, dir: string): Promise<{ rel: string; mtimeMs: number }[]> {
  const out: { rel: string; mtimeMs: number }[] = [];
  const months = await unlessGone(() => fs.readdir(dir)); // null: no photo was ever stored
  for (const m of months ?? []) {
    const sub = path.join(dir, m);
    if (!(await unlessGone(() => fs.stat(sub)))?.isDirectory()) continue;
    for (const f of (await unlessGone(() => fs.readdir(sub))) ?? []) {
      const s = await unlessGone(() => fs.stat(path.join(sub, f)));
      if (s?.isFile()) out.push({ rel: `${m}/${f}`, mtimeMs: s.mtimeMs });
    }
  }
  return out;
}

/** A stored file's small copy name (SD-32), the name api-server's thumbFile writes. The worker does not import the web's handlers. */
export const thumbOf = (file: string): string => `${file}.thumb.jpg`;

async function sweepFiles(d: { pool: Pool; photosDir: string; real: Date }, fs: CleanupFs): Promise<number> {
  const files = await listFiles(fs, d.photosDir);
  const old = files.filter((f) => d.real.getTime() - f.mtimeMs >= CLEANUP_MIN_AGE_MS);
  let filesDeleted = 0;
  if (old.length > 0) {
    const refs = await d.pool.query<{ file: string }>('SELECT file FROM world.photo UNION SELECT file FROM world.signature UNION SELECT payload->>\'file\' FROM world.tech_item WHERE payload ? \'file\'');
    // SD-32: a photo's small copy (<file>.thumb.jpg, packages/api-server/src/tech-items/thumb.ts) is referenced by its photo's row.
    const referenced = new Set(refs.rows.flatMap((r) => [r.file, thumbOf(r.file)]));
    for (const f of old) {
      if (referenced.has(f.rel)) continue;
      await fs.rm(path.join(d.photosDir, f.rel), { force: true });
      filesDeleted += 1;
    }
  }
  return filesDeleted;
}

/** The answer of `call`, or its error: each part of a run runs whatever an earlier part did. */
async function settle<T>(call: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 1 cleanup run at real time `real` (record_stamp for the file ages and the delay samples). */
export async function cleanup(d: { pool: Pool; photosDir: string; real: Date; fs?: CleanupFs }): Promise<CleanupReport> {
  // 1 part at a time (the worker's pool is small, F-382), each run even when an earlier one failed.
  const files = await settle(() => sweepFiles(d, d.fs ?? NODE_FS));
  const moves = await settle(() => d.pool.query('DELETE FROM system.clock_move WHERE world_epoch < (SELECT world_epoch FROM system.demo_clock WHERE id = 1)'));
  const samples = await settle(() =>
    d.pool.query(`DELETE FROM system.delay_sample WHERE emitted_real < $1::timestamptz - interval '${DELAY_SAMPLE_KEEP_HOURS} hours'`, [d.real]));
  if (!files.ok) throw files.error;
  if (!moves.ok) throw moves.error;
  if (!samples.ok) throw samples.error;
  return { filesDeleted: files.value, clockMovesPruned: moves.value.rowCount ?? 0, delaySamplesPruned: samples.value.rowCount ?? 0 };
}
