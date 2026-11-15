// SPDX-License-Identifier: AGPL-3.0-or-later
// applyBlob (API-103; SPECIFICATIONS section 5.1 steps 1 and 3, section 6.3 FR-TECH-3 and FR-TECH-14, SD-32; invariant 1):
// a photo or signature under the same key and world-epoch rules as an item. Photos and signatures always apply (the
// Add photo row of the conflict table), so no change is classified. The file is written write-once under
// PHOTOS_DIR/<yyyy-mm>/<key>: to a temp name in that folder, flushed, then renamed into place, and only then are the
// photo (or signature) row and the ledger row written, in the same transaction (F-67). So:
//   - a failed file write fails the call (5xx) with no ledger row: the phone keeps the blob and its retry stores it;
//   - a crash after the rename and before the commit leaves a file no row references; the next send of the key finds
//     no row and renames its own copy over it (nothing references the old one; same key, same bytes), and Cleanup's
//     hourly sweep deletes files no row references (section 2; it must leave files younger than a send's transaction).
// A second signature for a job that has one (the other app's copy) answers duplicate: 1 signature per job (section 3).
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { publishEvent, type Queryable } from '@bw/db';
import { PHOTO_MAX_BYTES, SIGNATURE_MAX_BYTES } from '@bw/api';
import {
  appendTechnicianChange, isTechniciansJob, lockJob, lockKey, placeOnClock, recordItem, storedAnswer, wireAt,
  jobExists, type Answer, type ItemContext, type ItemFacts,
} from './shared.ts';
import { MESSAGE, flagRefused, type FlagCode } from './apply.ts';
import { thumbErrorCode, writeThumb } from './thumb.ts';
import type { Logger } from '@bw/log';

export type BlobKind = 'photo' | 'signature';

export interface BlobUpload extends ItemFacts {
  kind: BlobKind;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * F-931: every outcome is an answer (SPECIFICATIONS 5.1 step 10; owner ruling 546d6f1e). A refusal the phone cannot fix
 * (validation_failed, not_found) is answered flagged with its code and listed for the dispatcher, like an item's, so the
 * photo or signature leaves the phone; `code` is that code, null for every other answer.
 */
export type BlobOutcome = { ok: true; answer: Answer; code: FlagCode | null };

/** Pixel size of a JPEG (its first SOF frame header) or a PNG (its IHDR); null when the bytes are neither. */
export function imageSize(bytes: Uint8Array, type: string): { width: number; height: number } | null {
  const b = bytes;
  if (type === 'image/png') {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (b.length < 24 || sig.some((v, i) => b[i] !== v)) return null;
    if (String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== 'IHDR') return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (type === 'image/jpeg') {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) { i += 1; continue; }
      // F-1276: TEM (01) and RST0..RST7 (D0..D7) carry no length, and libjpeg accepts them before the frame header.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = (b[i + 2]! << 8) | b[i + 3]!;
      // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
      }
      if (marker === 0xd9 || marker === 0xda) return null;
      i += 2 + len;
    }
  }
  return null;
}

/** The kind's own type and size limit (SD-32: a JPEG photo up to 10 MB, a PNG signature up to 512 KB). */
const LIMITS: Record<BlobKind, { type: string; maxBytes: number }> = {
  photo: { type: 'image/jpeg', maxBytes: PHOTO_MAX_BYTES },
  signature: { type: 'image/png', maxBytes: SIGNATURE_MAX_BYTES },
};

/** The relative file name of a blob: <yyyy-mm>/<key> (SD-32), the month of its receipt by the demo clock, in UTC. */
export const blobFile = (key: string, receivedIso: string): string => `${receivedIso.slice(0, 7)}/${key.toLowerCase()}`;

/** Flush a folder's entries to disk (a rename or a new subfolder is durable only after this). */
async function fsyncDir(dir: string): Promise<void> {
  const h = await open(dir, 'r');
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}

