// SPDX-License-Identifier: AGPL-3.0-or-later
// The generator's checks (gate generator-gates): generator-manifest (FR-IMP-5), phone-range-scan (FR-IMP-7), the
// fixture's share-none rule (R-BP1), the truth file against customers.csv (FR-IMP-3, FR-IMP-6), the FR-IMP-6 target
// counts and the SD-25 rates. Each reads only the generated file texts, never the generator's internals, and returns
// a list of failures: empty is a pass.
import { createHash } from 'node:crypto';
import { FOUR_HOUR_WINDOWS, PEAK_DAYS } from '../../db/src/seed/reference-data.ts';
import { foldStreetName as fold } from '../../db/src/street-list.ts';
import { readCsvRecords } from './csv.ts';
import {
  AFTER_FIRST, blockingKeys, digits, exactKey, FILES, lookupKey, PILOT_FIRST, type FileName, type Output,
} from './generate.ts';
import { day, minutesOf, weekStart } from './calendar.ts';

/**
 * FR-IMP-6's import target table (docs/REQUIREMENTS.md, "Import target counts"), typed here from the table and not
 * imported from generate.ts, so a changed generator constant plus write-manifest fails the checks (F-204). A test
 * reads the table from REQUIREMENTS.md and compares it with this object.
 */
export const FR_IMP_6 = {
  customers: 18_400,
  customersFlagged: 488,
  visits: 96_412,
  visitsNotImported: 542,
  equipment: 31_058,
  equipmentNotImported: 154,
  problemRows: 1_184,
  visitNoCustomer: 418,
  missingZip: 214,
  badPhone: 187,
  visitDateUnreadable: 124,
  equipmentNoAddress: 154,
  customerNameBlank: 87,
  pairs: 1_240,
  exactPairs: 812,
  likelyPairs: 428,
} as const;

/** FR-BOOK-6 (docs/REQUIREMENTS.md): the Columbus branch's 5 two-hour windows take at most these bookings, in time order. */
const FR_BOOK_6_LIMITS = [12, 12, 11, 11, 10] as const;

export type Files = Partial<Record<FileName, string | Buffer>>;
const text = (f: Files, n: FileName): string => {
  const v = f[n];
  if (v === undefined) throw new Error(`missing generated file ${n}`);
  return typeof v === 'string' ? v : v.toString('utf8');
};

// ----- generator-manifest: the committed SHA-256 and size of each of the 5 generated files, 3 CSV and 2 JSON (FR-IMP-5) -----

export interface Manifest {
  _doc: string;
  seed: number;
  files: Record<string, { bytes: number; sha256: string }>;
}

export const sha256 = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

export function buildManifest(out: Output, seed: number): Manifest {
  const files: Manifest['files'] = {};
  for (const n of FILES) files[n] = { bytes: Buffer.byteLength(out[n]), sha256: sha256(out[n]) };
  return {
    _doc: 'generator-manifest (FR-IMP-5; SPECIFICATIONS section 6.7): the SHA-256 and size of every file @bw/generator writes from seed 20260915 with the verified street list. The files are regenerated, never committed (D7); a changed byte or row order fails the check. Rewrite with: node packages/generator/src/cli.ts write-manifest',
    seed,
    files,
  };
}

export function checkManifest(manifest: Manifest, files: Files): string[] {
  const fails: string[] = [];
  for (const n of FILES) {
    const want = manifest.files[n];
    const got = files[n];
    if (!want) { fails.push(`generator-manifest: ${n} has no manifest entry`); continue; }
    if (got === undefined) { fails.push(`generator-manifest: ${n} is missing`); continue; }
    const h = sha256(got);
    const bytes = typeof got === 'string' ? Buffer.byteLength(got) : got.length;
    if (h !== want.sha256 || bytes !== want.bytes) {
      fails.push(`generator-manifest: ${n} sha256 ${h.slice(0, 12)} (${bytes} bytes) != manifest ${want.sha256.slice(0, 12)} (${want.bytes} bytes)`);
    }
  }
  return fails;
}

// ----- phone-range-scan: every sample phone number is in the fictional 555-0100 to 555-0199 range (FR-IMP-7) -----

