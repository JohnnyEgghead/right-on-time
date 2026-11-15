// SPDX-License-Identifier: AGPL-3.0-or-later
// Read a finished job's invoice source and compose it (SPECIFICATIONS section 6.6 FR-BILL-13, SD-20): the service and
// its invoice price, the job_part rows with each part's code, name and list price, the labor minutes, the work-done
// lines and the customer's Comfort Club membership. Read in the caller's transaction, at send time.
import type { Queryable } from '@bw/db';
import { composeInvoice, storedFinishHasLines, type InvoiceLine } from '@bw/domain';

export type Composed =
  | { ok: true; customerName: string; doneAt: string; lines: InvoiceLine[]; totalCents: number }
  | { ok: false; reason: string; customerName: string | null; doneAt: string | null };

export async function composeFromJob(tx: Queryable, jobNumber: number): Promise<Composed> {
  const j = await tx.query<{
    status: string; service_id: string; ended_at: Date | null; labor_minutes: number | null; no_parts_used: boolean;
    invoice_price_cents: number; customer_name: string; member: boolean;
  }>(
    `SELECT j.status, j.service_id, j.ended_at, j.labor_minutes, j.no_parts_used, s.invoice_price_cents, c.name AS customer_name,
            EXISTS (SELECT 1 FROM world.membership m WHERE m.customer_id = j.customer_id) AS member
       FROM world.job j JOIN world.service_type s ON s.id = j.service_id JOIN world.customer c ON c.id = j.customer_id
      WHERE j.job_number = $1`, [jobNumber]);
  const job = j.rows[0];
  if (!job) return { ok: false, reason: 'the job is not in this world', customerName: null, doneAt: null };
  const doneAt = job.ended_at ? job.ended_at.toISOString() : null;
  const fail = (reason: string): Composed => ({ ok: false, reason, customerName: job.customer_name, doneAt });
  if (job.status !== 'done' || doneAt === null) return fail('the job is not finished');
  if (job.labor_minutes === null) return fail('the finish has no labor time');
  const parts = await tx.query<{ code: string; name: string; price_cents: number; quantity: number }>(
    `SELECT p.code, p.name, p.price_cents, jp.quantity FROM world.job_part jp JOIN world.part p ON p.id = jp.part_id
      WHERE jp.job_number = $1 ORDER BY p.code`, [jobNumber]);
  if (!storedFinishHasLines(parts.rows.length, job.no_parts_used)) return fail('the finish has neither parts nor No parts used');
  const work = await tx.query<{ text: string }>('SELECT text FROM world.work_done_line WHERE job_number = $1 ORDER BY seq', [jobNumber]);
  const c = composeInvoice({
    jobNumber, customerName: job.customer_name, doneAt, serviceId: job.service_id, servicePriceCents: job.invoice_price_cents,
    parts: parts.rows.map((p) => ({ code: p.code, name: p.name, priceCents: p.price_cents, quantity: p.quantity })),
    laborMinutes: job.labor_minutes, workDone: work.rows.map((w) => w.text), member: job.member,
  });
  if (!c.ok) return fail(c.reason);
  return { ok: true, customerName: job.customer_name, doneAt, lines: c.lines, totalCents: c.totalCents };
}
