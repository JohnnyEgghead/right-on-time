// SPDX-License-Identifier: AGPL-3.0-or-later
// @bw/import without a database: the parse stage's fixed layout, the validate stage's reasons and examples, and the
// match stage on the real generator output (seed 20260915) against the committed planted-truth file.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { foldStreetName } from '@bw/db';
import { DEFAULT_DIR } from '../../../ci/data-assets.ts';
import { readStreetList } from '../../db/src/street-list.ts';
import { parseCsv } from './csv.ts';
import { LayoutError, parseExport } from './layout.ts';
import { blockingKeys, LIKELY_THRESHOLD, likelyWhy, matchCustomers, type MatchCustomer } from './match.ts';
import { buildModel, DataError, toE164, type ImportModel, type ImportReference } from './model.ts';
import { reportOf } from './runner.ts';
import { jaroWinkler, nameScore } from './similarity.ts';
import { generatedWorld, type GeneratedWorld, type Truth } from './testing/world.ts';

/**
 * F-275: the full generated world is built once per file, in a hook, and every test that needs it reads it.
 * Measured on the Mac: generate ~0.7 s, parse ~0.3 s, buildModel ~1.9 s (about 3 s in all). In the CI container the
 * same work took 3 to 4 times as long (11.0 s for it plus the pair check, 6.8 s for the 2nd test, each of which then
 * built the model itself). 60 s is about 5 times the slowest of those and equals the database suites' testTimeout
 * (ci/gates/G-CI7/vitest.db.config.ts), so a slower host fails by a real defect, not by the clock.
 */
const FULL_WORLD_TIMEOUT_MS = 60_000;

const HEADER = 'customer_ref,name,mobile,home_phone,email,street,house_number,city,zip,text_language,time_zone,texts_on,customer_since,home_type,getting_in,exported_at';
const VH = 'visit_ref,customer_ref,date,window_start,window_end,arrived_at,outcome,technician,service,work_done';
const EH = 'equipment_ref,customer_ref,street,house_number,city,zip,type,year,location,details';
const STAMP = '2026-08-31T05:00:00-04:00';
const REF: ImportReference = {
  streets: [
    { id: 's-kent', name: 'Kent Road', city: 'Upper Arlington', zip: '43221', branchId: 'columbus', points: [[-83.1, 40.0], [-83.2, 40.1]] },
    { id: 's-high', name: 'High Street', city: 'Columbus', zip: '43215', branchId: 'columbus', points: [[-83.0, 39.96]] },
  ],
  branchZones: new Map([['columbus', 'America/New_York']]),
  technicianIds: new Map([['Maria Santos', 't-maria']]),
};
const cust = (ref: string, name: string, mobile: string, street: string, house: string, zip: string, city = 'Upper Arlington', homeType = '') =>
  `${ref},${name.includes(',') || name.includes('"') ? `"${name.replace(/"/g, '""')}"` : name},${mobile},,,${street},${house},${city},${zip},en,,yes,2016-09-12,${homeType},,${STAMP}`;

function tiny(customers: string[], visits: string[] = [], equipment: string[] = []) {
  return {
    'customers.csv': [HEADER, ...customers].join('\n') + '\n',
    'visits.csv': [VH, ...visits].join('\n') + '\n',
    'equipment.csv': [EH, ...equipment].join('\n') + '\n',
  };
}