const TEN_DIGIT = /(?<![\d])(?:\+?1[-. ]?)?\(?(\d{3})\)?[-. ]?(\d{3})[-. ]?(\d{4})(?!\d)/g;
const SEVEN_DIGIT = /(?<![\d])(\d{3})[-. ](\d{4})(?!\d)/g;
const BARE_555 = /(?<![\d])555[-. ]?(\d{4})(?!\d)/g;
const AREAS = new Set(['614', '937']);

/** The area code each branch's customers carry (D10), typed here and not imported from generate.ts (as FR_IMP_6 is, F-204). */
const BRANCH_AREA: Readonly<Record<string, string>> = { columbus: '614', dayton: '937', springfield: '937' };

/** The area codes a customer's city allows: its street rows' branches' codes (street-list.json). Undefined when the city has no street. */
export type AreasOfCity = (city: string) => readonly string[] | undefined;

export function areasOfCityFrom(streets: readonly { city: string; branch: string }[]): AreasOfCity {
  const by = new Map<string, Set<string>>();
  for (const st of streets) {
    const area = BRANCH_AREA[st.branch];
    if (area !== undefined) by.set(st.city, (by.get(st.city) ?? new Set<string>()).add(area));
  }
  return (city) => { const a = by.get(city); return a ? [...a] : undefined; };
}

/** True for (614) or (937) 555-0100 to 555-0199, the only numbers a generated file may hold (D10). */
function inReservedRange(area: string, exchange: string, line: string): boolean {
  const n = Number(line);
  return AREAS.has(area) && exchange === '555' && n >= 100 && n <= 199;
}

/**
 * Scan every text of every generated file: each 10-digit number must be in the reserved range, and no 7-digit
 * number or bare 555 number may stand outside one (a real-looking or other 555 number). Phone cells must be empty,
 * a reserved number, or a planted bad number with too few digits (FR-IMP-6 "bad phone number"). A customer's number
 * also carries the area code of that customer's own city (F-239): a 937 number on a Columbus row fails.
 */
export function phoneRangeScan(files: Files, areasOf: AreasOfCity): string[] {
  const fails: string[] = [];
  for (const n of FILES) {
    const t = text(files, n);
    const lines = t.split('\n');
    lines.forEach((ln, i) => {
      const covered: [number, number][] = [];
      for (const m of ln.matchAll(TEN_DIGIT)) {
        covered.push([m.index, m.index + m[0].length]);
        if (!inReservedRange(m[1] as string, m[2] as string, m[3] as string)) fails.push(`phone-range-scan: ${n}:${i + 1}: ${m[0]} is outside (614)/(937) 555-0100 to 555-0199`);
      }
      const inside = (at: number): boolean => covered.some(([a, b]) => at >= a && at < b);
      for (const re of [SEVEN_DIGIT, BARE_555]) {
        for (const m of ln.matchAll(re)) {
          if (!inside(m.index)) fails.push(`phone-range-scan: ${n}:${i + 1}: ${m[0]} is a phone number with no reserved area code`);
        }
      }
    });
  }
  for (const r of readCsvRecords(text(files, 'customers.csv'))) {
    for (const col of ['mobile', 'home_phone'] as const) {
      const v = r[col] ?? '';
      if (v === '') continue;
      const d = digits(v);
      const own = areasOf(r.city ?? '');
      const wrongArea = own === undefined ? `its city ${r.city} has no street row` : own.includes(d.slice(0, 3)) ? '' : `its city ${r.city} uses ${own.join(' or ')}`;
      if (wrongArea !== '' && /^(614|937)/.test(d)) { fails.push(`phone-range-scan: customers.csv ${r.customer_ref} ${col} ${v} has the wrong area code: ${wrongArea}`); continue; }
      if (d.length === 10 && inReservedRange(d.slice(0, 3), d.slice(3, 6), d.slice(6))) continue;
      // A planted bad number: an area code, 555 and 2 or 3 more digits, too short to dial (generate.ts badPhone). Any other
      // short cell, such as a 7-digit 8675309 with no separator, is a real-looking number and fails (F-202).
      if (/^(614|937)555\d{2,3}$/.test(d)) continue;
      fails.push(`phone-range-scan: customers.csv ${r.customer_ref} ${col} ${v} is not a reserved number`);
    }
  }
  return fails;
}

