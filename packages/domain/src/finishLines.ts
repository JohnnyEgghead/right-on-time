// SPDX-License-Identifier: AGPL-3.0-or-later
// The finish-lines validator (SPECIFICATIONS section 6.6 FR-BILL-3, D9; invariant 10). Every path that finishes a job
// (API-26 office finish, API-62 Correct the finish, API-102's finish item) runs it before it writes the finish: a
// finish carries its parts, each picked from the fixed seeded parts list with a quantity, or "No parts used", never
// neither. Pure: the caller passes the lookup of the seeded part ids it read in its own transaction.

export interface FinishPartInput {
  partId: string;
  quantity: number;
}

export interface FinishLinesInput {
  parts: readonly FinishPartInput[];
  noPartsUsed: boolean;
  laborMinutes: number;
}

export type FinishLinesCode = 'parts_required' | 'validation_failed';

export type FinishLinesResult =
  | { ok: true; lines: { parts: FinishPartInput[]; noPartsUsed: boolean; laborMinutes: number } }
  | { ok: false; code: FinishLinesCode; field: 'parts' | 'noPartsUsed' | 'laborMinutes'; problem: FinishLinesProblem };

/** Why a finish was refused, as a fixed word (the page maps it to catalog copy; never free text). */
export type FinishLinesProblem =
  | 'neither_parts_nor_no_parts_used'
  | 'parts_and_no_parts_used'
  | 'part_not_on_list'
  | 'part_listed_twice'
  | 'quantity_not_whole_at_least_1'
  | 'labor_not_whole_minutes';

/** The longest labor a finish can carry: 1 demo day in minutes. */
export const MAX_LABOR_MINUTES = 24 * 60;
/** The most of 1 part a finish may carry (job_part.quantity is an integer column; F-469). */
export const MAX_PART_QUANTITY = 10_000;

const refuse = (code: FinishLinesCode, field: 'parts' | 'noPartsUsed' | 'laborMinutes', problem: FinishLinesProblem): FinishLinesResult =>
  ({ ok: false, code, field, problem });

/**
 * Validate a finish's lines. Refuses neither parts nor No parts used with `parts_required`; both together, a part not
 * on the seeded list, a part listed twice (job_part's key is the job and the part), a quantity below 1, above MAX_PART_QUANTITY or not whole,
 * and labor that is not whole minutes from 0 to 1 day, each with `validation_failed`.
 */
export function finishLines(input: FinishLinesInput, isSeededPart: (partId: string) => boolean): FinishLinesResult {
  const parts = input.parts;
  if (parts.length === 0 && input.noPartsUsed !== true) return refuse('parts_required', 'parts', 'neither_parts_nor_no_parts_used');
  if (parts.length > 0 && input.noPartsUsed === true) return refuse('validation_failed', 'noPartsUsed', 'parts_and_no_parts_used');
  const seen = new Set<string>();
  for (const p of parts) {
    if (!isSeededPart(p.partId)) return refuse('validation_failed', 'parts', 'part_not_on_list');
    if (seen.has(p.partId)) return refuse('validation_failed', 'parts', 'part_listed_twice');
    seen.add(p.partId);
    if (!Number.isInteger(p.quantity) || p.quantity < 1 || p.quantity > MAX_PART_QUANTITY) return refuse('validation_failed', 'parts', 'quantity_not_whole_at_least_1');
  }
  const m = input.laborMinutes;
  if (!Number.isInteger(m) || m < 0 || m > MAX_LABOR_MINUTES) return refuse('validation_failed', 'laborMinutes', 'labor_not_whole_minutes');
  return { ok: true, lines: { parts: parts.map((p) => ({ partId: p.partId, quantity: p.quantity })), noPartsUsed: parts.length === 0, laborMinutes: m } };
}

/**
 * The same rule over a finish already stored (job_part rows and job.no_parts_used): true when the job carries parts or
 * No parts used. The billing link checks it when a finish enters billing, so a finish path that skipped the validator
 * is refused in its own transaction rather than billed with no parts line.
 */
export function storedFinishHasLines(partRows: number, noPartsUsed: boolean): boolean {
  return partRows > 0 || noPartsUsed;
}
