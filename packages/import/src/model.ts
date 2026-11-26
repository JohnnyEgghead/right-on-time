// SPDX-License-Identifier: AGPL-3.0-or-later
// The validate and match stages over the parsed export (SPECIFICATIONS section 6.7, SD-24; FR-IMP-2, FR-IMP-3,
// FR-IMP-6): every row becomes an import row or a problem row, and the customers' duplicate pairs are found. Pure and
// deterministic: the reference rows come in as data, nothing here reads a database or a clock, so a dry run and a
// real run of the same export build the same model.
//
// The 6 problem reasons (import_problem_row.reason) and what happens to each row:
//   customers.csv  missing_zip, bad_phone, customer_name_blank   imported and flagged (flagged_entity_id = the customer)
//   visits.csv     visit_no_customer, visit_date_unreadable      not imported
//   equipment.csv  equipment_no_address                          not imported
// A row has at most 1 problem row (its primary key is run, file and row number); when a row could have 2 reasons the
// first in that table's order is recorded. A visit whose window or arrival time cannot be read counts as
// visit_date_unreadable: its date and time cannot be placed. Anything else the layout cannot express (an unknown
// street, a house number that is not a number, an outcome outside done and no_one_home) is a DataError that fails the
// run: those are not old-system data problems the 6 reasons describe, and a guessed row would be a wrong one.
import { foldStreetName } from '@bw/db';
import { atLocal, Temporal, type Instant } from '@bw/time';
import { parseExport, type CustomerCsvRow, type ExportFile, type ExportFiles, type ParsedExport } from './layout.ts';
import { matchCustomers, type MatchCustomer, type MatchPair } from './match.ts';

export const PROBLEM_REASONS = [
  'visit_no_customer', 'missing_zip', 'bad_phone', 'visit_date_unreadable', 'equipment_no_address', 'customer_name_blank',
] as const;
export type ProblemReason = (typeof PROBLEM_REASONS)[number];

export class DataError extends Error {
  constructor(file: ExportFile, rowNumber: number, what: string) {
    super(`${file}: row ${rowNumber}: ${what}`);
    this.name = 'DataError';
  }
}

/** The reference rows the import resolves against (the reference seed's, D-3 step 1). */
export interface ImportReference {
  streets: readonly { id: string; name: string; city: string; zip: string; branchId: string; points: readonly (readonly [number, number])[] }[];
  /** Each branch's zone (branch.zone): past visits and customers without a zone of their own are in it. */
  branchZones: ReadonlyMap<string, string>;
  /** Seeded technicians by name (past_visit.technician_id is set when the name is one; FR-REP-7). */
  technicianIds: ReadonlyMap<string, string>;
}

export interface ImportCustomer {
  index: number;
  ref: string;
  rowNumber: number;
  branchId: string;
  name: string;
  nameSearch: string;
  mobile: string | null;
  homePhone: string | null;
  email: string | null;
  gettingIn: string | null;
  /** null for an empty cell (SD-24; the generator leaves some empty, F-206 (d)): never invented. */
  homeType: string | null;
  textsOn: boolean;
  textLanguage: 'en' | 'es';
  zone: string;
  streetId: string;
  houseNumber: number;
  lon: number;
  lat: number;
  customerSince: string;
}

interface ImportVisit {
  customerIndex: number;
  technicianName: string;
  technicianId: string | null;
  date: string;
  zone: string;
  windowStart: Instant;
  windowEnd: Instant;
  arrivedAt: Instant | null;
  outcome: 'done' | 'no_one_home';
  /**
   * The old system's service text (section 3 past_visit.service_text): visits.csv `service`, for example "Water heater
   * repair" (F-257).
   */
  serviceText: string;
  /** visits.csv `work_done` (section 3 past_visit.work_done, F-673): the old system's work-done cell; an empty cell is null. */
  workDone: string | null;
  sourceRef: string;
}

interface ImportEquipment {
  customerIndex: number;
  type: string;
  year: number | null;
  location: string | null;
  details: string | null;
}

export interface ImportProblem {
  file: ExportFile;
  rowNumber: number;
  reason: ProblemReason;
  /** The flagged customer's index for a flagged customer row; null for a row not imported. */
  customerIndex: number | null;
  example: string;
}

/** The counts an import run's report states, such as customers clean or flagged and visits imported or not (FR-IMP-6, the import target table). */
export interface ImportCounts {
  customers: { total: number; clean: number; flagged: number };
  visits: { total: number; imported: number; notImported: number };
  equipment: { total: number; imported: number; notImported: number };
  problems: { total: number; byReason: Record<ProblemReason, number> };
  duplicates: { total: number; exact: number; likely: number };
}

export interface ImportModel {
  exportedAt: string | null;
  customers: ImportCustomer[];
  visits: ImportVisit[];
  equipment: ImportEquipment[];
  problems: ImportProblem[];
  pairs: MatchPair[];
  /** How many candidate pairs were scored inside the blocks: the work that blocking leaves (OQ-19). */
  comparisons: number;
  counts: ImportCounts;
}