// ----- the truth file against customers.csv -----

interface Truth { counts: { exact: number; likely: number }; exact: { a: string; b: string }[]; likely: { a: string; b: string }[] }

function parseTruth(t: string): Truth {
  return JSON.parse(t) as Truth;
}

type Cust = Record<string, string>;
const ek = (c: Cust): string => exactKey(c.name ?? '', c.street ?? '', c.city ?? '', c.zip ?? '', c.house_number ?? '', c.mobile ?? '');
const bk = (c: Cust, streetZip: string): string[] => blockingKeys(c.name ?? '', c.street ?? '', c.city ?? '', streetZip, c.zip ?? '');

/**
 * The truth file equals what customers.csv holds: every exact pair shares the exact-match key, every likely pair
 * shares a blocking key and not the exact key, every block of 2 or more customers is 1 truth pair, no exact key is
 * shared outside the exact pairs, record A comes first in the file, and the counts are FR-IMP-6's 812 and 428.
 */
export function truthCheck(files: Files): string[] {
  const fails: string[] = [];
  const truth = parseTruth(text(files, 'truth.json'));
  const custs = readCsvRecords(text(files, 'customers.csv'));
  const byRef = new Map(custs.map((c, i) => [c.customer_ref ?? '', { c, row: i }]));
  if (truth.exact.length !== FR_IMP_6.exactPairs) fails.push(`truth: ${truth.exact.length} exact pairs, FR-IMP-6 target ${FR_IMP_6.exactPairs}`);
  if (truth.likely.length !== FR_IMP_6.likelyPairs) fails.push(`truth: ${truth.likely.length} likely pairs, FR-IMP-6 target ${FR_IMP_6.likelyPairs}`);
  if (truth.exact.length + truth.likely.length !== FR_IMP_6.pairs) fails.push(`truth: ${truth.exact.length + truth.likely.length} pairs, FR-IMP-6 target ${FR_IMP_6.pairs}`);
  // The street's own ZIP for blocking by street: the row's ZIP cell, or for a missing one the ZIP of the street with
  // that name and city (the generator draws a ZIP-less customer only from a name and city the list holds once).
  const zipOf = new Map<string, Set<string>>();
  for (const c of custs) if (c.zip) zipOf.set(`${c.street}|${c.city}`, (zipOf.get(`${c.street}|${c.city}`) ?? new Set()).add(c.zip));
  const streetZip = { get: (nameCity: string): string | undefined => { const z = zipOf.get(nameCity); return z && z.size === 1 ? [...z][0] : undefined; } };
  const sz = (c: Cust): string => (c.zip ? c.zip : streetZip.get(`${c.street}|${c.city}`) ?? '');
  const pairOf = new Map<string, string>();
  const seen = new Set<string>();
  for (const [kind, list] of [['exact', truth.exact], ['likely', truth.likely]] as const) {
    for (const p of list) {
      const a = byRef.get(p.a);
      const b = byRef.get(p.b);
      if (!a || !b) { fails.push(`truth: ${kind} pair ${p.a}/${p.b} names a customer not in customers.csv`); continue; }
      for (const r of [p.a, p.b]) {
        if (seen.has(r)) fails.push(`truth: ${r} is in more than 1 pair`);
        seen.add(r);
      }
      pairOf.set(p.a, p.b);
      pairOf.set(p.b, p.a);
      if (a.row > b.row) fails.push(`truth: ${kind} pair ${p.a}/${p.b}: record a is not the first row`);
      const same = ek(a.c) === ek(b.c);
      if (kind === 'exact' && (!same || digits(a.c.mobile ?? '') === '')) fails.push(`truth: exact pair ${p.a}/${p.b} does not share the exact-match key`);
      if (kind === 'likely' && same) fails.push(`truth: likely pair ${p.a}/${p.b} is an exact match`);
      const kb = new Set(bk(b.c, sz(b.c)));
      if (kind === 'likely' && !bk(a.c, sz(a.c)).some((k) => kb.has(k))) fails.push(`truth: likely pair ${p.a}/${p.b} shares no blocking key`);
    }
  }
  const blocks = new Map<string, string[]>();
  const exacts = new Map<string, string[]>();
  for (const c of custs) {
    const ref = c.customer_ref ?? '';
    for (const k of new Set(bk(c, sz(c)))) blocks.set(k, [...(blocks.get(k) ?? []), ref]);
    if (digits(c.mobile ?? '') !== '' && fold(c.name ?? '') !== '') exacts.set(ek(c), [...(exacts.get(ek(c)) ?? []), ref]);
  }
  for (const [k, refs] of blocks) {
    if (refs.length < 2) continue;
    if (refs.length > 2 || pairOf.get(refs[0] as string) !== refs[1]) fails.push(`truth: block ${k} holds ${refs.join(', ')}, which is not 1 truth pair`);
  }
  const exactSet = new Set(truth.exact.map((p) => `${p.a}/${p.b}`));
  for (const refs of exacts.values()) {
    if (refs.length < 2) continue;
    if (refs.length > 2 || !exactSet.has(`${refs[0]}/${refs[1]}`)) fails.push(`truth: customers ${refs.join(', ')} share the exact-match key outside the truth file`);
  }
  return fails;
}

