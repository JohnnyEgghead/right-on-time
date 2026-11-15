// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract rows of the import area (UI-SPECIFICATION 12.2 API-80 to API-88, 12.4; SPECIFICATIONS section 6.7, SD-24;
// FR-IMP-1 to FR-IMP-4, FR-IMP-6, FR-IMP-10, FR-IMP-11). P2-IMPORT builds them; P4-ADMIN-IMPORT's pages read them.
//
// API-80 and API-84 share POST /import/runs, told apart by `kind` (12.2: "with kind dry_run", "with kind real"): each row
// names its `selector`, and the kernel serves the shared route by it. Both answer 202 with the run id once the run is
// claimed; the run itself goes on in the worker's import runner (SPECIFICATIONS section 2 processes table), and API-81
// shows its stage, percent and report. API-83 answers a file (text/csv), not JSON.
import { z } from 'zod';
import { addressField, defineContract, phoneField, type ContractRow } from '../contract.ts';
import { cursorQuerySchema } from '../paging.ts';

/** An RFC 9557 time (UI-SPECIFICATION 12.1 item 5). */
const wireTime = z.string().min(1);
const count = z.number().int().nonnegative();

/** The 6 problem reasons (SPECIFICATIONS section 3 import_problem_row.reason; REQUIREMENTS FR-IMP-6 table). */
export const PROBLEM_REASON_KEYS = [
  'bad_phone', 'missing_zip', 'visit_no_customer', 'customer_name_blank', 'equipment_no_address', 'visit_date_unreadable',
] as const;
const reason = z.enum(PROBLEM_REASON_KEYS);
const runKind = z.enum(['dry_run', 'real']);
const runStatus = z.enum(['running', 'done', 'failed']);
const runStage = z.enum(['parse', 'validate', 'match', 'write']);

/** Who ran a run: setup, or a signed-in person (FR-IMP-10; API-82 "by (setup or user)"). */
const runBy = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('setup') }),
  z.object({ kind: z.literal('user'), userId: z.string(), name: z.string() }),
]);

/** The FR-IMP-6 counts of a finished run (REQUIREMENTS section 4.7's import target table). */
const runCounts = z.object({
  customers: z.object({ total: count, clean: count, flagged: count }),
  visits: z.object({ total: count, imported: count, notImported: count }),
  equipment: z.object({ total: count, imported: count, notImported: count }),
  problems: count,
  duplicates: z.object({ total: count, exact: count, likely: count }),
});

/**
 * A finished run's report (API-81, 12.4): the FR-IMP-6 counts and the problems by reason, each reason with its first 2
 * rows by row number as examples. An example is the stored `import_problem_row.example` (for example "Earl Mott: (614)
 * 555-01") and the reason's catalog `words` in the caller's language (FR-LANG-3, F-259): the page shows them one after
 * the other, so no stored English reaches a Spanish page.
 */
const report = runCounts.extend({
  problems: z.object({
    total: count,
    byReason: z.array(z.object({
      reason,
      count,
      examples: z.array(z.object({ file: z.string(), rowNumber: z.number().int().positive(), example: z.string(), words: z.string() })).max(2),
    })),
  }),
});

const runId = z.object({ runId: z.uuid() });

export const startDryRun = defineContract({
  id: 'API-80',
  name: 'Start a dry run',
  method: 'POST',
  path: '/import/runs',
  request: z.object({ kind: z.literal('dry_run') }),
  response: runId,
  successStatus: [202],
  selector: { field: 'kind', value: 'dry_run' },
  errors: ['run_in_progress'],
  labels: [],
  examples: [{ name: 'signed out', input: { kind: 'dry_run' }, expectStatus: 401 }],
});

export const importRun = defineContract({
  id: 'API-81',
  name: 'Import run',
  method: 'GET',
  path: '/import/runs/{runId}',
  request: runId,
  response: z.object({
    kind: runKind,
    status: runStatus,
    stage: runStage,
    percent: z.number().int().min(0).max(100),
    /** Set when the run is done; null while it runs and for a failed run. */
    report: report.nullable(),
    /** Set when the run failed: the code it stopped with (import_run.report.error, for example attempts_exhausted, generator_manifest, import_failed); null otherwise (F-521). */
    failure: z.string().nullable(),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { runId: '00000000-0000-7000-8000-000000000000' }, expectStatus: 401 }],
});