/** Write-once into the photo volume: temp name, flush, rename (section 2 storage table). Throws on any failure. */
export async function writeBlobFile(dir: string, file: string, bytes: Uint8Array): Promise<void> {
  const final = path.join(dir, file);
  const created = await mkdir(path.dirname(final), { recursive: true });
  // F-471: a new month folder's entry in its parent is flushed too, or a crash after the commit could lose the folder.
  if (created) await fsyncDir(path.dirname(created));
  const temp = path.join(path.dirname(final), `.${path.basename(final)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const h = await open(temp, 'wx', 0o640);
    try {
      await h.writeFile(bytes);
      await h.sync();
    } finally {
      await h.close();
    }
    await rename(temp, final);
    // F-471: flush the folder entry the rename made, before the photo and tech_item rows commit and the phone is answered.
    await fsyncDir(path.dirname(final));
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
}

/**
 * SD-32: a stored photo's small copy, made in the request that stores the photo. A failure here never fails the send (the photo
 * is the item, and the phone must not resend it forever); API-175's first thumb read makes the copy again. A photo over the copy's
 * pixel limit (F-1265) is skipped before any decode and logged photo_thumb_too_large.
 */
async function storeThumb(photosDir: string, file: string, bytes: Uint8Array, log: Logger | undefined): Promise<void> {
  try {
    await writeThumb(photosDir, file, bytes);
  } catch (e) {
    log?.warn({ contract: 'API-103', errorCode: thumbErrorCode(e) });
  }
}

export async function applyBlob(tx: Queryable, ctx: ItemContext, photosDir: string, up: BlobUpload, log?: Logger): Promise<BlobOutcome> {
  const limit = LIMITS[up.kind];
  await lockKey(tx, up.key);
  const stored = await storedAnswer(tx, up.key);
  if (stored) return { ok: true, answer: stored, code: null };
  const facts: ItemFacts = { ...up, baseVersion: null };
  const flag = async (code: FlagCode, keep = false): Promise<BlobOutcome> => {
    // F-1168 (owner ruling 21ce2f73, "Keep them too"): a refusal the phone cannot fix keeps the image for the dispatcher. Written before the rows, like an upload.
    let kept: ItemFacts = facts;
    if (keep) {
      const file = blobFile(up.key, ctx.receivedAt.toString());
      await writeBlobFile(photosDir, file, up.bytes);
      if (up.kind === 'photo') await storeThumb(photosDir, file, up.bytes, log);
      kept = Object.assign({}, facts, { keptFile: file });
    }
    const d = await flagRefused(tx, ctx, kept, code, await lockJob(tx, up.jobNumber));
    const a = d.answer;
    return { ok: true, answer: { result: a.result as Answer['result'], messageKey: a.messageKey, values: a.values }, code: a.result === 'flagged' ? a.code : null };
  };
  const size = up.contentType !== limit.type || up.bytes.byteLength > limit.maxBytes || up.bytes.byteLength === 0 ? null : imageSize(up.bytes, up.contentType);
  if (!size) return flag('validation_failed');

  if (up.worldEpoch !== ctx.worldEpoch) {
    // F-1171 (owner ruling 21ce2f73): a valid image from a future epoch is kept too; the phone cannot fix it (SPECIFICATIONS 5.1 step 10).
    if (up.worldEpoch > ctx.worldEpoch) return flag('validation_failed', true);
    const a: Answer = { result: 'world_reset', messageKey: MESSAGE.worldReset, values: null };
    if (!(await jobExists(tx, up.jobNumber))) return { ok: true, answer: a, code: null };
    await recordItem(tx, ctx, facts, null, a);
    return { ok: true, answer: a, code: null };
  }
  const job = await lockJob(tx, up.jobNumber);
  if (!job || !(await isTechniciansJob(tx, job, ctx.technician.id))) return flag('not_found', true);
  const placed = await placeOnClock(tx, facts, ctx);

  if (up.kind === 'signature') {
    const has = await tx.query('SELECT 1 FROM world.signature WHERE job_number = $1', [job.jobNumber]);
    if ((has.rowCount ?? 0) > 0) {
      const a: Answer = { result: 'duplicate', messageKey: null, values: null };
      await recordItem(tx, ctx, facts, placed, a);
      return { ok: true, answer: a, code: null };
    }
  }

  const file = blobFile(up.key, ctx.receivedAt.toString());
  await writeBlobFile(photosDir, file, up.bytes);
  if (up.kind === 'photo') {
    await storeThumb(photosDir, file, up.bytes, log);
    await tx.query(
      `INSERT INTO world.photo (key, job_number, technician_id, file, bytes, sha256, width, height, entered_at, device_time_real, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [up.key, job.jobNumber, ctx.technician.id, file, up.bytes.byteLength, createHash('sha256').update(up.bytes).digest(), size.width, size.height,
        placed.at.toString(), up.deviceTime.toString(), ctx.receivedAt.toString()]);
  } else {
    const customer = (await tx.query<{ name: string }>('SELECT c.name FROM world.customer c WHERE c.id = $1', [job.customerId])).rows[0]?.name ?? '';
    await tx.query(
      `INSERT INTO world.signature (key, job_number, signed_by_name, signed_at, file, sent_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [up.key, job.jobNumber, customer, placed.at.toString(), file, ctx.receivedAt.toString()]);
  }
  await appendTechnicianChange(tx, ctx, {
    jobNumber: job.jobNumber, at: placed.at, kind: up.kind === 'photo' ? 'photo_added' : 'signature_added', fromVersion: job.version, toVersion: job.version,
    data: { key: up.key, offlineAt: wireAt(placed.at, job.zone), sentAt: wireAt(ctx.receivedAt, job.zone), rebased: placed.rebased },
  });
  await publishEvent(tx, 'job.changed', { jobNumber: job.jobNumber, branch: job.branchId });
  const a: Answer = { result: 'applied', messageKey: null, values: null };
  if (!(await recordItem(tx, ctx, facts, placed, a))) throw new Error(`tech_item ${up.key} was stored by another send under its lock`);
  return { ok: true, answer: a, code: null };
}