describe('parse: the fixed column layout (SD-24)', () => {
  // why: FR-IMP-1
  it('reads RFC 4180 cells with quotes, commas and line breaks, and numbers rows by their first file line', () => {
    const rows = parseCsv('x.csv', 'a,b\n"1,2","say ""hi"""\n"multi\nline",z\n');
    expect(rows).toEqual([{ line: 1, cells: ['a', 'b'] }, { line: 2, cells: ['1,2', 'say "hi"'] }, { line: 3, cells: ['multi\nline', 'z'] }]);
  });

  // why: FR-IMP-1
  it('refuses a header that is not the layout, a short row and a broken quote, naming the file and line', () => {
    const ok = tiny([cust('C1', 'Ann Lee', '', 'High Street', '12', '43215', 'Columbus')]);
    expect(() => parseExport({ ...ok, 'customers.csv': ok['customers.csv'].replace('home_type', 'kind') })).toThrow(LayoutError);
    expect(() => parseExport({ ...ok, 'visits.csv': `${VH}\nV1,C1,2020-01-01\n` })).toThrow(/visits\.csv: line 2: 3 cells/);
    expect(() => parseExport({ ...ok, 'equipment.csv': `${EH}\n"E1,C1\n` })).toThrow(/unterminated/);
  });

  // why: FR-IMP-1
  it('copies exported_at at parse, and refuses an export with 2 different stamps', () => {
    const one = parseExport(tiny([cust('C1', 'Ann Lee', '', 'High Street', '12', '43215', 'Columbus')]));
    expect(one.exportedAt).toBe(STAMP);
    const two = tiny([cust('C1', 'Ann Lee', '', 'High Street', '12', '43215', 'Columbus'), cust('C2', 'Bo Lee', '', 'High Street', '14', '43215', 'Columbus').replace(STAMP, '2026-09-01T05:00:00-04:00')]);
    expect(() => parseExport(two)).toThrow(/2 different values/);
  });
});

describe('validate: the 6 problem reasons and their examples (FR-IMP-2)', () => {
  // why: FR-IMP-2
  it('flags customer rows (imported) and refuses visit and equipment rows (not imported), with the stored example', () => {
    const m = buildModel(parseExport(tiny(
      [
        cust('C1', 'Earl Mott', '(614) 555-01', 'High Street', '7', '43215', 'Columbus'),
        cust('C2', 'Alicia Keita', '(614) 555-0190', 'High Street', '9', '', 'Columbus'),
        cust('C3', '', '(614) 555-0191', 'High Street', '11', '43215', 'Columbus'),
        cust('C4', 'Ann Lee', '(614) 555-0192', 'High Street', '13', '43215', 'Columbus', 'Townhouse'),
      ],
      [
        'V1,C9,2021-03-01,08:00,12:00,08:30,done,Maria Santos,Furnace tune-up,Cleaned the burners.',
        'V2,C4,2021-02-30,08:00,12:00,08:30,done,Maria Santos,Furnace tune-up,Cleaned the burners.',
        'V3,C4,2021-03-01,08:00,12:00,,no_one_home,Maria Santos,Furnace tune-up,No one home.',
      ],
      ['E1,C4,,,,,furnace,2019,basement,Gas furnace', 'E2,C4,High Street,13,Columbus,43215,furnace,2019,basement,'],
    )), REF);
    expect(m.problems.map((p) => [p.file, p.rowNumber, p.reason, p.customerIndex, p.example])).toEqual([
      ['customers.csv', 2, 'bad_phone', 0, 'Earl Mott: (614) 555-01'],
      ['customers.csv', 3, 'missing_zip', 1, 'Alicia Keita: '],
      ['customers.csv', 4, 'customer_name_blank', 2, 'C3: '],
      ['equipment.csv', 2, 'equipment_no_address', null, 'E1: '],
      ['visits.csv', 2, 'visit_no_customer', null, 'V1: C9'],
      ['visits.csv', 3, 'visit_date_unreadable', null, 'V2: 2021-02-30'],
    ]);
    expect(m.counts.customers).toEqual({ total: 4, clean: 1, flagged: 3 });
    expect(m.counts.visits).toEqual({ total: 3, imported: 1, notImported: 2 });
    expect(m.counts.equipment).toEqual({ total: 2, imported: 1, notImported: 1 });
    expect(m.customers.map((c) => c.mobile)).toEqual([null, '+16145550190', '+16145550191', '+16145550192']);
    expect(m.visits[0]).toMatchObject({ serviceText: 'Furnace tune-up', arrivedAt: null, technicianId: 't-maria', zone: 'America/New_York' });
    expect(m.equipment[0]).toEqual({ customerIndex: 3, type: 'furnace', year: 2019, location: 'basement', details: null });
  });

  // why: FR-IMP-2
  it('stops the run with a named DataError for what no reason describes, never a guessed row', () => {
    expect(() => buildModel(parseExport(tiny([cust('C1', 'Ann Lee', '', 'Nowhere Lane', '12', '43215', 'Columbus')])), REF)).toThrow(DataError);
    expect(() => buildModel(parseExport(tiny([cust('C1', 'Ann Lee', '', 'High Street', '12b', '43215', 'Columbus')])), REF)).toThrow(/house_number/);
  });

  // why: F-206
  it('keeps an empty home type null and copies a given one, without inventing a value', () => {
    const m = buildModel(parseExport(tiny([
      cust('C1', 'Ann Lee', '', 'High Street', '12', '43215', 'Columbus', ''),
      cust('C2', 'Bo Ray', '', 'High Street', '14', '43215', 'Columbus', '"Single family, basement"'),
    ])), REF);
    expect(m.customers.map((c) => c.homeType)).toEqual([null, 'Single family, basement']);
  });

  // why: FR-IMP-2
  it('reads phones as E.164 and refuses too few digits', () => {
    expect(toE164('(614) 555-0107')).toBe('+16145550107');
    expect(toE164('614-555-0107')).toBe('+16145550107');
    expect(toE164('(614) 555-01')).toBeNull();
  });
});