const runSummary = z.object({
  runId: z.string(),
  kind: runKind,
  startedAt: wireTime,
  finishedAt: wireTime.nullable(),
  /** When the old system's export was made (12.4; import_run.source_exported_at), null when the export does not say. */
  sourceExportedAt: wireTime.nullable(),
  by: runBy,
  status: runStatus,
  /** A done run's FR-IMP-6 counts; null while it runs and for a failed run. */
  counts: runCounts.nullable(),
});

export const importRuns = defineContract({
  id: 'API-82',
  name: 'Import runs',
  method: 'GET',
  path: '/import/runs',
  request: z.object({}),
  response: z.object({
    /** Every run of this world, newest first, the setup runs among them (FR-IMP-10). */
    runs: z.array(runSummary),
    /** The world's done real run (at most 1, FR-IMP-10), or null: Run the import is offered only when this is null. */
    realRun: z.object({ runId: z.string(), by: runBy, finishedAt: wireTime }).nullable(),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', expectStatus: 401 }],
});

export const PROBLEM_LIST_COLUMNS = ['file', 'row_number', 'reason', 'example'] as const;

export const problemList = defineContract({
  id: 'API-83',
  name: 'Problem list',
  method: 'GET',
  path: '/import/runs/{runId}/problems',
  request: runId,
  /** The CSV text: a header row of PROBLEM_LIST_COLUMNS, then every problem row of the run by file and row number. */
  response: z.string(),
  envelope: false,
  file: { contentType: 'text/csv', name: 'problem-list.csv' },
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { runId: '00000000-0000-7000-8000-000000000000' }, expectStatus: 401 }],
});

export const startRealRun = defineContract({
  id: 'API-84',
  name: 'Start the real run',
  method: 'POST',
  path: '/import/runs',
  request: z.object({ kind: z.literal('real') }),
  response: runId,
  successStatus: [202],
  selector: { field: 'kind', value: 'real' },
  errors: ['run_in_progress', 'real_run_exists'],
  labels: [],
  examples: [{ name: 'signed out', input: { kind: 'real' }, expectStatus: 401 }],
});

/** yyyy-mm-dd. */
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * 1 customer record of a pair, for the side-by-side view: the record fields of UI-SPECIFICATION v0.13 API-85, 1 per row of
 * CTL-OFC-14-06 (owner ruling d9901466 "Match the design fully"). No email: the shown pair draws no Email row (F-870).
 */
const pairRecord = z.object({
  customerId: z.string(),
  /** The old system's customer number (SPECIFICATIONS v0.11 section 3 customer.old_customer_number): the row's customers.csv customer_ref as written; null for a customer the import did not write. */
  oldCustomerNumber: z.string().nullable(),
  name: z.string(),
  /** House number and street, for example "2240 Riverside Dr". */
  street: addressField(),
  city: addressField(),
  /** The state's 2-letter code, for example "OH": every branch is in Ohio (REQUIREMENTS section 1), and no table stores a state. */
  state: z.string().length(2),
  zip: addressField(),
  /** Each number with its kind, the mobile first (CTL-OFC-14-06 Phone row: "(614) 555-0163 - mobile"); empty when the record has none. */
  phones: z.array(z.object({ number: phoneField(), kind: z.enum(['mobile', 'home']) })),
  textLanguage: z.enum(['en', 'es']),
  /** yyyy-mm-dd in the branch's zone. */
  customerSince: localDate,
  branchId: z.string(),
  /** Comfort Club member (a membership row) or none. */
  plan: z.enum(['comfort_club', 'none']),
  /** The getting-in notes (customer.getting_in), null for none. */
  notes: z.string().nullable(),
  /** Each piece, in the order it was written: type, year and details (CTL-OFC-14-06 Equipment row). */
  equipment: z.array(z.object({ type: z.string(), year: z.number().int().nullable(), details: z.string().nullable() })),
  /**
   * The record's visits: its past visits together with its done jobs (SPECIFICATIONS section 6.2): the count, the first and last
   * visit's dates (the page shows their months) and the last visit's service and date; first, last and lastVisit are null with none.
   * lastVisit.service is the old visit's service text, or the done job's service id (serviceId set) the page names from the catalog.
   */
  visits: z.object({
    count,
    first: localDate.nullable(),
    last: localDate.nullable(),
    lastVisit: z.object({ date: localDate, service: z.string(), serviceId: z.string().nullable() }).nullable(),
  }),
});