// ----- FR-IMP-6 target counts, as planted in the 3 CSV files -----

export interface Counts {
  customers: number; missingZip: number; badPhone: number; customerNameBlank: number;
  visits: number; visitNoCustomer: number; visitDateUnreadable: number;
  equipment: number; equipmentNoAddress: number;
}

export function plantedCounts(files: Files): Counts {
  const custs = readCsvRecords(text(files, 'customers.csv'));
  const refs = new Set(custs.map((c) => c.customer_ref));
  const visits = readCsvRecords(text(files, 'visits.csv'));
  const equipment = readCsvRecords(text(files, 'equipment.csv'));
  const readable = (s: string): boolean => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  };
  const badPhone = (v: string): boolean => v !== '' && digits(v).length !== 10;
  return {
    customers: custs.length,
    missingZip: custs.filter((c) => c.zip === '').length,
    badPhone: custs.filter((c) => badPhone(c.mobile ?? '') || badPhone(c.home_phone ?? '')).length,
    customerNameBlank: custs.filter((c) => (c.name ?? '').trim() === '').length,
    visits: visits.length,
    visitNoCustomer: visits.filter((v) => !refs.has(v.customer_ref)).length,
    visitDateUnreadable: visits.filter((v) => !readable(v.date ?? '')).length,
    equipment: equipment.length,
    equipmentNoAddress: equipment.filter((e) => e.street === '' && e.house_number === '' && e.city === '' && e.zip === '').length,
  };
}

export function targetCountsCheck(files: Files): string[] {
  const got = plantedCounts(files);
  const fails: string[] = [];
  for (const k of Object.keys(got) as (keyof Counts)[]) {
    if (got[k] !== FR_IMP_6[k]) fails.push(`target-counts: ${k} ${got[k]}, FR-IMP-6 target ${FR_IMP_6[k]}`);
  }
  const flagged = got.missingZip + got.badPhone + got.customerNameBlank;
  if (flagged !== FR_IMP_6.customersFlagged) fails.push(`target-counts: ${flagged} flagged customers, target ${FR_IMP_6.customersFlagged} (1 problem each)`);
  const problems = flagged + got.visitNoCustomer + got.visitDateUnreadable + got.equipmentNoAddress;
  if (problems !== FR_IMP_6.problemRows) fails.push(`target-counts: ${problems} problem rows, target ${FR_IMP_6.problemRows}`);
  return fails;
}

// ----- the fixture: share-none and exact lookup (BUILD_PLAN D-3 step 5, R-BP1) -----

interface FixtureCustomer { ref: string; name: string; nameSearch: string; street: string; city: string; zip: string; houseNumber: number }
/** technician is null for an Unassigned story job (F-292), which then names its branch. */
interface FixtureJobRow { jobNumber: number; customer: string; technician: string | null; branch?: string; date: string; windowStart: string; windowEnd: string; status: string; arrivedAt: string | null }
export interface Fixture {
  customers: FixtureCustomer[];
  pilotJobs: FixtureJobRow[];
  pilotCalls: ({ at: string; visitRef: string } | { at: string; jobNumber: number })[];
  demoWeekJobs: FixtureJobRow[];
  memberships: { customer: string }[];
  sampleDayScript: { jobNumber: number }[];
}

