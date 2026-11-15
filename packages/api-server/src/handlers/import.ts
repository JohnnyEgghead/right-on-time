// SPDX-License-Identifier: AGPL-3.0-or-later
// The import area's handlers, API-80 to API-88 (UI-SPECIFICATION 12.2 and 12.4; SPECIFICATIONS section 6.7, SD-24;
// FR-IMP-1 to FR-IMP-4, FR-IMP-6, FR-IMP-10, FR-IMP-11). Each runs in the kernel's 1 transaction (SD-6).
//
//   API-80, API-84  request a run (@bw/import requestImportRun) and answer 202 with its id. The handler's transaction
//                   only claims the run: the worker's import runner executes it after the answer (runPendingImport;
//                   SPECIFICATIONS section 2 "Import runner | API-80, API-84, setup"). A refusal writes nothing.
//   API-81, API-82  read the run rows; a done run's report is its stored FR-IMP-6 counts plus each reason's first 2
//                   problem rows by row number (section 6.7 "Problem rows").
//   API-83          every problem row of the run as a CSV file (the kernel writes it; contract row `file`).
//   API-85, API-86  the likely pairs and the undone exact pairs (FR-IMP-11; F-265) and the office's decision
//                   (@bw/import decidePair, which locks the pair: a second decision answers already_decided).
//   API-87, API-88  the merges, and undo (@bw/import undoMerge: already_undone).
import {
  decodeCursor, encodeCursor, PROBLEM_LIST_COLUMNS, PROBLEM_REASON_KEYS, type decidePair as decidePairRow, type importRun,
  type importRuns, type likelyDuplicates, type merges, type startDryRun, type undoMerge as undoMergeRow,
} from '@bw/api';
import { foldStreetName } from '@bw/db';
import { catalogs } from '@bw/i18n/src/catalog.ts';
import { decidePair, ImportRefused, MergeRefused, requestImportRun, undoMerge, type ImportReport, type RunKind } from '@bw/import';
import { Temporal, toWire, type Instant } from '@bw/time';
import type { z } from 'zod';
import { DEFAULT_ZONE } from '../kernel/mount.ts';
import { moveJobsToCustomer } from '../office-writes/service.ts';
import type { ApiRequest, ApiResult, Handler, Tx } from '../types.ts';

type Out<T extends { response: z.ZodType }> = z.infer<T['response']>;
type In<T extends { request: z.ZodType }> = z.infer<T['request']>;

/** Import times are written in the branches' zone (all 3 branches are in America/New_York, SPECIFICATIONS section 3). */
const wire = (d: Date): string => toWire(Temporal.Instant.fromEpochMilliseconds(d.getTime()), DEFAULT_ZONE);
const asDate = (i: Instant): Date => new Date(i.epochMilliseconds);
const refuse = <T>(code: 'not_found' | 'validation_failed' | 'run_in_progress' | 'real_run_exists' | 'already_decided' | 'already_undone'): ApiResult<T> =>
  ({ ok: false, status: 409, code });

function staffId(req: ApiRequest): string {
  if (req.caller.kind !== 'staff') throw new Error('an import call reached its handler without a signed-in caller');
  return req.caller.userId;
}

// API-80 and API-84 -----------------------------------------------------------------------------------------------

function startRun(kind: RunKind): Handler<Out<typeof startDryRun>> {
  return async (req, tx) => {
    try {
      const runId = await requestImportRun(tx, { kind, bySetup: false, byUser: staffId(req), at: asDate(req.demoNow) });
      return { ok: true, status: 202, data: { runId } };
    } catch (e) {
      if (e instanceof ImportRefused) return refuse(e.code);
      throw e;
    }
  };
}
export const startDryRunHandler = startRun('dry_run');
export const startRealRunHandler = startRun('real');

// API-81 and API-82 -----------------------------------------------------------------------------------------------

interface RunRow {
  id: string;
  kind: RunKind;
  status: 'running' | 'done' | 'failed';
  stage: 'parse' | 'validate' | 'match' | 'write';
  percent: number;
  started_at: Date;
  finished_at: Date | null;
  source_exported_at: Date | null;
  by_setup: boolean;
  by_user: string | null;
  by_name: string | null;
  report: (ImportReport & { error?: string }) | null;
}

const RUN_SQL = `SELECT r.id, r.kind, r.status, r.stage, r.percent, r.started_at, r.finished_at, r.source_exported_at, r.by_setup,
                        r.by_user, u.name AS by_name, r.report
                   FROM world.import_run r LEFT JOIN world."user" u ON u.id = r.by_user`;