describe('match: exact and likely pairs (FR-IMP-3, F-205)', () => {
  let world: GeneratedWorld;
  let m: ImportModel;
  beforeAll(() => {
    world = generatedWorld();
    const zones = new Map(['columbus', 'dayton', 'springfield'].map((b) => [b, 'America/New_York']));
    m = buildModel(parseExport(world.files), { streets: realStreets(), branchZones: zones, technicianIds: new Map() });
  }, FULL_WORLD_TIMEOUT_MS);

  const c = (index: number, name: string, streetId: string, house: number, zip: string, mobile: string): MatchCustomer =>
    ({ index, nameSearch: foldStreetName(name), streetId, houseNumber: house, zipCell: zip, mobileDigits: mobile.replace(/\D/g, '') });

  // why: FR-IMP-9, F-205
  it("puts Kathleen O'Brien-Miller and Kathy OBrien in 1 block under the generator's fold and lists them", () => {
    const kathleen = c(0, "Kathleen O'Brien-Miller", 's-kent', 57, '43221', '(614) 555-0177');
    const kathy = c(1, 'Kathy OBrien', 's-kent', 57, '43221', '(614) 555-0177');
    expect(kathleen.nameSearch).toBe('kathleen obrien miller');
    expect(blockingKeys(kathleen).filter((k) => blockingKeys(kathy).includes(k))).toEqual(['L|obrien|43221']);
    expect(matchCustomers([kathleen, kathy]).pairs).toEqual([{ kind: 'likely', a: 0, b: 1, why: 'phone_and_house_number_and_street_match_name_differ', score: expect.any(Number) }]);
    // under the other fold SPECIFICATIONS gives (apostrophes and hyphens kept) the 2 share no token: the pair is lost
    const keep = (s: string) => s.toLowerCase().split(' ');
    expect(keep("Kathleen O'Brien-Miller").filter((t) => keep('Kathy OBrien').includes(t))).toEqual([]);
  });

  // why: FR-IMP-3
  it('an exact pair needs the same folded name, street, house number and mobile digits; record A is the earlier row', () => {
    const a = c(3, 'MELANIE VAUGHN', 's1', 3709, '43235', '(614) 555-0107');
    const b = c(9, 'Melanie Vaughn', 's1', 3709, '43235', '614-555-0107');
    expect(matchCustomers([b, a]).pairs).toEqual([{ kind: 'exact', a: 3, b: 9, why: 'exact_match', score: 1 }]);
    expect(matchCustomers([a, { ...b, houseNumber: 3711 }]).pairs.map((p) => p.kind)).toEqual(['likely']);
    // a blank name is no evidence: 2 blank-name rows at 1 address are no pair
    expect(matchCustomers([c(0, '', 's1', 1, '1', ''), c(1, '', 's1', 1, '1', '')]).pairs).toEqual([]);
  });

  // why: F-265, FR-IMP-11
  it('spells why a likely pair is listed as the approved page says it: what matches, then what differs', () => {
    // "Listed because the phone number and house number match, but the name and street spelling differ."
    const a = c(0, 'Dolores Whitfield', 's-maple', 412, '43204', '(614) 555-0142');
    const b = c(1, 'Delores Whitfeld', 's-mapel', 412, '43204', '(614) 555-0142');
    expect(likelyWhy(a, b)).toBe('phone_and_house_number_match_name_and_street_differ');
    expect(likelyWhy(a, { ...b, mobileDigits: '' })).toBe('house_number_match_phone_and_name_and_street_differ');
    expect(likelyWhy({ ...a, mobileDigits: '' }, { ...b, mobileDigits: '', streetId: 's-maple' })).toBe('house_number_and_street_match_name_differ');
    expect(likelyWhy(a, { ...a, index: 1, mobileDigits: '' })).toBe('house_number_and_name_and_street_match_phone_differ');
  });

  // why: FR-IMP-3
  it('scores nicknames and misspellings above the threshold and 2 people sharing only a surname below it', () => {
    expect(nameScore('bob kerr', 'robert kerr')).toBeGreaterThanOrEqual(LIKELY_THRESHOLD);
    expect(nameScore('john smith', 'john smtih')).toBeGreaterThan(0.9);
    expect(nameScore('mary smith', 'john smith')).toBeLessThan(LIKELY_THRESHOLD);
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 3);
  });

  // why: FR-IMP-3, FR-IMP-6, F-205
  it('on the real generator output finds exactly the truth file: 812 exact and 428 likely pairs, none outside it', () => {
    const committed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '..', '..', 'generator', 'truth.json'), 'utf8')) as Truth;
    expect(world.truth).toEqual(committed);
    const report = reportOf(m);
    const key = (p: { a: string; b: string }) => `${p.a}:${p.b}`;
    expect(report.pairs.exact.map(key)).toEqual(committed.exact.map(key));
    expect(report.pairs.likely.map(key)).toEqual(committed.likely.map(key));
    expect(m.pairs.filter((p) => p.kind === 'likely').every((p) => p.score >= LIKELY_THRESHOLD)).toBe(true);
  }, FULL_WORLD_TIMEOUT_MS);

  // why: OQ-19
  it('matches likely duplicates within blocking keys only, and the measured time is recorded per D-13', () => {
    // 428 scored comparisons on 18,400 customers, where all pairs would be 169,270,800 (C13)
    expect(m.customers.length).toBe(18_400);
    expect(m.comparisons).toBe(428);
    const record = readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'docs', 'build', 'spikes', 'P2-IMPORT.md'), 'utf8');
    expect(record).toMatch(/^Verdict: PASS /m);
    expect(record).toMatch(/^Measured: match stage median [\d.]+ ms .* on 18,400 customers; 428 scored comparisons in blocks/m);
  }, FULL_WORLD_TIMEOUT_MS);
});

/** The real bundled street list as reference rows (ids only need to be stable here). */
function realStreets(): ImportReference['streets'] {
  return readStreetList(path.join(DEFAULT_DIR, 'street-list.json'))
    .map((s) => ({ id: `${s.name}|${s.city}|${s.zip}`, name: s.name, city: s.city, zip: s.zip, branchId: s.branch, points: s.points }));
}