/**
 * The customers the fixture names and the customers in the truth file's pairs share none, by customer_ref and by the
 * exact-match lookup key; every named customer resolves to exactly 1 customers.csv row by that key; and every
 * fixture row names a customer listed in the fixture's customers.
 */
export function shareNoneCheck(files: Files): string[] {
  const fails: string[] = [];
  const fx = JSON.parse(text(files, 'fixture.json')) as Fixture;
  const truth = parseTruth(text(files, 'truth.json'));
  const custs = readCsvRecords(text(files, 'customers.csv'));
  const byRef = new Map(custs.map((c) => [c.customer_ref ?? '', c]));
  const lk = (c: Cust): string => lookupKey(c.name ?? '', c.street ?? '', c.city ?? '', c.zip ?? '', c.house_number ?? '');
  const lookups = new Map<string, number>();
  for (const c of custs) lookups.set(lk(c), (lookups.get(lk(c)) ?? 0) + 1);
  const pairRefs = new Set([...truth.exact, ...truth.likely].flatMap((p) => [p.a, p.b]));
  const pairKeys = new Set([...pairRefs].map((r) => byRef.get(r)).filter((c): c is Cust => !!c).map(lk));
  const listed = new Map(fx.customers.map((c) => [c.ref, c]));
  const named: { where: string; ref: string }[] = [
    ...fx.customers.map((c) => ({ where: 'customers', ref: c.ref })),
    ...fx.pilotJobs.map((j) => ({ where: `pilotJobs ${j.jobNumber}`, ref: j.customer })),
    ...fx.demoWeekJobs.map((j) => ({ where: `demoWeekJobs ${j.jobNumber}`, ref: j.customer })),
    ...fx.memberships.map((m) => ({ where: 'memberships', ref: m.customer })),
  ];
  // F-203: a call's visit must be one the import writes (its customer is in customers.csv and its date reads), else the
  // world seed's source_ref lookup finds no row; no sentinel ref stands in for a missing visit.
  const visits = new Map(readCsvRecords(text(files, 'visits.csv')).map((v) => [v.visit_ref ?? '', v]));
  for (const call of fx.pilotCalls) {
    if (!('visitRef' in call)) continue;
    const v = visits.get(call.visitRef);
    if (!v || !byRef.has(v.customer_ref ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(v.date ?? '')) {
      fails.push(`share-none: fixture pilotCalls ${call.at} names visit ${call.visitRef}, which the import does not write`);
      continue;
    }
    named.push({ where: `pilotCalls ${call.at} ${call.visitRef}`, ref: v.customer_ref ?? '' });
  }
  for (const { where, ref } of named) {
    if (pairRefs.has(ref)) fails.push(`share-none: fixture ${where} names ${ref}, a customer of a planted duplicate pair`);
    if (where !== 'customers' && !where.startsWith('pilotCalls') && !listed.has(ref)) fails.push(`share-none: fixture ${where} names ${ref}, which fixture customers does not list`);
  }
  for (const fc of fx.customers) {
    const key = lookupKey(fc.name, fc.street, fc.city, fc.zip, fc.houseNumber);
    if (fc.nameSearch !== fold(fc.name)) fails.push(`share-none: fixture customer ${fc.ref} nameSearch is not the folded name`);
    if (pairKeys.has(key)) fails.push(`share-none: fixture customer ${fc.ref} has the lookup key of a planted pair customer`);
    // F-203: the key must resolve to the ref's own row, not merely to exactly 1 row.
    const own = byRef.get(fc.ref);
    if (!own) fails.push(`share-none: fixture customer ${fc.ref} is not in customers.csv`);
    else if (lk(own) !== key) fails.push(`share-none: fixture customer ${fc.ref}'s key is not the key of its own customers.csv row`);
    const n = lookups.get(key) ?? 0;
    if (n !== 1) fails.push(`share-none: fixture customer ${fc.ref} resolves to ${n} customers.csv rows, not exactly 1`);
  }
  return fails;
}

// ----- rates: on-time, no-one-home and call rates of the before and after periods of the pilot (SD-25) -----

export interface Rate { visits: number; arrived: number; onTime: number; noOneHome: number; calls: number }
export interface Rates { before: Rate; after: Rate; board7: Rate; weeks: { week: string; period: 'before' | 'after'; rate: Rate }[] }

const empty = (): Rate => ({ visits: 0, arrived: 0, onTime: 0, noOneHome: 0, calls: 0 });
export const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n * 1000) / d) / 10);

