// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixed data for the import pages' preview routes (harness build only, *.preview.tsx): the numbers and names the three frames print, so
// the look comparator reads the same text and the same state on both sides. Never imported by a release route.
import type { DupsData } from './DuplicatesScreen.tsx';
import type { DryRunData } from './DryRunScreen.tsx';
import type { MergeItem, Pair, PairRecord, RunAnswer, RunsAnswer, RunSummary } from './model.ts';

const Z = '[America/New_York]';
const at = (d: string) => `${d}${Z}`;

const COUNTS = {
  customers: { total: 18400, clean: 17912, flagged: 488 },
  visits: { total: 96412, imported: 95870, notImported: 542 },
  equipment: { total: 31058, imported: 30904, notImported: 154 },
  problems: 1184,
  duplicates: { total: 1240, exact: 812, likely: 428 },
};
const SETUP = { kind: 'setup' } as const;
const DANA = { kind: 'user', userId: 'u-dana', name: 'Dana Ruiz' } as const;

export const DRY: RunSummary = {
  runId: 'r-dry-1', kind: 'dry_run', startedAt: at('2026-09-04T14:10:00-04:00'), finishedAt: at('2026-09-04T14:31:00-04:00'),
  sourceExportedAt: at('2026-08-31T05:00:00-04:00'), by: DANA, status: 'done', counts: COUNTS,
};
export const REAL: RunSummary = {
  runId: 'r-real-1', kind: 'real', startedAt: at('2026-08-31T06:02:00-04:00'), finishedAt: at('2026-08-31T06:44:00-04:00'),
  sourceExportedAt: at('2026-08-31T05:00:00-04:00'), by: SETUP, status: 'done', counts: COUNTS,
};
export const SETUP_DRY: RunSummary = {
  runId: 'r-dry-0', kind: 'dry_run', startedAt: at('2026-08-31T05:38:00-04:00'), finishedAt: at('2026-08-31T05:59:00-04:00'),
  sourceExportedAt: at('2026-08-31T05:00:00-04:00'), by: SETUP, status: 'done', counts: COUNTS,
};
const REAL_RUN = { runId: REAL.runId, by: SETUP, finishedAt: REAL.finishedAt as string };

const EX: Record<string, [string, string]> = {
  visit_no_customer: ['Visit 2021-08812 (AC repair): customer 40417', 'Visit 2022-11930 (no heat): customer number blank'],
  missing_zip: ['Doris Whitfield, 77 Elm St, Grove City: ZIP blank', 'Raymond Toth, 1408 Oakland Park Ave: ZIP blank'],
  bad_phone: ['Earl Mott: (614) 555-01', 'Lena Fisk: (614) 555-O172'],
  visit_date_unreadable: ['Visit 2019-00347: date 13/45/2019', 'Visit 2020-05521: date 00/00/0000'],
  equipment_no_address: ['Gas furnace, serial 7F3-2291: address number 0', 'Water heater, 50 gal: address blank'],
  customer_name_blank: ['Customer 22918, 15 Oak Ct, Hilliard: name blank', 'Customer 30144, 902 Cassady Ave: name -'],
};
// F-678: on a Spanish page the furnace example reads in Spanish. Its English words are the catalog's equipment type
// (customers.equipment.furnace), which the Spanish walker forbids on a Spanish page; F-649: the water heater half the same way
// (customers.equipment.water_heater).
const EX_ES: Partial<Record<string, readonly [string | null, string | null]>> = {
  equipment_no_address: ['Calefactor de gas, serie 7F3-2291: número de casa 0', 'Calentador de agua, 50 gal: dirección en blanco'],
};
const N: Record<string, number> = { visit_no_customer: 418, missing_zip: 214, bad_phone: 187, visit_date_unreadable: 124, equipment_no_address: 154, customer_name_blank: 87 };

/** `words`: the reason's catalog words in the page language, passed in by the route (API-81 adds them). */
export function reportRun(words: (reason: string) => string, lang: 'en' | 'es' = 'en'): RunAnswer {
  return {
    kind: 'dry_run', status: 'done', stage: 'write', percent: 100, failure: null,
    report: {
      ...COUNTS,
      problems: {
        total: COUNTS.problems,
        byReason: Object.keys(EX).map((reason) => ({
          reason: reason as never, count: N[reason] as number,
          examples: (EX[reason] as [string, string]).map((example, i) => ({ file: 'customers.csv', rowNumber: i + 1, example: (lang === 'es' ? EX_ES[reason]?.[i] : null) ?? example, words: words(reason) })),
        })),
      },
    },
  };
}

export const runsReal: RunsAnswer = { runs: [DRY, REAL, SETUP_DRY], realRun: REAL_RUN };
export const runsNoReal: RunsAnswer = { runs: [DRY, SETUP_DRY], realRun: null };
export const runsNone: RunsAnswer = { runs: [], realRun: null };

export const dryData = (words: (reason: string) => string, over: Partial<DryRunData> = {}, lang: 'en' | 'es' = 'en'): DryRunData => ({
  runs: runsNoReal, run: reportRun(words, lang), shown: DRY, dupCount: 428, ...over,
});

