// SPDX-License-Identifier: AGPL-3.0-or-later
// reportSync (API-162; SPECIFICATIONS section 6.2 FR-DISP-33, section 5.1 step 2; FR-TECH-7): after each send and each
// open with signal, the app reports its waiting count and its own last sync time; the server keeps the last report per
// technician and app (upsert), stamped with the demo time it arrived. Re-run: a repeated report rewrites the same row.
import type { Queryable } from '@bw/db';
import type { Instant } from '@bw/time';

export async function reportSync(tx: Queryable, input: {
  technicianId: string; app: 'web' | 'native'; waitingCount: number; lastSyncReal: Instant; device: string; version: string; receivedAt: Instant;
}): Promise<void> {
  await tx.query(
    `INSERT INTO world.app_sync_report (technician_id, app, last_sync_real, waiting_count, device, version, reported_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (technician_id, app) DO UPDATE SET last_sync_real = EXCLUDED.last_sync_real, waiting_count = EXCLUDED.waiting_count,
       device = EXCLUDED.device, version = EXCLUDED.version, reported_at = EXCLUDED.reported_at`,
    [input.technicianId, input.app, input.lastSyncReal.toString(), input.waitingCount, input.device, input.version, input.receivedAt.toString()]);
}