const digits = (s: string) => s.replace(/\D/g, '');

/** E.164 for a 10-digit US number (or 11 digits with the leading 1); null otherwise. */
export function toE164(cell: string): string | null {
  const d = digits(cell);
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

/** A real calendar date in YYYY-MM-DD, or null. */
function readDate(cell: string): string | null {
  if (!DATE_RE.test(cell)) return null;
  try {
    return Temporal.PlainDate.from(cell, { overflow: 'reject' }).toString();
  } catch {
    return null;
  }
}

function readTime(cell: string): string | null {
  if (!TIME_RE.test(cell)) return null;
  const [h, m] = cell.split(':').map(Number) as [number, number];
  return h <= 23 && m <= 59 ? cell : null;
}

const empty = (s: string) => (s === '' ? null : s);

class Streets {
  private readonly exact = new Map<string, ImportReference['streets'][number]>();
  private readonly noZip = new Map<string, ImportReference['streets'][number] | 'ambiguous'>();
  constructor(rows: ImportReference['streets']) {
    for (const s of rows) {
      this.exact.set(`${s.name}|${s.city}|${s.zip}`, s);
      const k = `${s.name}|${s.city}`;
      this.noZip.set(k, this.noZip.has(k) ? 'ambiguous' : s);
    }
  }
  /** By street, city and ZIP; a row with no ZIP by street and city, when the list holds that pair once. */
  resolve(name: string, city: string, zip: string) {
    if (zip !== '') return this.exact.get(`${name}|${city}|${zip}`) ?? null;
    const s = this.noZip.get(`${name}|${city}`);
    return s === undefined || s === 'ambiguous' ? null : s;
  }
}

function customerProblem(c: CustomerCsvRow): { reason: ProblemReason; value: string } | null {
  if (c.zip === '') return { reason: 'missing_zip', value: c.zip };
  if (c.mobile !== '' && toE164(c.mobile) === null) return { reason: 'bad_phone', value: c.mobile };
  if (c.name.trim() === '') return { reason: 'customer_name_blank', value: c.name };
  return null;
}

/** The stored example: the row's name, or its old record reference when it has none, then the offending value. */
function example(label: string, value: string): string {
  return `${label}: ${value}`;
}

export function buildModel(parsed: ParsedExport, ref: ImportReference): ImportModel {
  const streets = new Streets(ref.streets);
  const problems: ImportProblem[] = [];
  const customers: ImportCustomer[] = [];
  const byRef = new Map<string, number>();

  parsed.customers.forEach((c, index) => {
    if (byRef.has(c.customer_ref)) throw new DataError('customers.csv', c.rowNumber, `customer_ref ${c.customer_ref} is repeated`);
    const street = streets.resolve(c.street, c.city, c.zip);
    if (!street) throw new DataError('customers.csv', c.rowNumber, `street ${JSON.stringify(`${c.street}, ${c.city} ${c.zip}`)} is not on the street list`);
    const house = Number(c.house_number);
    if (!/^\d+$/.test(c.house_number) || house < 1) throw new DataError('customers.csv', c.rowNumber, `house_number ${JSON.stringify(c.house_number)} is not a number`);
    if (c.text_language !== 'en' && c.text_language !== 'es') throw new DataError('customers.csv', c.rowNumber, `text_language ${JSON.stringify(c.text_language)}`);
    if (c.texts_on !== 'yes' && c.texts_on !== 'no') throw new DataError('customers.csv', c.rowNumber, `texts_on ${JSON.stringify(c.texts_on)}`);
    const since = readDate(c.customer_since);
    if (!since) throw new DataError('customers.csv', c.rowNumber, `customer_since ${JSON.stringify(c.customer_since)}`);
    const zone = c.time_zone !== '' ? c.time_zone : ref.branchZones.get(street.branchId);
    if (!zone) throw new DataError('customers.csv', c.rowNumber, `branch ${street.branchId} has no zone`);
    const point = street.points[(house - 1) % street.points.length];
    if (!point) throw new DataError('customers.csv', c.rowNumber, 'the street has no point');
    byRef.set(c.customer_ref, index);
    customers.push({
      index, ref: c.customer_ref, rowNumber: c.rowNumber, branchId: street.branchId,
      name: c.name, nameSearch: foldStreetName(c.name),
      mobile: toE164(c.mobile), homePhone: empty(c.home_phone), email: empty(c.email), gettingIn: empty(c.getting_in),
      homeType: empty(c.home_type), textsOn: c.texts_on === 'yes', textLanguage: c.text_language, zone,
      streetId: street.id, houseNumber: house, lon: point[0], lat: point[1], customerSince: since,
    });
    const p = customerProblem(c);
    if (p) {
      problems.push({
        file: 'customers.csv', rowNumber: c.rowNumber, reason: p.reason, customerIndex: index,
        example: example(c.name.trim() === '' ? c.customer_ref : c.name, p.value),
      });
    }
  });

  const instants = new Map<string, Instant>();
  const at = (date: string, time: string, zone: string): Instant => {
    const k = `${date}T${time}@${zone}`;
    let v = instants.get(k);
    if (!v) {
      v = atLocal(date, time, zone, 'compatible');
      instants.set(k, v);
    }
    return v;
  };

  const visits: ImportVisit[] = [];
  for (const v of parsed.visits) {
    const ci = byRef.get(v.customer_ref);
    if (ci === undefined) {
      problems.push({ file: 'visits.csv', rowNumber: v.rowNumber, reason: 'visit_no_customer', customerIndex: null, example: example(v.visit_ref, v.customer_ref) });
      continue;
    }
    const date = readDate(v.date);
    const start = readTime(v.window_start);
    const end = readTime(v.window_end);
    const arrived = v.arrived_at === '' ? '' : readTime(v.arrived_at);
    if (!date || !start || !end || arrived === null) {
      const bad = !date ? v.date : !start ? v.window_start : !end ? v.window_end : v.arrived_at;
      problems.push({ file: 'visits.csv', rowNumber: v.rowNumber, reason: 'visit_date_unreadable', customerIndex: null, example: example(v.visit_ref, bad) });
      continue;
    }
    if (v.outcome !== 'done' && v.outcome !== 'no_one_home') throw new DataError('visits.csv', v.rowNumber, `outcome ${JSON.stringify(v.outcome)}`);
    const customer = customers[ci] as ImportCustomer;
    const zone = ref.branchZones.get(customer.branchId);
    if (!zone) throw new DataError('visits.csv', v.rowNumber, `branch ${customer.branchId} has no zone`);
    visits.push({
      customerIndex: ci, technicianName: v.technician, technicianId: ref.technicianIds.get(v.technician) ?? null,
      date, zone, windowStart: at(date, start, zone), windowEnd: at(date, end, zone),
      arrivedAt: arrived === '' ? null : at(date, arrived, zone), outcome: v.outcome,
      serviceText: v.service, workDone: v.work_done.trim() === '' ? null : v.work_done, sourceRef: v.visit_ref,
    });
  }

  const equipment: ImportEquipment[] = [];
  for (const e of parsed.equipment) {
    if (e.street === '' || e.house_number === '') {
      problems.push({ file: 'equipment.csv', rowNumber: e.rowNumber, reason: 'equipment_no_address', customerIndex: null, example: example(e.equipment_ref, `${e.house_number} ${e.street}`.trim()) });
      continue;
    }
    const ci = byRef.get(e.customer_ref);
    if (ci === undefined) throw new DataError('equipment.csv', e.rowNumber, `customer_ref ${e.customer_ref} is in no customer row`);
    if (e.year !== '' && !/^\d{4}$/.test(e.year)) throw new DataError('equipment.csv', e.rowNumber, `year ${JSON.stringify(e.year)}`);
    equipment.push({ customerIndex: ci, type: e.type, year: e.year === '' ? null : Number(e.year), location: empty(e.location), details: empty(e.details) });
  }

  const match = matchCustomers(matchInputs(parsed, customers));

  problems.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : x.rowNumber - y.rowNumber));
  return {
    exportedAt: parsed.exportedAt, customers, visits, equipment, problems, pairs: match.pairs, comparisons: match.comparisons,
    counts: countsOf(parsed, customers, visits, equipment, problems, match.pairs),
  };
}

