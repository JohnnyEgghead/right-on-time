// SPDX-License-Identifier: AGPL-3.0-or-later
// The office finish (UI-SPECIFICATION 12.2 API-26, SCR-OFC-22 finish mode; SPECIFICATIONS section 6.6 FR-BILL-1,
// FR-BILL-3, invariant 10; section 3 writer table: finishJobOffice writes status done, billing_state sending and a
// job_change row of kind status_set). In order, inside the handler's 1 transaction (SD-6):
//
//   1. lines    @bw/domain's finishLines validator, before anything else (FR-BILL-3: 1 rule on every finish path), so a
//               finish with neither parts nor No parts used answers parts_required and writes nothing
//   2. lock     the assigned technician's day (section 5.3 step 2: a status change re-plans that day)
//   3. gate     the version gate (gatedJobUpdate): status done, ended_at, labor and No parts used, version + 1
//   4. rule     the 1 status rule of the office job writes: Done, No one home and Canceled refuse (F-505, RULE.jobClosed)
//   5. lines    the job_part rows; an office finish carries no work-done lines (OI-35)
//   6. effects  the day settles without the job; a live map link ends and an unsent on-the-way text is canceled, as at a
//               technician's finish (FR-TEXT-4); 1 job_change row `status_set` by the person; the billing item
//               (billFinishedJob, section 6.6), whose billing.send the billing link runs after commit; 1 notice
import { publishEvent, type Queryable } from '@bw/db';
import { finishLines } from '@bw/domain';
import { Temporal } from '@bw/time';
import { billFinishedJob } from 'bw-worker/billing';
import { endOnTheWay } from '../tech-items/effects.ts';
import { settleDay } from './day.ts';
import { lockTechnicianDays } from './locks.ts';
import { answerJobForWrite, appendJobChange, gatedJobUpdate, readJobForWrite, refuseClosed, WriteRefused, type WriteContext, type WrittenJob } from './service.ts';

export interface OfficeFinishInput {
  jobNumber: number;
  parts: readonly { partId: string; quantity: number }[];
  noPartsUsed: boolean;
  laborMinutes: number;
  baseVersion: number;
}

export interface OfficeFinished {
  job: WrittenJob;
  billing: { state: string };
}

/** finishJobOffice (API-26): finish a visit from the office; the job then flows to billing (FR-BILL-1). */
export async function finishJobOffice(tx: Queryable, ctx: WriteContext, input: OfficeFinishInput): Promise<OfficeFinished> {
  const seeded = new Set((await tx.query<{ id: string }>('SELECT id::text FROM world.part')).rows.map((p) => p.id));
  const lines = finishLines({ parts: input.parts, noPartsUsed: input.noPartsUsed, laborMinutes: input.laborMinutes }, (id) => seeded.has(id));
  if (!lines.ok) throw new WriteRefused(lines.code, `the office finish is refused (${lines.problem})`);

  const job = await readJobForWrite(tx, input.jobNumber);
  if (!job) throw new WriteRefused('not_found', `job ${input.jobNumber} does not exist`);
  const days = job.technician_id === null ? [] : [{ technicianId: job.technician_id, date: job.date }];
  await lockTechnicianDays(tx, days);
  await gatedJobUpdate(tx, job.job_number, input.baseVersion,
    `status = 'done', ended_at = $3, planned_arrival = NULL, labor_minutes = $4, no_parts_used = $5`,
    [ctx.at, lines.lines.laborMinutes, lines.lines.noPartsUsed]);
  // The gate passed, so the job read above is the version the caller saw: its status is current.
  refuseClosed(job);
  for (const p of lines.lines.parts) {
    await tx.query('INSERT INTO world.job_part (job_number, part_id, quantity) VALUES ($1, $2, $3)', [job.job_number, p.partId, p.quantity]);
  }
  // A finish removes the job from the day's plan; like a removal (cancelJob, F-504) it never refuses for the plan it shifts.
  for (const d of days) await settleDay(tx, d);
  const at = Temporal.Instant.fromEpochMilliseconds(ctx.at.getTime());
  await endOnTheWay(tx, { jobNumber: job.job_number, at });
  await appendJobChange(tx, ctx, {
    jobNumber: job.job_number, kind: 'status_set', fromVersion: input.baseVersion, toVersion: input.baseVersion + 1,
    data: {
      from: { status: job.status }, to: { status: 'done' },
      parts: lines.lines.parts.length, noPartsUsed: lines.lines.noPartsUsed, laborMinutes: lines.lines.laborMinutes,
    },
  });
  const billed = await billFinishedJob(tx, { jobNumber: job.job_number, at });
  if (!billed.queued) throw new Error(`job ${job.job_number} did not enter billing (${billed.why})`);
  await publishEvent(tx, 'job.changed', { jobNumber: job.job_number, branch: job.branch_id });
  const state = (await tx.query<{ billing_state: string }>('SELECT billing_state FROM world.job WHERE job_number = $1', [job.job_number])).rows[0]!.billing_state;
  return { job: await answerJobForWrite(tx, job.job_number), billing: { state } };
}