/**
 * The report view's rows (SD-25): imported visits dated Jun 1 to Aug 30, 2026 and the fixture's pilot jobs (Aug 31 to
 * Sep 14), on time = arrived at or before the window's end. board7 = the 7 days before Sep 15 (Sep 8 to 14, OI-25).
 */
export function sd25Rates(files: Files): Rates {
  const fx = JSON.parse(text(files, 'fixture.json')) as Fixture;
  const refs = new Set(readCsvRecords(text(files, 'customers.csv')).map((c) => c.customer_ref));
  const rows: { d: number; arrived: string | null; end: string; noh: boolean; ref: string }[] = [];
  for (const v of readCsvRecords(text(files, 'visits.csv'))) {
    if (!refs.has(v.customer_ref) || !/^\d{4}-\d{2}-\d{2}$/.test(v.date ?? '')) continue;
    let d: number;
    try { d = day(v.date as string); } catch { continue; }
    if (d < PILOT_FIRST || d > day('2026-08-30')) continue;
    rows.push({ d, arrived: v.arrived_at || null, end: v.window_end ?? '', noh: v.outcome === 'no_one_home', ref: v.visit_ref ?? '' });
  }
  for (const j of fx.pilotJobs) rows.push({ d: day(j.date), arrived: j.arrivedAt, end: j.windowEnd, noh: j.status === 'no_one_home', ref: `J${j.jobNumber}` });
  const callsByRef = new Map<string, number>();
  for (const c of fx.pilotCalls) {
    const r = 'visitRef' in c ? c.visitRef : `J${c.jobNumber}`;
    callsByRef.set(r, (callsByRef.get(r) ?? 0) + 1);
  }
  const before = empty();
  const after = empty();
  const board7 = empty();
  const weeks = new Map<number, Rate>();
  const add = (r: Rate, x: (typeof rows)[number]): void => {
    r.visits++;
    if (x.noh) r.noOneHome++;
    if (x.arrived) { r.arrived++; if (minutesOf(x.arrived) <= minutesOf(x.end)) r.onTime++; }
    r.calls += callsByRef.get(x.ref) ?? 0;
  };
  for (const x of rows) {
    const w = weekStart(x.d);
    add(w < AFTER_FIRST ? before : after, x);
    if (!weeks.has(w)) weeks.set(w, empty());
    add(weeks.get(w) as Rate, x);
    if (x.d >= day('2026-09-08') && x.d <= day('2026-09-14')) add(board7, x);
  }
  return {
    before, after, board7,
    weeks: [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([w, rate]) => ({
      week: new Date(w * 86_400_000).toISOString().slice(0, 10), period: w < AFTER_FIRST ? 'before' as const : 'after' as const, rate,
    })),
  };
}

export const onTimePct = (r: Rate): number => pct(r.onTime, r.arrived);
export const nohPct = (r: Rate): number => pct(r.noOneHome, r.visits);
export const callsPer100 = (r: Rate): number => pct(r.calls, r.visits);

/** The pilot's bounds (SD-25): before near 74% on time and 6% no one home, calls near twice the after rate; after >= 90%, < 3%. */
export function ratesCheck(files: Files): string[] {
  const r = sd25Rates(files);
  const fails: string[] = [];
  const near = (v: number, want: number, tol: number) => Math.abs(v - want) <= tol;
  if (!near(onTimePct(r.before), 74, 1)) fails.push(`sd25: before period on time ${onTimePct(r.before)}%, want near 74%`);
  if (!near(nohPct(r.before), 6, 0.5)) fails.push(`sd25: before period no one home ${nohPct(r.before)}%, want near 6%`);
  for (const [name, x] of [['after period', r.after], ['Sep 8 to 14 (board 7-day)', r.board7]] as const) {
    if (x.visits === 0) fails.push(`sd25: ${name} has no rows`);
    if (onTimePct(x) < 90) fails.push(`sd25: ${name} on time ${onTimePct(x)}%, want at least 90%`);
    if (nohPct(x) >= 3) fails.push(`sd25: ${name} no one home ${nohPct(x)}%, want under 3%`);
  }
  for (const w of r.weeks.filter((x) => x.period === 'after')) {
    if (onTimePct(w.rate) < 90 || nohPct(w.rate) >= 3) fails.push(`sd25: week ${w.week} on time ${onTimePct(w.rate)}%, no one home ${nohPct(w.rate)}%`);
  }
  const ratio = r.after.calls === 0 ? 0 : (r.before.calls / r.before.visits) / (r.after.calls / r.after.visits);
  if (!near(ratio, 2, 0.15)) fails.push(`sd25: before-period calls per visit are ${ratio.toFixed(2)} times the after period's, want near 2`);
  return fails;
}