/** The stored report, only for a done run (a running or failed run has none; section 3 import_run.report "set at finish"). */
const doneReport = (r: RunRow): ImportReport | null => (r.status === 'done' ? r.report : null);

function countsOf(rep: ImportReport) {
  return { customers: rep.customers, visits: rep.visits, equipment: rep.equipment, problems: rep.problems.total, duplicates: rep.duplicates };
}

/** Setup's runs, and any run no person asked for (only setup's path, runImport, writes one), read as setup. */
function byOf(r: RunRow): Out<typeof importRuns>['runs'][number]['by'] {
  return !r.by_setup && r.by_user ? { kind: 'user', userId: r.by_user, name: r.by_name ?? '' } : { kind: 'setup' };
}

export const importRunHandler: Handler<Out<typeof importRun>> = async (req, tx) => {
  const { runId } = req.params as In<typeof importRun>;
  const r = (await tx.query<RunRow>(`${RUN_SQL} WHERE r.id = $1`, [runId])).rows[0];
  if (!r) return refuse('not_found');
  const rep = doneReport(r);
  let report: Out<typeof importRun>['report'] = null;
  if (rep) {
    // Each reason's first 2 rows by row number (section 6.7 "Problem rows"; section 3 import_problem_row.example).
    const lang = (await tx.query<{ language: 'en' | 'es' }>('SELECT language FROM world."user" WHERE id = $1', [staffId(req)])).rows[0]?.language ?? 'en';
    const words = catalogs[lang];
    const ex = await tx.query<{ reason: string; file: string; row_no: number; example: string }>(
      `SELECT reason, file, row_no, example FROM (
         SELECT reason, file, row_number AS row_no, example, row_number() OVER (PARTITION BY reason ORDER BY row_number, file) AS k
           FROM world.import_problem_row WHERE run_id = $1) t
        WHERE k <= 2 ORDER BY reason, row_no, file`, [runId]);
    report = {
      ...countsOf(rep),
      problems: {
        total: rep.problems.total,
        byReason: PROBLEM_REASON_KEYS.map((reason) => ({
          reason,
          count: rep.problems.byReason[reason] ?? 0,
          examples: ex.rows.filter((x) => x.reason === reason).map((x) => ({
            file: x.file, rowNumber: x.row_no, example: x.example, words: words[`admin.import.words.${reason}`] as string,
          })),
        })),
      },
    };
  }
  // F-521: a failed run's stored code (the runner's failureCode), so the page can say tried 3 times or the export was refused.
  const failure = r.status === 'failed' ? (r.report?.error ?? 'import_failed') : null;
  return { ok: true, status: 200, data: { kind: r.kind, status: r.status, stage: r.stage, percent: r.percent, report, failure } };
};

export const importRunsHandler: Handler<Out<typeof importRuns>> = async (_req, tx) => {
  const rows = (await tx.query<RunRow>(`${RUN_SQL} ORDER BY r.started_at DESC, r.id DESC`)).rows;
  const runs = rows.map((r) => {
    const rep = doneReport(r);
    return {
      runId: r.id, kind: r.kind, startedAt: wire(r.started_at), finishedAt: r.finished_at ? wire(r.finished_at) : null,
      sourceExportedAt: r.source_exported_at ? wire(r.source_exported_at) : null, by: byOf(r), status: r.status,
      counts: rep ? countsOf(rep) : null,
    };
  });
  const real = rows.find((r) => r.kind === 'real' && r.status === 'done' && r.finished_at !== null);
  return {
    ok: true, status: 200,
    data: { runs, realRun: real ? { runId: real.id, by: byOf(real), finishedAt: wire(real.finished_at as Date) } : null },
  };
};

// API-83 ----------------------------------------------------------------------------------------------------------

/**
 * 1 CSV cell (RFC 4180): quoted when it holds a comma, quote or line break. A cell a spreadsheet would read as a formula
 * (it starts with =, +, -, @, a tab or a carriage return) is prefixed with an apostrophe, so an old-system name such as
 * "=HYPERLINK(...)" is shown as text, never run (the file is opened in a spreadsheet: CTL-OFC-13-07).
 */
