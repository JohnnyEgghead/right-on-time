// SPDX-License-Identifier: AGPL-3.0-or-later
// The autopilot of the sample day (SPECIFICATIONS SD-21, owner-confirmed OA-78; FR-DEMO-8's moving vans): 1 seeded
// `autopilot.step` event is 1 technician item (On my way, Arrived, Finished or No one home) applied through the same
// item path as the technician's own (applyItem), as that technician, at the event's time. A step is skipped, and does
// nothing, when a person touched the job (`touched_by_person`) or the job is not in the status the step expects. The
// event id is the item's key, so a rerun of the event is answered `duplicate` by the ledger and applies nothing twice.
// The worker's dispatcher calls this from its `autopilot.step` handler (apps/worker/src/autopilot).
import type { Queryable } from '@bw/db';
import type { TextContext } from '@bw/outbox';
import { realNow, type Instant } from '@bw/time';
import { applyItem, type QueuedItem } from './apply.ts';
import type { ItemContext, ItemFacts } from './shared.ts';

export const AUTOPILOT_STEP = 'autopilot.step';

export type AutopilotStepName = 'on_my_way' | 'arrived' | 'finished' | 'no_one_home';

/** The seed's payload (packages/setup/src/world-seed.ts): ids and codes only (NFR-05). */
export interface AutopilotPayload {
  jobNumber: number;
  technicianId: string;
  step: AutopilotStepName;
  laborMinutes?: number;
  partCodes?: string[];
}

/** The status a step expects the job to be in (SD-21: "the job is not in the step's expected prior status"). */
export const PRIOR_STATUS: Record<AutopilotStepName, string> = {
  on_my_way: 'scheduled', arrived: 'on_the_way', finished: 'on_site', no_one_home: 'on_site',
};

export interface AutopilotOutcome {
  state: 'done' | 'skipped';
  result: string;
}

const STEPS = new Set<string>(Object.keys(PRIOR_STATUS));

/** The stored event payload as a step this code can run, or null. */
export function parsePayload(p: Record<string, unknown>): AutopilotPayload | null {
  if (!Number.isInteger(p['jobNumber']) || typeof p['technicianId'] !== 'string' || typeof p['step'] !== 'string' || !STEPS.has(p['step'])) return null;
  return p as unknown as AutopilotPayload;
}

export async function runAutopilotStep(tx: Queryable, deps: TextContext, event: { id: string; payload: Record<string, unknown> }, now: Instant): Promise<AutopilotOutcome> {
  const step = parsePayload(event.payload);
  if (!step) return { state: 'skipped', result: 'bad_payload' };
  const j = (await tx.query<{ status: string; version: number; touched_by_person: boolean }>(
    'SELECT status, version, touched_by_person FROM world.job WHERE job_number = $1 FOR UPDATE', [step.jobNumber])).rows[0];
  if (!j) return { state: 'skipped', result: 'no_job' };
  if (j.touched_by_person) return { state: 'skipped', result: 'touched_by_person' };
  if (j.status !== PRIOR_STATUS[step.step]) return { state: 'skipped', result: 'not_in_prior_status' };
  const t = (await tx.query<{ id: string; user_id: string; name: string; name_in_texts: string; branch_id: string }>(
    'SELECT id, user_id, name, name_in_texts, branch_id FROM world.technician WHERE id = $1', [step.technicianId])).rows[0];
  if (!t) return { state: 'skipped', result: 'no_technician' };
  const epoch = (await tx.query<{ world_epoch: number }>('SELECT world_epoch FROM system.demo_clock WHERE id = 1')).rows[0]?.world_epoch ?? 1;
  const facts: ItemFacts = {
    key: event.id, jobNumber: step.jobNumber, kind: step.step, baseVersion: j.version, worldEpoch: epoch,
    deviceTime: now, offsetSavedReal: now, sinceSaveMs: 0, demoTime: now,
  };
  const item: QueuedItem = step.step === 'finished'
    ? { ...facts, kind: 'finished', finish: await finishOf(tx, step) }
    : { ...facts, kind: step.step };
  const ctx: ItemContext = {
    technician: { id: t.id, userId: t.user_id, name: t.name, nameInTexts: t.name_in_texts, branchId: t.branch_id },
    receivedAt: now, receivedReal: realNow('offline_entry'), worldEpoch: epoch, autopilot: true,
  };
  const out = await applyItem(tx, ctx, deps, item, [step.step], 'autopilot_step');
  return out.result === 'applied' ? { state: 'done', result: 'applied' } : { state: 'skipped', result: out.result };
}

/** The seeded parts (by code, 1 of each listed) and labor of a finish; no parts listed is No parts used. */
async function finishOf(tx: Queryable, step: AutopilotPayload): Promise<Extract<QueuedItem, { kind: 'finished' }>['finish']> {
  const codes = step.partCodes ?? [];
  const found = codes.length === 0 ? [] : (await tx.query<{ id: string; code: string }>('SELECT id::text, code FROM world.part WHERE code = ANY($1::text[])', [codes])).rows;
  const quantity = new Map<string, number>();
  for (const code of codes) {
    const part = found.find((p) => p.code === code);
    if (part) quantity.set(part.id, (quantity.get(part.id) ?? 0) + 1);
  }
  const parts = [...quantity].map(([partId, q]) => ({ partId, quantity: q }));
  return { parts, noPartsUsed: parts.length === 0, laborMinutes: step.laborMinutes ?? 0, workDone: [] };
}