// ----- the booking windows: the most jobs each of Columbus's 5 two-hour windows may hold (FR-BOOK-6; F-201) -----

/**
 * No Columbus weekday window holds more jobs than FR-BOOK-6 allows (12, 12, 11, 11, 10 in time order), in the pilot
 * jobs and the demo-week jobs alike. `branchOf` maps an employee number to its branch (technicians.json). The check
 * fails input outside its model (F-239): a job whose technician is not in the roster, a window start off the 5-window
 * grid (a window is its start and its length: a 4-hour window counts against no 2-hour limit and falls only on a seeded
 * 4-hour day, F-1653), and a Columbus population too small to mean the limits were tested (the floor is 1 full day of capacity).
 */
const COLUMBUS_JOBS_FLOOR = FR_BOOK_6_LIMITS.reduce((a, b) => a + b, 0);

export function bookingWindowCheck(files: Files, branchOf: (employeeNumber: string) => string | undefined): string[] {
  const fx = JSON.parse(text(files, 'fixture.json')) as Fixture;
  const fails: string[] = [];
  const count = new Map<string, number>();
  let columbus = 0;
  for (const j of [...fx.pilotJobs, ...fx.demoWeekJobs]) {
    // A window is its start and its length, as the world seed keys it (world-seed.ts windowKey; F-1653).
    const length = minutesOf(j.windowEnd) - minutesOf(j.windowStart);
    const w = (minutesOf(j.windowStart) - 8 * 60) / 120;
    const twoHour = length === 120 && Number.isInteger(w) && w >= 0 && w < FR_BOOK_6_LIMITS.length;
    const fourHour = length === 240 && FOUR_HOUR_WINDOWS.some(([a]) => a * 60 === minutesOf(j.windowStart));
    if (!twoHour && !fourHour) { fails.push(`booking-windows: job ${j.jobNumber} on ${j.date} runs ${j.windowStart}-${j.windowEnd}, which is not one of the 5 two-hour windows or the 4 four-hour windows`); continue; }
    const branch = j.technician === null ? j.branch : branchOf(j.technician);
    if (branch === undefined) { fails.push(`booking-windows: job ${j.jobNumber} names technician ${j.technician}, who is not in the roster`); continue; }
    // A 4-hour window has no per-window limit (SPECIFICATIONS arrival_window.capacity) and is booked only on a seeded 4-hour day.
    if (fourHour) {
      if (branch !== PEAK_DAYS.branch || !(PEAK_DAYS.dates as readonly string[]).includes(j.date)) fails.push(`booking-windows: job ${j.jobNumber} has a 4-hour window on ${j.date}, which is not a seeded 4-hour day of ${branch}`);
      continue;
    }
    if (branch !== 'columbus') continue;
    columbus++;
    const k = `${j.date}|${j.windowStart}`;
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  if (columbus < COLUMBUS_JOBS_FLOOR) fails.push(`booking-windows: only ${columbus} Columbus jobs, the check needs at least ${COLUMBUS_JOBS_FLOOR} (1 full day) to mean anything`);
  for (const [k, n] of count) {
    const [date, start] = k.split('|') as [string, string];
    const limit = FR_BOOK_6_LIMITS[(minutesOf(start) - 8 * 60) / 120];
    if (limit !== undefined && n > limit) fails.push(`booking-windows: ${date} Columbus window ${start}: ${n} bookings, FR-BOOK-6 limit ${limit}`);
  }
  return fails;
}