// The shown pair is DK-99's pair 62 (admin-import-duplicates.html:720 and :1213-1222). Its old customer numbers are the frame's
// (10288, 16541): a preview prints the frame's text (F-880); the live page prints the stored customer_ref as written, C plus 6 digits.
const rec = (over: Partial<PairRecord>): PairRecord => ({
  customerId: 'c-a', oldCustomerNumber: '10288', name: "Kathleen O'Brien", street: '2240 Riverside Dr', city: 'Upper Arlington', state: 'OH', zip: '43221',
  phones: [{ number: '+16145550163', kind: 'mobile' }], textLanguage: 'en', customerSince: '2015-03-02', branchId: 'columbus', plan: 'comfort_club',
  notes: 'Side gate code 4471. Small dog in the yard.',
  equipment: [{ type: 'furnace', year: 2016, details: null }, { type: 'Central AC', year: 2016, details: 'serial 4TTR-88213' }],
  visits: { count: 9, first: '2020-03-11', last: '2026-04-02', lastVisit: { date: '2026-04-02', service: 'furnace_tune_up', serviceId: 'furnace_tune_up' } },
  ...over,
});
const pair = (i: number, status: Pair['status'], a: string, b: string, city: string): Pair => ({
  pairId: `p-${i}`, recordA: rec({ name: a, city }), recordB: rec({ customerId: 'c-b', name: b, city }), whyListed: 'phone_and_house_number_match_name_and_street_differ',
  status, decidedBy: null, mergePreview: { keptName: a, visits: 11, equipment: 3 },
});
const PAIRS: Pair[] = [
  pair(59, 'merged', 'Ruth Pierce', 'Ruth A. Pierce', 'Bexley'),
  pair(60, 'kept_separate', 'Michael Dunbar', 'Mike Dunbar', 'Westerville'),
  pair(61, 'skipped', 'Gina Russo', 'Gina Russo-Hale', 'Worthington'),
  { ...pair(62, 'listed', "Kathleen O'Brien", 'Kathy OBrien', 'Upper Arlington'), recordB: rec({
    customerId: 'c-b', oldCustomerNumber: '16541', name: 'Kathy OBrien', street: '2240 Riverside Drive', city: 'Upper Arlington', customerSince: '2021-07-14', plan: 'none', notes: null,
    equipment: [{ type: 'Central AC', year: 2016, details: 'serial 4TTR-88213' }, { type: 'water_heater', year: 2021, details: '50 gal' }],
    visits: { count: 2, first: '2021-07-20', last: '2023-05-09', lastVisit: { date: '2023-05-09', service: 'water_heater', serviceId: 'water_heater' } },
  }) },
  pair(63, 'listed', 'Robert Hale', 'Bob Hale', 'Grove City'),
  pair(64, 'listed', 'Linda Marsh', 'Linda and Tom Marsh', 'Gahanna'),
];

export const dupsData = (over: Partial<DupsData> = {}): DupsData => ({
  progress: { listed: 428, checked: 61, left: 367, merged: 40, keptSeparate: 21, skipped: 4 },
  pairs: PAIRS, next: 'x', filter: 'to_check', index: 3, found: { total: 1240, exact: 812 }, importedAt: at('2026-09-05T06:20:00-04:00'), ...over,
});

/** F-1280: the shown pair with a Spanish speaker as record A, so the Text language row reads Español and English (the frame's pair draws English on both sides; its look case keeps dupsData). */
export const dupsSpanishData = (): DupsData => {
  const d = dupsData();
  return { ...d, pairs: d.pairs.map((p, i) => (i === d.index ? { ...p, recordA: { ...p.recordA, textLanguage: 'es' } } : p)) };
};

const m = (id: string, a: string, b: string, address: string, kind: MergeItem['kind'], when: string, status: MergeItem['status']): MergeItem => ({
  mergeId: id, records: { a: { customerId: `${id}a`, name: a }, b: { customerId: `${id}b`, name: b } }, address, kind, at: at(when), status,
});
export const MERGES: MergeItem[] = [
  m('m1', 'Harold Jenkins', 'Harold Jenkins', '418 Maple Hollow Ct, Westerville', 'exact', '2026-08-31T06:20:00-04:00', 'active'),
  m('m2', 'Kathy OBrien', "Kathleen O'Brien-Miller", '57 Kenwick Rd, Upper Arlington', 'office', '2026-09-10T15:14:00-04:00', 'active'),
  m('m3', "Sean O'Brien", 'Sean OBrien', '77 Oakland Park Ave, Clintonville', 'office', '2026-09-09T11:02:00-04:00', 'undone'),
  m('m4', 'Carmen Reyes', 'Carmen Reyes-Ortiz', '6410 Avery Rd, Dublin', 'office', '2026-09-08T09:47:00-04:00', 'active'),
  m('m5', 'Paul Marsh', 'Paul and Diane Marsh', '140 Granville St, Gahanna', 'exact', '2026-08-31T06:21:00-04:00', 'active'),
];
/** DK-100's count under the merges table: "Showing 5 of 1,206 merges". */
export const MERGES_TOTAL = 1206;