export function csvCell(v: string | number): string {
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const problemListHandler: Handler<string> = async (req, tx) => {
  const { runId } = req.params as { runId: string };
  const run = await tx.query('SELECT 1 FROM world.import_run WHERE id = $1', [runId]);
  if (run.rows.length === 0) return refuse('not_found');
  const rows = await tx.query<{ file: string; row_no: number; reason: string; example: string }>(
    `SELECT file, row_number AS row_no, reason, example FROM world.import_problem_row WHERE run_id = $1
      ORDER BY array_position(ARRAY['customers.csv', 'visits.csv', 'equipment.csv'], file), row_number`, [runId]);
  const lines = [PROBLEM_LIST_COLUMNS.join(','), ...rows.rows.map((r) => [r.file, r.row_no, r.reason, r.example].map(csvCell).join(','))];
  return { ok: true, status: 200, data: `${lines.join('\r\n')}\r\n` };
};

// API-85 and API-86 -----------------------------------------------------------------------------------------------

type Pair = Out<typeof likelyDuplicates>['pairs'][number];

interface PairRow {
  id: string;
  record_a: string;
  record_b: string;
  why: string;
  status: Pair['status'];
  decided_by: string | null;
  decider: string | null;
}

interface RecordRow {
  id: string;
  old_customer_number: string | null;
  name: string;
  house_number: number;
  street: string;
  city: string;
  zip: string;
  mobile: string | null;
  home_phone: string | null;
  text_language: 'en' | 'es';
  since: string;
  branch_id: string;
  member: boolean;
  getting_in: string | null;
  equipment: { type: string; year: number | null; details: string | null }[];
  visits: string;
  first_visit: string | null;
  last_visit: string | null;
  lv_service: string | null;
  lv_service_id: string | null;
}

const PAIR_SQL = `SELECT p.id, p.record_a, p.record_b, p.why, p.status, p.decided_by, u.name AS decider
                    FROM world.duplicate_pair p LEFT JOIN world."user" u ON u.id = p.decided_by`;

/** Every branch is in Ohio (REQUIREMENTS section 1: Columbus, Dayton and Springfield); no table stores a state. */
const BRANCH_STATE = 'OH';

/**
 * The pairs with both records: each record's UI-SPECIFICATION v0.13 API-85 fields (owner ruling d9901466). Its visits are its
 * past visits together with its done jobs (SPECIFICATIONS section 6.2), the same union the customer page's history reads.
 */
async function pairsOf(tx: Tx, rows: readonly PairRow[]): Promise<Pair[]> {
  const ids = [...new Set(rows.flatMap((p) => [p.record_a, p.record_b]))];
  const recs = await tx.query<RecordRow>(
    `SELECT c.id, c.old_customer_number, c.name, c.house_number, s.name AS street, s.city, s.zip, c.mobile, c.home_phone, c.text_language,
            to_char(c.customer_since, 'YYYY-MM-DD') AS since, c.branch_id, c.getting_in,
            EXISTS (SELECT 1 FROM world.membership m WHERE m.customer_id = c.id) AS member,
            coalesce((SELECT jsonb_agg(jsonb_build_object('type', e.type, 'year', e.year, 'details', e.details) ORDER BY e.id)
                        FROM world.equipment e WHERE e.customer_id = c.id), '[]'::jsonb) AS equipment,
            v.n AS visits, v.first_visit, v.last_visit, lv.service AS lv_service, lv.service_id AS lv_service_id
       FROM world.customer c JOIN world.street s ON s.id = c.street_id
       LEFT JOIN LATERAL (
         SELECT count(*) AS n, min(x.date)::text AS first_visit, max(x.date)::text AS last_visit FROM (
           SELECT pv.date FROM world.past_visit pv WHERE pv.customer_id = c.id
           UNION ALL
           SELECT j.date FROM world.job j WHERE j.customer_id = c.id AND j.status = 'done') x) v ON true
       LEFT JOIN LATERAL (
         SELECT x.service, x.service_id FROM (
           SELECT pv.date, pv.service_text AS service, NULL::text AS service_id, pv.id::text AS k FROM world.past_visit pv WHERE pv.customer_id = c.id
           UNION ALL
           SELECT j.date, j.service_id, j.service_id, lpad(j.job_number::text, 12, '0') FROM world.job j WHERE j.customer_id = c.id AND j.status = 'done') x
          ORDER BY x.date DESC, x.k DESC LIMIT 1) lv ON true
      WHERE c.id = ANY($1::uuid[])`, [ids]);
  const byId = new Map(recs.rows.map((r) => [r.id, r]));
  const record = (id: string) => {
    const r = byId.get(id);
    if (!r) throw new Error(`a duplicate pair names customer ${id}, which does not exist`);
    const phones: Pair['recordA']['phones'] = [];
    if (r.mobile) phones.push({ number: r.mobile, kind: 'mobile' });
    if (r.home_phone) phones.push({ number: r.home_phone, kind: 'home' });
    return {
      customerId: r.id, oldCustomerNumber: r.old_customer_number, name: r.name, street: `${r.house_number} ${r.street}`, city: r.city,
      state: BRANCH_STATE, zip: r.zip, phones, textLanguage: r.text_language, customerSince: r.since, branchId: r.branch_id,
      plan: r.member ? ('comfort_club' as const) : ('none' as const), notes: r.getting_in, equipment: r.equipment,
      visits: {
        count: Number(r.visits), first: r.first_visit, last: r.last_visit,
        lastVisit: r.last_visit === null ? null : { date: r.last_visit, service: r.lv_service ?? '', serviceId: r.lv_service_id },
      },
    };
  };
  return rows.map((p) => {
    const a = record(p.record_a);
    const b = record(p.record_b);
    return {
      pairId: p.id, recordA: a, recordB: b, whyListed: p.why, status: p.status,
      decidedBy: p.decided_by ? { userId: p.decided_by, name: p.decider ?? '' } : null,
      // Merge keeps record A's name and both records' visits and equipment (12.4 API-85 mergePreview; section 6.7).
      mergePreview: { keptName: a.name, visits: a.visits.count + b.visits.count, equipment: a.equipment.length + b.equipment.length },
    };
  });
}

/**
 * The pairs of the review page (FR-IMP-11): every likely pair, and every exact pair whose merge was undone (owner ruling
 * ba125b81 "Show it again", F-265: undo returns a pair to the office's queue, so an undone exact pair is checked like a
 * likely one).
 */
const ON_REVIEW_PAGE = `(p.kind = 'likely' OR EXISTS (SELECT 1 FROM world."merge" m WHERE m.pair_id = p.id AND m.status = 'undone'))`;

/** A cursor's id is bound as ::uuid, so a forged one that is not an id is refused here, not left to PostgreSQL (F-260). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SHOW: Record<In<typeof likelyDuplicates>['status'], Pair['status'] | null> = {
  to_check: 'listed', merged: 'merged', kept_separate: 'kept_separate', skipped: 'skipped', all: null,
};

export const likelyDuplicatesHandler: Handler<Out<typeof likelyDuplicates>> = async (req, tx) => {
  const q = req.params as In<typeof likelyDuplicates>;
  const after = q.cursor === undefined ? null : decodeCursor(q.cursor);
  if (q.cursor !== undefined && (after === null || !UUID.test(after.id))) return refuse('validation_failed'); // F-260: the id is bound as ::uuid
  const counts = await tx.query<{ status: string; n: string }>(
    `SELECT p.status, count(*) AS n FROM world.duplicate_pair p WHERE ${ON_REVIEW_PAGE} GROUP BY p.status`);
  const c = (s: string) => Number(counts.rows.find((r) => r.status === s)?.n ?? 0);
  const listed = counts.rows.reduce((t, r) => t + Number(r.n), 0);
  const checked = c('merged') + c('kept_separate');
  // Pairs in the order the run listed them (uuidv7 ids follow insertion order); the cursor is the last pair's id.
  const page = await tx.query<PairRow>(
    `${PAIR_SQL} WHERE ${ON_REVIEW_PAGE} AND ($1::text IS NULL OR p.status = $1) AND ($2::uuid IS NULL OR p.id > $2)
      ORDER BY p.id LIMIT $3`, [SHOW[q.status], after?.id ?? null, q.limit + 1]);
  const more = page.rows.length > q.limit;
  const rows = page.rows.slice(0, q.limit);
  const last = rows.at(-1);
  return {
    ok: true, status: 200,
    data: {
      progress: { listed, checked, left: listed - checked, merged: c('merged'), keptSeparate: c('kept_separate'), skipped: c('skipped') },
      pairs: await pairsOf(tx, rows),
      next: more && last ? encodeCursor(last.id, last.id) : null,
    },
  };
};

export const decidePairHandler: Handler<Out<typeof decidePairRow>> = async (req, tx) => {
  const { pairId, decision } = req.params as In<typeof decidePairRow>;
  let mergeId: string | null;
  try {
    // F-267 (owner ruling a7cafbb1): the merge moves record B's jobs through the office write service.
    ({ mergeId } = await decidePair(tx, pairId, decision, staffId(req), asDate(req.demoNow), moveJobsToCustomer));
  } catch (e) {
    if (e instanceof MergeRefused && e.code !== 'already_undone') return refuse(e.code);
    throw e;
  }
  const row = (await tx.query<PairRow>(`${PAIR_SQL} WHERE p.id = $1`, [pairId])).rows;
  const [pair] = await pairsOf(tx, row);
  if (!pair) return refuse('not_found');
  return { ok: true, status: 200, data: { pair, mergeId } };
};

// API-87 and API-88 -----------------------------------------------------------------------------------------------

type Merge = Out<typeof merges>['merges'][number];

const MERGE_FROM = `FROM world."merge" m JOIN world.duplicate_pair p ON p.id = m.pair_id
                     JOIN world.customer ca ON ca.id = p.record_a JOIN world.customer cb ON cb.id = p.record_b`;
/** Each merge with both names and the kept record's (record A's) house number, street and city (CTL-OFC-15-04). */
const MERGE_SQL = `SELECT m.id, m.kind, m.status, m.at, p.record_a, p.record_b, ca.name AS a_name, cb.name AS b_name,
                          ca.house_number AS a_house, sa.name AS a_street, sa.city AS a_city
                     ${MERGE_FROM} JOIN world.street sa ON sa.id = ca.street_id`;

interface MergeRow {
  id: string;
  kind: Merge['kind'];
  status: Merge['status'];
  at: Date;
  record_a: string;
  record_b: string;
  a_name: string;
  b_name: string;
  a_house: number;
  a_street: string;
  a_city: string;
}

const mergeOf = (m: MergeRow): Merge => ({
  mergeId: m.id,
  records: { a: { customerId: m.record_a, name: m.a_name }, b: { customerId: m.record_b, name: m.b_name } },
  address: `${m.a_house} ${m.a_street}, ${m.a_city}`,
  kind: m.kind, at: wire(m.at), status: m.status,
});

export const mergesHandler: Handler<Out<typeof merges>> = async (req, tx) => {
  const q = req.params as In<typeof merges>;
  const after = q.cursor === undefined ? null : decodeCursor(q.cursor);
  if (q.cursor !== undefined && (after === null || !UUID.test(after.id))) return refuse('validation_failed'); // F-260: the id is bound as ::uuid
  // Find a merge by either record's name, folded as customer.name_search is (the top-bar search's rule, @bw/db).
  const name = q.name ? foldStreetName(q.name) : '';
  // Newest first (uuidv7 ids follow creation order): an office merge or a re-merge lists above the run's exact merges.
  const match = `($1 = '' OR strpos(ca.name_search, $1) > 0 OR strpos(cb.name_search, $1) > 0)`;
  const r = await tx.query<MergeRow>(
    `${MERGE_SQL} WHERE ${match} AND ($2::uuid IS NULL OR m.id < $2) ORDER BY m.id DESC LIMIT $3`, [name, after?.id ?? null, q.limit + 1]);
  // The total the search matches, every page alike (owner ruling d9901466: "Showing 5 of 1,206 merges").
  const total = Number((await tx.query<{ n: string }>(`SELECT count(*) AS n ${MERGE_FROM} WHERE ${match}`, [name])).rows[0]?.n ?? 0);
  const more = r.rows.length > q.limit;
  const rows = r.rows.slice(0, q.limit);
  const last = rows.at(-1);
  return { ok: true, status: 200, data: { merges: rows.map(mergeOf), next: more && last ? encodeCursor(last.id, last.id) : null, total } };
};

export const undoMergeHandler: Handler<Out<typeof undoMergeRow>> = async (req, tx) => {
  const { mergeId } = req.params as In<typeof undoMergeRow>;
  let restored: { recordA: string; recordB: string };
  try {
    restored = await undoMerge(tx, mergeId, { by: staffId(req), at: asDate(req.demoNow), jobs: moveJobsToCustomer });
  } catch (e) {
    if (e instanceof MergeRefused && e.code !== 'already_decided') return refuse(e.code);
    throw e;
  }
  const m = (await tx.query<MergeRow>(`${MERGE_SQL} WHERE m.id = $1`, [mergeId])).rows[0];
  if (!m) return refuse('not_found');
  return { ok: true, status: 200, data: { merge: mergeOf(m), restored: [restored.recordA, restored.recordB] } };
};