/** The match stage's input: each imported customer with its ZIP cell and mobile digits as the file holds them. */
export function matchInputs(parsed: ParsedExport, customers: readonly ImportCustomer[]): MatchCustomer[] {
  return customers.map((c) => ({
    index: c.index, nameSearch: c.nameSearch, streetId: c.streetId, houseNumber: c.houseNumber,
    zipCell: parsed.customers[c.index]?.zip ?? '', mobileDigits: digits(parsed.customers[c.index]?.mobile ?? ''),
  }));
}

function countsOf(
  parsed: ParsedExport, customers: ImportCustomer[], visits: ImportVisit[], equipment: ImportEquipment[],
  problems: ImportProblem[], pairs: MatchPair[],
): ImportCounts {
  const byReason = Object.fromEntries(PROBLEM_REASONS.map((r) => [r, 0])) as Record<ProblemReason, number>;
  for (const p of problems) byReason[p.reason]++;
  const flagged = new Set(problems.filter((p) => p.customerIndex !== null).map((p) => p.customerIndex)).size;
  const exact = pairs.filter((p) => p.kind === 'exact').length;
  return {
    customers: { total: parsed.customers.length, clean: customers.length - flagged, flagged },
    visits: { total: parsed.visits.length, imported: visits.length, notImported: parsed.visits.length - visits.length },
    equipment: { total: parsed.equipment.length, imported: equipment.length, notImported: parsed.equipment.length - equipment.length },
    problems: { total: problems.length, byReason },
    duplicates: { total: pairs.length, exact, likely: pairs.length - exact },
  };
}

/** Parse, validate and match in 1 call (the stages a run's progress reports separately run them 1 by 1). */
export function modelOf(files: ExportFiles, ref: ImportReference): ImportModel {
  return buildModel(parseExport(files), ref);
}