const pairStatus = z.enum(['listed', 'merged', 'kept_separate', 'skipped']);

export const duplicatePair = z.object({
  pairId: z.string(),
  recordA: pairRecord,
  recordB: pairRecord,
  /** Why the pair was listed: the reason key (duplicate_pair.why). */
  whyListed: z.string(),
  status: pairStatus,
  decidedBy: z.object({ userId: z.string(), name: z.string() }).nullable(),
  /** What Merge keeps (12.4; CTL-OFC-14-11): record A's name and both records' visits and equipment together. */
  mergePreview: z.object({ keptName: z.string(), visits: count, equipment: count }),
});

export const likelyDuplicates = defineContract({
  id: 'API-85',
  name: 'Likely duplicates',
  method: 'GET',
  path: '/import/duplicates',
  request: cursorQuerySchema.extend({
    /** The Show select (CTL-OFC-14-02): To check (listed), Merged, Kept separate, Skipped, All. Default To check. */
    status: z.enum(['to_check', 'merged', 'kept_separate', 'skipped', 'all']).default('to_check'),
  }),
  response: z.object({
    /** CTL-OFC-14-01 over every pair on the review page (the likely pairs and the undone exact pairs, F-265): listed (all of them), checked (merged or kept separate), left, and each status. */
    progress: z.object({ listed: count, checked: count, left: count, merged: count, keptSeparate: count, skipped: count }),
    pairs: z.array(duplicatePair),
    next: z.string().nullable(),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', expectStatus: 401 }],
});

export const decidePair = defineContract({
  id: 'API-86',
  name: 'Decide a pair',
  method: 'POST',
  path: '/import/duplicates/{pairId}/decision',
  request: z.object({ pairId: z.uuid(), decision: z.enum(['merge', 'keep_separate', 'skip']) }),
  response: z.object({ pair: duplicatePair, mergeId: z.string().nullable() }),
  errors: ['already_decided'],
  labels: [],
  examples: [{ name: 'signed out', input: { pairId: '00000000-0000-7000-8000-000000000000', decision: 'skip' }, expectStatus: 401 }],
});

const mergeItem = z.object({
  mergeId: z.string(),
  /** Record A (kept) and record B (merged into A, or restored by an undo). */
  records: z.object({
    a: z.object({ customerId: z.string(), name: z.string() }),
    b: z.object({ customerId: z.string(), name: z.string() }),
  }),
  /** The kept record's (record A's) house number, street and city, for example "57 Kenwick Rd, Upper Arlington" (CTL-OFC-15-04). */
  address: addressField(),
  /** exact: the run's Exact match (import); office: an Office decision (API-86). */
  kind: z.enum(['exact', 'office']),
  at: wireTime,
  status: z.enum(['active', 'undone']),
});

export const merges = defineContract({
  id: 'API-87',
  name: 'Merges',
  method: 'GET',
  path: '/import/merges',
  request: cursorQuerySchema.extend({
    /** Find a merge (CTL-OFC-15-03): part of either record's name, folded as customer names are. */
    name: z.string().trim().max(100).optional(),
  }),
  response: z.object({
    merges: z.array(mergeItem),
    next: z.string().nullable(),
    /** Every merge the name search matches, all merges with none (owner ruling d9901466; "Showing 5 of 1,206 merges", CTL-OFC-15-04). */
    total: count,
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', expectStatus: 401 }],
});

export const undoMerge = defineContract({
  id: 'API-88',
  name: 'Undo a merge',
  method: 'POST',
  path: '/import/merges/{mergeId}/undo',
  request: z.object({ mergeId: z.uuid() }),
  response: z.object({ merge: mergeItem, restored: z.array(z.string()) }),
  errors: ['already_undone'],
  labels: [],
  examples: [{ name: 'signed out', input: { mergeId: '00000000-0000-7000-8000-000000000000' }, expectStatus: 401 }],
});

export const importContracts: ContractRow[] = [
  startDryRun, importRun, importRuns, problemList, startRealRun, likelyDuplicates, decidePair, merges, undoMerge,
];
