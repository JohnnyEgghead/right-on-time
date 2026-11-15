// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { foldStreetName as fold } from '../../db/src/street-list.ts';
import {
  areasOfCityFrom, bookingWindowCheck, buildManifest, checkManifest, nohPct, onTimePct, phoneRangeScan, plantedCounts, ratesCheck, sd25Rates,
  FR_IMP_6, shareNoneCheck, targetCountsCheck, truthCheck, type Files, type Fixture,
} from './checks.ts';
import { parseCsv, readCsvRecords, toCsv } from './csv.ts';
import { CITY_AREAS, digits, EXPORTED_AT, FILES, generate, STORY_JOBS, STORY_JOBS_NOT_PINNED, TARGETS, type Output } from './generate.ts';
import { loadInputs, MANIFEST_FILE, PKG, readManifest, TRUTH_FILE } from './io.ts';
import { HOME_TYPES } from './pools.ts';
import { SEED } from './prng.ts';
import { DATA_DIR } from '../../db/src/data-asset.ts';
import { parseFixture } from '../../setup/src/fixture.ts';
import { bakedDrive, demoMoment, fixturePoints, storyTracksSkip, type MomentJob } from '../../setup/src/testing/demo-moment.ts';
import { planTechnicians, readRoster, SERVICES } from '../../db/src/seed/reference-data.ts';

const TRACKS = path.join(DATA_DIR, 'maps', 'tracks.ndjson');
const STREETS = path.join(DATA_DIR, 'street-list.json');

// why: F-243 - each test regenerates or re-parses the 96k-row CSVs (0.9 to 4 s alone, over 5 s under the contended wave run), so the 5 s default timed out; the failure looked zone-bound only because of load.
vi.setConfig({ testTimeout: 60_000 });

let inputs: ReturnType<typeof loadInputs>;
let out: Output;
let customers: Record<string, string>[];
let fixture: Fixture;
let truth: { exact: { a: string; b: string }[]; likely: { a: string; b: string }[] };
let otherSeed: Output | undefined;
const other = (): Output => (otherSeed ??= generate({ ...inputs, seed: SEED + 1 }));

// F-311: each generate() takes seconds and several tests call it again; on a loaded CI container the 5 s and 10 s defaults sit
// right at that time (the G-CI4 UTC run timed out 5 tests and skipped the other 46 at e5b3393), so the limits are stated.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

beforeAll(() => {
  inputs = loadInputs();
  out = generate(inputs);
  customers = readCsvRecords(out['customers.csv']);
  fixture = JSON.parse(out['fixture.json']) as Fixture;
  truth = JSON.parse(out['truth.json']) as typeof truth;
});

const files = (patch: Partial<Output> = {}): Files => ({ ...out, ...patch });
/** Replace the first occurrence of `from` in 1 generated file, failing the test if it is not there. */
const plant = (name: keyof Output, from: string, to: string): Files => {
  expect(out[name]).toContain(from);
  return files({ [name]: out[name].replace(from, to) });
};

/** An Unassigned story job (F-292) is its named branch's; every other job is its technician's. */
const jobBranch = (j: { technician: string | null; branch?: string }, b: (e: string) => string | undefined): string | undefined =>
  (j.technician === null ? j.branch : b(j.technician));

/** 1 sample row of the approved Jobs page (office-jobs.html, DK-88): its R list, and the Live row's jobs that list leaves out. */
interface PageRow { job: string; customer: string; city: string; service: string; day: string; window: string; tech: string; status: string; bookedBy: string }
const JOBS_PAGE = path.join(PKG, '../../mockups/pages/office-jobs.html');
const quoted = (line: string): string[] => [...line.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? m[2] ?? '');
function jobsPageRows(): PageRow[] {
  const html = readFileSync(JOBS_PAGE, 'utf8');
  const rows: PageRow[] = [];
  const list = /const R = \[\n([\s\S]*?)\n {2}\];/.exec(html)?.[1] ?? '';
  for (const line of list.split('\n')) {
    const [job, customer, city, service, day, window, tech, status, , bookedBy] = quoted(line) as string[];
    if (job && /^\d{5}$/.test(job)) rows.push({ job, customer, city, service, day, window, tech, status, bookedBy } as PageRow);
  }
  // The Live row (24800 is in the list too; 24825 only here): its day is the sample day; it tells no window, technician or channel.
  for (const m of html.matchAll(/row\('(\d{5})', '([^']+)', '([^']+)', '([^']+)', '(\w+)'/g)) {
    const [, job, customer, city, service, status] = m as unknown as string[];
    if (!rows.some((r) => r.job === job)) rows.push({ job, customer, city, service, day: 'Today', window: '', tech: '', status, bookedBy: '' } as PageRow);
  }
  return rows.filter((r) => r.job !== '24812'); // the billing pages' job, STORY_JOBS_NOT_PINNED
}
/** The page's technician initials: its T map (MB: 'Marcus Bell', ...). */
const pageTechs = (): Map<string, string> =>
  new Map([...readFileSync(JOBS_PAGE, 'utf8').matchAll(/\b([A-Z]{2}): '([A-Z][a-z]+ [A-Z][a-z]+)'/g)].map((m) => [m[1] as string, m[2] as string]));
const hm = (t: string, pm: boolean): string => {
  const [h, m] = t.split(':').map(Number) as [number, number | undefined];
  return `${String(h === 12 ? 12 : pm ? h + 12 : h).padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}`;
};
/** "10 AM-12 PM" or "12-2 PM" to ["10:00", "12:00"], ["12:00", "14:00"]. */
function pageWindow(w: string): [string, string] {
  const m = /^(\d+(?::\d+)?)(?: (AM|PM))?-(\d+(?::\d+)?) (AM|PM)$/.exec(w);
  if (!m) throw new Error(`window ${w}`);
  const endPm = m[4] === 'PM';
  const startPm = m[2] ? m[2] === 'PM' : endPm && Number(m[1]) !== 12 && Number(m[1]) < Number(m[3]);
  return [hm(m[1] as string, startPm), hm(m[3] as string, endPm)];
}
const PAGE_DAYS: Readonly<Record<string, string>> = { Today: '2026-09-15', 'Wed, Sep 16': '2026-09-16', 'Thu, Sep 17': '2026-09-17' };

/** Each page fact the fixture does not hold, as "<job>: <fact> ...". */
function storyRowsCheck(fx: Fixture, rows: readonly PageRow[]): string[] {
  type Job = Fixture['demoWeekJobs'][number] & { service: string; problem?: string; bookedVia: string };
  const labels = JSON.parse(readFileSync(path.join(PKG, '../i18n/catalog/en.json'), 'utf8')) as Record<string, string>;
  const techs = pageTechs();
  const byName = new Map(inputs.technicians.map((t) => [t.name, t.employeeNumber]));
  const scripted = new Map((fx.sampleDayScript as { jobNumber: number; outcome: string }[]).map((s) => [s.jobNumber, s.outcome]));
  const fails: string[] = [];
  for (const r of rows) {
    const j = fx.demoWeekJobs.find((x) => x.jobNumber === Number(r.job)) as Job | undefined;
    if (!j) { fails.push(`${r.job}: not a demo-week job`); continue; }
    const c = fx.customers.find((x) => x.ref === j.customer);
    const area = CITY_AREAS[r.city];
    if (c?.name !== r.customer) fails.push(`${r.job}: customer ${c?.name} for ${r.customer}`);
    if (area ? c?.city !== area.city || !area.zips.includes(c.zip) : c?.city !== r.city) fails.push(`${r.job}: city ${c?.city} ${c?.zip} for ${r.city}`);
    const words = j.problem ?? labels[`week.service.${j.service}`];
    if (words !== r.service) fails.push(`${r.job}: service ${j.service} (${words}) for ${r.service}`);
    if (j.date !== PAGE_DAYS[r.day]) fails.push(`${r.job}: day ${j.date} for ${r.day}`);
    if (r.window) {
      const [start, end] = pageWindow(r.window);
      if (j.windowStart !== start || j.windowEnd !== end) fails.push(`${r.job}: window ${j.windowStart}-${j.windowEnd} for ${r.window}`);
    }
    if (r.status === 'unas' ? j.technician !== null : r.tech !== '' && j.technician !== byName.get(techs.get(r.tech) ?? '')) {
      fails.push(`${r.job}: technician ${j.technician} for ${r.tech || 'Unassigned'}`);
    }
    if (r.bookedBy && j.bookedVia !== r.bookedBy.split(':')[0]) fails.push(`${r.job}: booked ${j.bookedVia} for ${r.bookedBy}`);
    // On the way is Harold's job, left to the visitor; Unassigned and upcoming jobs wait. The 10:28 AM Done, On site, Late and
    // At risk words are storyMomentCheck's: timing, not the script's outcome (F-1651).
    const outcome = scripted.get(j.jobNumber);
    if (['way', 'unas'].includes(r.status) && outcome !== undefined) fails.push(`${r.job}: scripted for ${r.status}`);
    if (r.status === 'sched' && j.date <= '2026-09-15') fails.push(`${r.job}: ${j.date} is not upcoming`);
  }
  return fails;
}

/** The page's 10:28 AM status word each row tells, against the Jobs list at that moment on the baked tracks (F-1651). */
const PAGE_MOMENT: Readonly<Record<string, (m: MomentJob) => boolean>> = {
  done: (m) => m.status === 'done',
  site: (m) => m.status === 'on_site',
  late: (m) => OPEN.includes(m.status) && m.timing === 'late',
  risk: (m) => OPEN.includes(m.status) && m.timing === 'at_risk',
};
const OPEN: readonly string[] = ['scheduled', 'on_the_way', 'on_site'];
function storyMomentCheck(moment: ReadonlyMap<number, MomentJob>, rows: readonly PageRow[]): string[] {
  const fails: string[] = [];
  for (const r of rows) {
    const want = PAGE_MOMENT[r.status];
    const m = moment.get(Number(r.job));
    if (want && (!m || !want(m))) fails.push(`${r.job}: ${m?.status} ${m?.timing} at 10:28 for ${r.status}`);
  }
  return fails;
}
/**
 * F-1663, F-1666: each seeded job (pilot and demo week, story pins included) whose fixture service needs a skill its technician
 * lacks (the reassign ranking reads the skill).
 */
function jobSkillCheck(fx: Fixture): string[] {
  const skills = new Map(planTechnicians(readRoster()).map((t) => [t.employeeNumber, t.skills as readonly string[]]));
  const skillOf = new Map<string, string>(SERVICES.map((s) => [s.id, s.skill]));
  const world = parseFixture(JSON.stringify(fx));
  return [...world.pilotJobs, ...world.demoWeekJobs].flatMap((j) => {
    if (!j.technician) return [];
    const has = skills.get(j.technician) ?? [];
    return has.includes(skillOf.get(j.service) ?? '') ? [] : [`${j.jobNumber}: ${j.service} needs ${skillOf.get(j.service)}; ${j.technician} has ${has.join(', ')}`];
  });
}
const momentAt1028 = (fx: Fixture): Map<number, MomentJob> => {
  const world = parseFixture(JSON.stringify(fx));
  return demoMoment({ fixture: world, points: fixturePoints(world, STREETS), drive: bakedDrive(TRACKS), date: '2026-09-15', at: '10:28' });
};

// why: FR-IMP-5
describe('byte-identical export (FR-IMP-5)', () => {
  it('2 runs from seed 20260915 produce byte-identical files whose SHA-256s equal the committed manifest', () => {
    const second = generate(loadInputs());
    for (const n of FILES) expect(Buffer.compare(Buffer.from(second[n]), Buffer.from(out[n])), n).toBe(0);
    const manifest = readManifest();
    expect(manifest.seed).toBe(SEED);
    expect(checkManifest(manifest, files())).toEqual([]);
    expect(buildManifest(out, SEED).files).toEqual(manifest.files);
  });

  it('a 1-byte change to any generated file fails generator-manifest', () => {
    for (const n of FILES) {
      const b = Buffer.from(out[n]);
      b[b.length >> 1] = (b[b.length >> 1] as number) ^ 1;
      const fails = checkManifest(readManifest(), { ...out, [n]: b });
      expect(fails.some((f) => f.includes(n)), n).toBe(true);
    }
  });

  it('a changed sort order fails generator-manifest', () => {
    const lines = out['customers.csv'].split('\n');
    [lines[1], lines[2]] = [lines[2] as string, lines[1] as string];
    expect(checkManifest(readManifest(), files({ 'customers.csv': lines.join('\n') }))).toHaveLength(1);
  });

  it('the seed decides the output: another seed gives other files', () => {
    expect(other()['customers.csv']).not.toBe(out['customers.csv']);
  });

  it('every CSV uses \\n line ends and quotes only cells with a comma, quote or line break', () => {
    for (const n of ['customers.csv', 'visits.csv', 'equipment.csv'] as const) expect(out[n]).not.toContain('\r');
    const csv = toCsv(['a', 'b'], [['x, y', 'say "hi"']]);
    expect(csv).toBe('a,b\n"x, y","say ""hi"""\n');
    expect(parseCsv(csv)).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
  });
});

// why: SD-24
describe('1 fixed row order (OI-51)', () => {
  it('customers.csv is in ascending customer_ref order, and record A of every pair comes first', () => {
    const refs = customers.map((c) => Number(c.customer_ref ?? ''));
    expect(refs).toEqual([...refs].sort((a, b) => a - b));
    for (const p of [...truth.exact, ...truth.likely]) expect(Number(p.a)).toBeLessThan(Number(p.b));
  });

  // why: F-889 demo data matches the approved page DK-99, which reads "old customer 10288" (plain digits), not C100001
  it('writes customer_ref as plain digits and holds the approved page numbers 10288 and 16541', () => {
    const refs = customers.map((c) => c.customer_ref ?? '');
    expect(refs.every((r) => /^\d{5}$/.test(r))).toBe(true);
    expect(refs).toContain('10288');
    expect(refs).toContain('16541');
  });

  it('visits.csv and equipment.csv are in ascending ref order', () => {
    for (const [n, col] of [['visits.csv', 'visit_ref'], ['equipment.csv', 'equipment_ref']] as const) {
      const refs = readCsvRecords(out[n]).map((r) => Number((r[col] ?? '').slice(1)));
      expect(refs.every((r, i) => i === 0 || r > (refs[i - 1] as number)), n).toBe(true);
    }
  });
});

// why: SD-24
describe('export stamp, home types and visit dates (SD-24)', () => {
  it('exported_at is Mon, Aug 31, 2026, 5:00 AM America/New_York on every row', () => {
    expect(EXPORTED_AT).toBe('2026-08-31T05:00:00-04:00');
    expect(new Set(customers.map((c) => c.exported_at))).toEqual(new Set([EXPORTED_AT]));
  });

  it('home_type is a word from the fixed list or empty', () => {
    const allowed = new Set<string>([...HOME_TYPES, '']);
    expect(customers.filter((c) => !allowed.has(c.home_type ?? ''))).toEqual([]);
  });

  it('no readable visit date is after Sun, Aug 30, 2026', () => {
    const real = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
    const dates = readCsvRecords(out['visits.csv']).map((v) => v.date ?? '').filter((d) => {
      try { return real(d); } catch { return false; }
    });
    expect(dates.length).toBe(TARGETS.visits - TARGETS.visitDateUnreadable);
    expect(dates.filter((d) => d > '2026-08-30')).toEqual([]);
    expect(dates.filter((d) => d === '2026-08-30')).toEqual([]); // a Sunday: no visit at all that day
  });
});

// why: FR-IMP-6, FR-IMP-3
describe('planted problem rows and duplicates equal the FR-IMP-6 table', () => {
  it('the 3 CSVs hold exactly the target counts of every problem reason', () => {
    expect(targetCountsCheck(files())).toEqual([]);
    expect(plantedCounts(files())).toMatchObject({ customers: 18_400, visits: 96_412, equipment: 31_058 });
  });

  it('the truth file holds 812 exact and 428 likely pairs, each true of customers.csv, and is the committed file', () => {
    expect(truth.exact).toHaveLength(TARGETS.exactPairs);
    expect(truth.likely).toHaveLength(TARGETS.likelyPairs);
    expect(truthCheck(files())).toEqual([]);
    expect(out['truth.json']).toBe(readFileSync(TRUTH_FILE, 'utf8'));
  });

  it('a truth file with 1 exact pair removed (811) fails the truth check', () => {
    const t = JSON.parse(out['truth.json']) as typeof truth;
    t.exact.pop();
    const fails = truthCheck(files({ 'truth.json': JSON.stringify(t) }));
    expect(fails.some((f) => f.includes('811 exact pairs'))).toBe(true);
  });

  it('a third customer planted into a pair\'s block fails the truth check', () => {
    const p = truth.likely[0] as { a: string; b: string };
    const a = customers.find((c) => c.customer_ref === p.a) as Record<string, string>;
    const row = customers.find((c) => c.customer_ref !== p.a && c.customer_ref !== p.b && c.zip === a.zip) as Record<string, string>;
    const planted: Record<string, string> = { ...row, name: a.name ?? '', street: a.street ?? '', city: a.city ?? '', zip: a.zip ?? '', mobile: '' };
    const twin = toCsv(Object.keys(a), [Object.keys(a).map((k) => planted[k] ?? '')]).split('\n')[1] as string;
    const fails = truthCheck(files({ 'customers.csv': out['customers.csv'] + twin + '\n' }));
    expect(fails.some((f) => f.startsWith('truth: block'))).toBe(true);
  });
});

// why: FR-IMP-7
describe('reserved phone numbers (FR-IMP-7)', () => {
  const areas = () => areasOfCityFrom(inputs.streets);

  it('a scan of every generated file finds no other 555 or real-looking number', () => {
    expect(phoneRangeScan(files(), areas())).toEqual([]);
  });

  it('a planted 555-0200 number fails the scan', () => {
    const m = /\(614\) 555-01\d\d/.exec(out['customers.csv']) as RegExpExecArray;
    expect(phoneRangeScan(plant('customers.csv', m[0], '(614) 555-0200'), areas()).length).toBeGreaterThan(0);
  });

  it('a real-looking number or a 555 number with no area code fails the scan, in any generated file', () => {
    expect(phoneRangeScan(plant('fixture.json', '"zone":', '"note": "call (614) 867-5309", "zone":'), areas()).length).toBeGreaterThan(0);
    expect(phoneRangeScan(plant('visits.csv', 'No one home. Left a door tag.', 'No one home. Call 555-0150.'), areas()).length).toBeGreaterThan(0);
  });

  // F-202: the cell rule allowed any 7 to 9 digits not starting 555, but a separator-less 7-digit number is real-looking.
  it('a real-looking 7-digit number written with no separator in a phone cell fails the scan (known-bad)', () => {
    const m = /\(614\) 555-01\d\d/.exec(out['customers.csv']) as RegExpExecArray;
    const fails = phoneRangeScan(plant('customers.csv', m[0], '8675309'), areas());
    expect(fails.some((f) => f.includes('8675309'))).toBe(true);
  });

  // why: F-239 the scan took either reserved area code on any row; a number must carry its own city's code
  it('a reserved number with the other area code than its row\'s city fails the scan (known-bad)', () => {
    const m = /^\d+,[^\n]*?(\(614\) 555-01\d\d)[^\n]*,Columbus,/m.exec(out['customers.csv']) as RegExpExecArray;
    const fails = phoneRangeScan(plant('customers.csv', m[1] as string, '(937) 555-0150'), areas());
    expect(fails.some((f) => f.includes('wrong area code') && f.includes('Columbus'))).toBe(true);
  });

  it('numbers repeat across customers, and duplicate rules never match on phone alone', () => {
    const byMobile = new Map<string, string[]>();
    for (const c of customers) {
      const d = digits(c.mobile ?? '');
      if (d.length === 10) byMobile.set(d, [...(byMobile.get(d) ?? []), c.customer_ref as string]);
    }
    expect(byMobile.size).toBeLessThanOrEqual(200);
    const pairs = new Set([...truth.exact, ...truth.likely].map((p) => `${p.a}/${p.b}`));
    const sharing = [...byMobile.values()].find((refs) => refs.length > 2) as string[];
    expect(pairs.has(`${sharing[0]}/${sharing[1]}`) && pairs.has(`${sharing[1]}/${sharing[2]}`)).toBe(false);
    const byRef = new Map(customers.map((c) => [c.customer_ref, c]));
    for (const p of truth.exact) {
      const [a, b] = [byRef.get(p.a), byRef.get(p.b)] as Record<string, string>[];
      expect(fold(a?.name ?? '')).toBe(fold(b?.name ?? ''));
      expect([a?.street, a?.house_number]).toEqual([b?.street, b?.house_number]);
    }
  });
});

// why: FR-IMP-8
describe('real streets, made-up house numbers (FR-IMP-8)', () => {
  it('the street source holds names, coordinates and ZIP codes with no house-number field', () => {
    const keys = new Set(inputs.streets.flatMap((s) => Object.keys(s)));
    expect([...keys].sort()).toEqual(['branch', 'city', 'name', 'points', 'zip']);
  });

  it('every customer and equipment address is a street of the list; a missing ZIP is a name and city the list holds once', () => {
    const full = new Set(inputs.streets.map((s) => `${s.name}|${s.city}|${s.zip}`));
    const nameCity = new Map<string, number>();
    for (const s of inputs.streets) nameCity.set(`${s.name}|${s.city}`, (nameCity.get(`${s.name}|${s.city}`) ?? 0) + 1);
    for (const c of customers) {
      if (c.zip) expect(full.has(`${c.street}|${c.city}|${c.zip}`), c.customer_ref).toBe(true);
      else expect(nameCity.get(`${c.street}|${c.city}`), c.customer_ref).toBe(1);
    }
    for (const e of readCsvRecords(out['equipment.csv'])) if (e.street) expect(full.has(`${e.street}|${e.city}|${e.zip}`)).toBe(true);
  });

  it('house numbers come from the seeded generator: whole numbers that change with the seed', () => {
    expect(customers.every((c) => /^[1-9]\d{0,3}$/.test(c.house_number ?? ''))).toBe(true);
    const houses = (rows: Record<string, string>[]) => rows.slice(0, 200).map((r) => r.house_number).join(',');
    expect(houses(readCsvRecords(other()['customers.csv']))).not.toBe(houses(customers));
  });

  it('the generator README states the sample addresses are fictional', () => {
    expect(readFileSync(path.join(PKG, 'README.md'), 'utf8')).toMatch(/addresses are fictional/i);
  });
});

// why: FR-IMP-9
describe('named sample people (FR-IMP-9)', () => {
  const person = (name: string) => customers.filter((c) => c.name === name);

  it('Harold Jenkins has 8 past visits, 4 pieces of equipment and the Comfort Club membership', () => {
    const [h] = person('Harold Jenkins');
    expect(person('Harold Jenkins')).toHaveLength(1);
    expect(readCsvRecords(out['visits.csv']).filter((v) => v.customer_ref === h?.customer_ref)).toHaveLength(8);
    expect(readCsvRecords(out['equipment.csv']).filter((e) => e.customer_ref === h?.customer_ref).map((e) => e.type).sort())
      .toEqual(['air_conditioner', 'furnace', 'thermostat', 'water_heater']);
    expect(fixture.memberships.filter((m) => m.customer === h?.customer_ref)).toEqual([
      { customer: h?.customer_ref, since: '2019-03-01', renews: '2027-03-01', benefitsKey: 'comfort_club' },
    ]);
  });

  it("Sean O'Brien, Kathleen O'Brien-Miller and Kathy OBrien exist, and Kathy OBrien is on the likely-duplicate list", () => {
    for (const n of ["Sean O'Brien", "Kathleen O'Brien-Miller", 'Kathy OBrien']) expect(person(n), n).toHaveLength(1);
    const kathy = person('Kathy OBrien')[0]?.customer_ref;
    const kathleen = person("Kathleen O'Brien-Miller")[0]?.customer_ref;
    const pair = truth.likely.find((p) => p.a === kathy || p.b === kathy);
    expect(pair && [pair.a, pair.b].sort()).toEqual([kathy, kathleen].sort());
  });

  it('Rosa Delgado prefers Spanish and Deborah Lin is in the Pacific zone', () => {
    expect(person('Rosa Delgado').map((c) => c.text_language)).toEqual(['es']);
    expect(person('Deborah Lin').map((c) => c.time_zone)).toEqual(['America/Los_Angeles']);
  });

  it('about 8% of customers prefer Spanish', () => {
    const es = customers.filter((c) => c.text_language === 'es').length / customers.length;
    expect(es).toBeGreaterThan(0.07);
    expect(es).toBeLessThan(0.09);
  });
});

// why: SD-24
describe('the world seed fixture (BUILD_PLAN D-3 step 2)', () => {
  it('the customers the fixture names and the customers in the truth pairs share none; each resolves to exactly 1 row', () => {
    expect(shareNoneCheck(files())).toEqual([]);
  });

  it('a planted fixture row naming a customer of a planted duplicate pair fails the share-none check', () => {
    const fx = JSON.parse(out['fixture.json']) as Fixture;
    fx.memberships.push({ customer: (truth.exact[0] as { a: string }).a });
    const fails = shareNoneCheck(files({ 'fixture.json': JSON.stringify(fx) }));
    expect(fails.some((f) => f.includes('a customer of a planted duplicate pair'))).toBe(true);
  });

  it('pilot jobs run Mon, Aug 31 to Mon, Sep 14 and are ended; demo-week jobs start Tue, Sep 15 and are scheduled', () => {
    const dates = fixture.pilotJobs.map((j) => j.date);
    expect(dates.reduce((a, b) => (a < b ? a : b))).toBe('2026-08-31');
    expect(dates.reduce((a, b) => (a > b ? a : b))).toBe('2026-09-14');
    expect(new Set(fixture.pilotJobs.map((j) => j.status))).toEqual(new Set(['done', 'no_one_home']));
    expect(fixture.demoWeekJobs.every((j) => j.date >= '2026-09-15' && j.status === 'scheduled')).toBe(true);
    expect(Math.max(...fixture.pilotJobs.map((j) => j.jobNumber))).toBeLessThan(24_800);
  });

  it('the sample day puts Harold Jenkins on job 24830 with Maria Santos at 10 AM-12 PM, which the script leaves to a visitor', () => {
    const h = customers.find((c) => c.name === 'Harold Jenkins')?.customer_ref;
    const job = fixture.demoWeekJobs.find((j) => j.customer === h);
    expect(job).toMatchObject({ jobNumber: 24_830, technician: '40712', date: '2026-09-15', windowStart: '10:00', windowEnd: '12:00' });
    const scripted = new Set(fixture.sampleDayScript.map((s) => s.jobNumber));
    const maria = fixture.demoWeekJobs.filter((j) => j.technician === '40712' && j.date === '2026-09-15');
    for (const j of maria) expect(scripted.has(j.jobNumber), `${j.windowStart}`).toBe(j.windowStart < '10:00');
    expect(fixture.sampleDayScript.length).toBe(fixture.demoWeekJobs.length - maria.filter((j) => j.windowStart >= '10:00').length
      - fixture.demoWeekJobs.filter((j) => j.technician === null).length);
  });

  // why: F-238
  it('every job number REQUIREMENTS and SPECIFICATIONS tell is pinned to its technician, day and window', () => {
    const docs = ['REQUIREMENTS.md', 'SPECIFICATIONS.md'].map((f) => readFileSync(path.join(PKG, '../../docs', f), 'utf8')).join('\n');
    const cited = new Set([...docs.matchAll(/\b[Jj]obs? (24[89]\d\d)\b|jobs\/(24[89]\d\d)\b/g)].map((m) => Number(m[1] ?? m[2])));
    expect(cited.size).toBeGreaterThan(0);
    for (const n of cited) expect(STORY_JOBS.map((p) => p.jobNumber), `job ${n}`).toContain(n);
    for (const pin of STORY_JOBS) {
      expect(fixture.demoWeekJobs.find((j) => j.jobNumber === pin.jobNumber), String(pin.jobNumber))
        .toMatchObject({ technician: pin.handedTo ?? pin.technician, date: pin.date, windowStart: pin.windowStart });
    }
    expect(inputs.technicians.find((t) => t.employeeNumber === '40712')?.name).toBe('Maria Santos');
  });

  // why: F-292 (the F-238 class over the wider population: the approved pages and UI-SPECIFICATION tell jobs too)
  it('every live-range job number an approved page or UI-SPECIFICATION tells is pinned to its technician, day and window, or named as not pinned', () => {
    const root = path.join(PKG, '../..');
    const pages = readdirSync(path.join(root, 'mockups/pages')).filter((f) => f.endsWith('.html')).map((f) => readFileSync(path.join(root, 'mockups/pages', f), 'utf8'));
    const spec = readFileSync(path.join(root, 'docs/UI-SPECIFICATION.md'), 'utf8');
    const toldAll = new Set([...[...pages, spec].join('\n').matchAll(/\b(24[6-9]\d\d)\b/g)].map((m) => Number(m[1])));
    const told = new Set([...toldAll].filter((n) => n >= 24_800));
    expect(told.size).toBeGreaterThan(10);
    const pinned = new Set(STORY_JOBS.map((p) => p.jobNumber));
    for (const n of told) expect(pinned.has(n) || n in STORY_JOBS_NOT_PINNED, `job ${n} is told by an approved page`).toBe(true);
    for (const n of Object.keys(STORY_JOBS_NOT_PINNED).map(Number)) {
      expect(toldAll.has(n) && !pinned.has(n), `STORY_JOBS_NOT_PINNED ${n} must be told by a page and not pinned`).toBe(true);
    }
    // Each pin is a distinct demo-week slot: 1 job per technician per window, apart from a job handed over (F-1651), which
    // joins at most 1 job its new technician holds in that window.
    const handed = new Set(STORY_JOBS.filter((p) => p.handedTo).map((p) => p.jobNumber));
    const perSlot = new Map<string, number>();
    for (const j of fixture.demoWeekJobs) {
      if (!handed.has(j.jobNumber)) perSlot.set(`${j.date}|${j.technician}|${j.windowStart}`, (perSlot.get(`${j.date}|${j.technician}|${j.windowStart}`) ?? 0) + 1);
    }
    for (const pin of STORY_JOBS) {
      const held = perSlot.get(`${pin.date}|${pin.handedTo ?? pin.technician}|${pin.windowStart}`) ?? 0;
      if (pin.handedTo) expect(held, `${pin.jobNumber} handed to ${pin.handedTo}`).toBeLessThanOrEqual(1);
      else expect(held, String(pin.jobNumber)).toBe(1);
    }
  });

  // why: F-292, F-555, F-318 (the approved Jobs page's sample rows are the seed's facts: owner ruling b23b26d9 "Match the page")
  it('every job of the approved Jobs page sample rows has the customer, city, service, day, window, technician, status and channel the page tells', () => {
    const rows = jobsPageRows();
    expect(rows.map((r) => r.job).sort()).toEqual(['24790', '24791', '24797', '24800', '24805', '24819', '24825', '24830', '24840', '24841', '24842', '24866', '24871']);
    expect(storyRowsCheck(fixture, rows)).toEqual([]);
    for (const r of rows) {
      expect(Number(r.job) in STORY_JOBS_NOT_PINNED, `STORY_JOBS_NOT_PINNED holds page job ${r.job}`).toBe(false);
      expect(STORY_JOBS.find((p) => p.jobNumber === Number(r.job))?.customer, `job ${r.job} pins its customer`).toBeDefined();
    }
  });

  // why: F-1651 (the page's Done, On site, Late and At risk words are each job's timing at 10:28 AM on the baked tracks; the
  // old check passed any finished script row, so 24805, 24797 and 24819 read Done though the page tells Late and At risk)
  it('every Done, On site, Late and At risk row of the approved Jobs page is that job at 10:28 AM on the baked tracks', (ctx) => {
    const skip = storyTracksSkip(TRACKS); // F-1665: the manifest's track set, else a skip that says why or a failure
    if (skip) ctx.skip(skip);
    expect(storyMomentCheck(momentAt1028(fixture), jobsPageRows())).toEqual([]);
  });

  // why: F-1651 (the check above can fail: with the visit before it, 24815, on time and 30 minutes long, 24805 is no longer Late at 10:28)
  it('fails a fixture whose Late page job has an on-time visit before it', (ctx) => {
    const skip = storyTracksSkip(TRACKS);
    if (skip) ctx.skip(skip);
    const fx = JSON.parse(out['fixture.json']) as Fixture;
    const rows = fx.sampleDayScript as { jobNumber: number; arrivalDelayMinutes?: number; workMinutes?: number }[];
    const s = rows.find((x) => x.jobNumber === 24_815);
    expect(s, '24815, the visit before 24805, has a script row').toBeDefined();
    Object.assign(s as object, { arrivalDelayMinutes: 0, workMinutes: 30 });
    expect(storyMomentCheck(momentAt1028(fx), jobsPageRows())).toContainEqual(expect.stringMatching(/^24805: /));
  });

  // why: F-1663, F-1666 (24810 was pinned a sump pump install on Greg Hoffman, a plumber, and the draw gave 27 to 31 Sep 15 jobs, 24826 among them, a service their technician's skill does not cover)
  it("every seeded job's service is one its technician's skills cover", () => {
    expect(jobSkillCheck(fixture)).toEqual([]);
  });

  // why: F-1663 (the check above can fail: 24810 back on the old pin, a sump pump install on Greg Hoffman)
  it('fails a fixture whose story job needs a skill its technician lacks', () => {
    const fx = JSON.parse(out['fixture.json']) as Fixture;
    Object.assign(fx.demoWeekJobs.find((x) => x.jobNumber === 24_810) as object, { service: 'sump_pump_install' });
    expect(jobSkillCheck(fx)).toEqual(['24810: sump_pump_install needs install; 40704 has plumbing']);
  });

  // why: F-1666 (the check above can fail on a job no pin tells: Rosa Delgado's 24826 back to a sump pump install on Marcus Bell, and a pilot job given a furnace tune-up on a plumber)
  it('fails a fixture whose drawn job needs a skill its technician lacks', () => {
    const fx = JSON.parse(out['fixture.json']) as Fixture;
    Object.assign(fx.demoWeekJobs.find((x) => x.jobNumber === 24_826) as object, { service: 'sump_pump_install' });
    const pilot = fx.pilotJobs.find((x) => x.technician === '40701') as Fixture['pilotJobs'][number] & { service: string };
    pilot.service = 'furnace_tune_up';
    expect(jobSkillCheck(fx)).toEqual([`${pilot.jobNumber}: furnace_tune_up needs heating_cooling; 40701 has plumbing`, '24826: sump_pump_install needs install; 40701 has plumbing']);
  });

  // why: F-1666 (Rosa Delgado's visit stays as the pages tell it, a sump pump install with Marcus Bell 2-4 PM, in his plumbing skill)
  it("Rosa Delgado's Sep 15 job is Marcus Bell's 2-4 PM plumbing repair with the pages' words", () => {
    const rosa = fixture.customers.find((c) => c.name === 'Rosa Delgado') as Fixture['customers'][number];
    const j = fixture.demoWeekJobs.filter((x) => x.customer === rosa.ref) as (Fixture['demoWeekJobs'][number] & { service: string; problem?: string })[];
    expect(j.map((x) => ({ n: x.jobNumber, t: x.technician, d: x.date, w: x.windowStart, s: x.service, p: x.problem }))).toEqual([
      { n: 24_826, t: '40701', d: '2026-09-15', w: '14:00', s: 'plumbing_repair', p: 'Sump pump install' },
    ]);
  });

  // why: F-292 (the check above can fail: job 24805 given another Dublin customer, so only the name is wrong)
  it('fails a fixture whose page job names another Dublin customer', () => {
    const fx = JSON.parse(out['fixture.json']) as Fixture;
    const j = fx.demoWeekJobs.find((x) => x.jobNumber === 24_805) as Fixture['demoWeekJobs'][number];
    const dublin = fx.customers.find((c) => c.ref !== j.customer && c.city === 'Dublin') as Fixture['customers'][number];
    j.customer = dublin.ref;
    expect(storyRowsCheck(fx, jobsPageRows())).toEqual([expect.stringMatching(/^24805: customer /)]);
  });

  // why: F-203
  it("a fixture customer given another customer's key fails share-none, though that key resolves to exactly 1 row", () => {
    const fx = JSON.parse(out['fixture.json']) as Fixture;
    const [a, b] = fx.customers as [Fixture['customers'][number], Fixture['customers'][number]];
    fx.customers[0] = { ...a, name: b.name, nameSearch: b.nameSearch, street: b.street, city: b.city, zip: b.zip, houseNumber: b.houseNumber };
    const fails = shareNoneCheck(files({ 'fixture.json': JSON.stringify(fx) }));
    expect(fails).toContain(`share-none: fixture customer ${a.ref}'s key is not the key of its own customers.csv row`);
  });

  // why: F-203
  it('a pilot call naming a visit the import does not write fails share-none (no sentinel passes)', () => {
    const fx = JSON.parse(out['fixture.json']) as Fixture;
    fx.pilotCalls.push({ at: '2026-07-01T09:00', visitRef: 'V9999999' });
    const fails = shareNoneCheck(files({ 'fixture.json': JSON.stringify(fx) }));
    expect(fails).toContain('share-none: fixture pilotCalls 2026-07-01T09:00 names visit V9999999, which the import does not write');
  });

  it('the generator writes no database row: its source imports no database client', () => {
    const src = readdirSync(path.join(PKG, 'src')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const f of src) {
      const text = readFileSync(path.join(PKG, 'src', f), 'utf8');
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(imports.filter((i) => i === 'pg' || /db\/src\/(client|index|repositor)/.test(i ?? '')), f).toEqual([]);
      expect(text, f).not.toMatch(/loadStreetList\(|\.query\(/);
    }
  });
});

// why: SD-25, OI-25
describe('simulated pilot outcomes (SD-25)', () => {
  it('before near 74% on time and 6% no one home; after at least 90% and under 3%; the call rate near twice', () => {
    const r = sd25Rates(files());
    expect(Math.abs(onTimePct(r.before) - 74)).toBeLessThanOrEqual(1);
    expect(Math.abs(nohPct(r.before) - 6)).toBeLessThanOrEqual(0.5);
    expect(onTimePct(r.after)).toBeGreaterThanOrEqual(90);
    expect(nohPct(r.after)).toBeLessThan(3);
    expect(ratesCheck(files())).toEqual([]);
  });

  it('Sep 8 to 14 has pilot rows for the board\'s 7-day rate on Sep 15, at least 90% on time', () => {
    const r = sd25Rates(files());
    expect(r.board7.visits).toBeGreaterThan(200);
    expect(onTimePct(r.board7)).toBeGreaterThanOrEqual(90);
  });

  it('changing 1 generated visit changes the measured rate (rates come from rows, never constants)', () => {
    const v = readCsvRecords(out['visits.csv']).find((x) => x.date === '2026-06-02' && x.outcome === 'done') as Record<string, string>;
    const line = out['visits.csv'].split('\n').find((l) => l.startsWith(`${v.visit_ref},`)) as string;
    const changed = line.replace(`,${v.arrived_at},done,`, ',,no_one_home,');
    expect(changed).not.toBe(line);
    const before = sd25Rates(files()).before.noOneHome;
    expect(sd25Rates(plant('visits.csv', line, changed)).before.noOneHome).toBe(before + 1);
  });
});

// why: FR-IMP-5
describe('committed inputs', () => {
  it('the manifest names exactly the generated files', () => {
    expect(Object.keys(readManifest(MANIFEST_FILE).files).sort()).toEqual([...FILES].sort());
  });
});

// why: FR-BOOK-6
describe('Columbus booking windows (FR-BOOK-6, F-201)', () => {
  const branch = (): ((e: string) => string | undefined) => {
    const m = new Map(inputs.technicians.map((t) => [t.employeeNumber, t.branch]));
    return (e) => m.get(e);
  };

  it('no Columbus window in the pilot or the demo week is over 12, 12, 11, 11, 10 bookings', () => {
    expect(bookingWindowCheck(files(), branch())).toEqual([]);
  });

  it('every demo weekday but the sample day leaves room in every Columbus window; Sep 15 still offers a window', () => {
    const per = new Map<string, number>();
    for (const j of fixture.demoWeekJobs) {
      if (jobBranch(j, branch()) === 'columbus') per.set(`${j.date}|${j.windowStart}`, (per.get(`${j.date}|${j.windowStart}`) ?? 0) + 1);
    }
    const limits = [12, 12, 11, 11, 10];
    for (const [k, n] of per) {
      const [date, start] = k.split('|') as [string, string];
      if (new Date(`${date}T12:00:00Z`).getUTCDay() === 6 || date === '2026-09-15') continue;
      expect(n, k).toBeLessThan(limits[(Number(start.slice(0, 2)) - 8) / 2] as number);
    }
    const sep15 = ['08:00', '10:00', '12:00', '14:00', '16:00'].map((w) => per.get(`2026-09-15|${w}`) ?? 0);
    expect(sep15.some((n, i) => n < (limits[i] as number))).toBe(true);
  });

  // why: F-236
  it('Sep 15 matches the approved booking page: 8-10 Full, 10-12 Open, 12-2 2 left, 2-4 Full, 4-6 Open', () => {
    const b = branch();
    const sep15 = ['08:00', '10:00', '12:00', '14:00', '16:00'].map((w) =>
      fixture.demoWeekJobs.filter((j) => j.date === '2026-09-15' && j.windowStart === w && jobBranch(j, b) === 'columbus').length);
    expect(sep15).toEqual([12, 8, 9, 11, 6]);
  });

  // why: F-236
  it('every demo weekday leaves a Dayton technician room under 5 jobs a day', () => {
    const b = branch();
    const days = [...new Set(fixture.demoWeekJobs.map((j) => j.date))].filter((d) => new Date(`${d}T12:00:00Z`).getUTCDay() !== 6);
    const dayton = inputs.technicians.filter((t) => t.branch === 'dayton' && !t.installer).map((t) => t.employeeNumber);
    for (const d of days) {
      const load = dayton.map((e) => fixture.demoWeekJobs.filter((j) => j.date === d && j.technician === e && b(e) === 'dayton').length);
      expect(Math.min(...load), d).toBeLessThan(5);
    }
  });

  // why: F-239 the check skipped input outside its model; each of these now fails
  it('a job of a technician outside the roster, a job off the window grid, and too few Columbus jobs each fail the check (known-bad)', () => {
    const b = branch();
    const fx = (edit: (f: Fixture) => void): Files => { const f = JSON.parse(out['fixture.json']) as Fixture; edit(f); return files({ 'fixture.json': JSON.stringify(f) }); };
    const unknown = bookingWindowCheck(fx((f) => { (f.pilotJobs[0] as { technician: string }).technician = '99999'; }), b);
    expect(unknown.some((x) => x.includes('99999') && x.includes('not in the roster'))).toBe(true);
    const off = bookingWindowCheck(fx((f) => { (f.demoWeekJobs[0] as { windowStart: string }).windowStart = '09:00'; }), b);
    expect(off.some((x) => x.includes('09:00') && x.includes('not one of the 5'))).toBe(true);
    const few = bookingWindowCheck(fx((f) => { f.pilotJobs = []; f.demoWeekJobs = f.demoWeekJobs.filter((j) => jobBranch(j, b) !== 'columbus'); }), b);
    expect(few.some((x) => x.includes('Columbus jobs'))).toBe(true);
  });

  // why: F-1653 (a window is its start and its length, as the world seed keys it: 24871's 4-hour 8 AM-12 PM booking on peak day
  // Sep 16 is not one of the 8-10 AM window's 12)
  it('does not count a 4-hour booking against the 2-hour window that starts with it', () => {
    const fx = JSON.parse(out['fixture.json']) as Fixture;
    const b = branch();
    const j = fx.demoWeekJobs.find((x) => x.jobNumber === 24_871) as Fixture['demoWeekJobs'][number];
    expect([j.date, j.windowStart, j.windowEnd]).toEqual(['2026-09-16', '08:00', '12:00']);
    const twoHour = fx.demoWeekJobs.filter((x) => x.date === j.date && x.windowStart === '08:00' && x.windowEnd === '10:00' && jobBranch(x, b) === 'columbus');
    const room = 12 - twoHour.length;
    expect(room, 'Sep 16 8-10 AM has room for a planted booking').toBeGreaterThan(0);
    // Fill the 2-hour window to its limit exactly: with 24871 counted it would read 13.
    const filler = fx.demoWeekJobs.filter((x) => x.date === j.date && x.windowStart === '10:00' && x.windowEnd === '12:00' && jobBranch(x, b) === 'columbus').slice(0, room);
    expect(filler.length).toBe(room);
    for (const x of filler) { x.windowStart = '08:00'; x.windowEnd = '10:00'; }
    expect(bookingWindowCheck(files({ 'fixture.json': JSON.stringify(fx) }), b)).toEqual([]);
  });

  // why: F-1653 (a 4-hour window on a 2-hour day, FR-BOOK-7, passed the start-only shape check)
  it('fails a 4-hour booking on a day that is not a seeded 4-hour day (known-bad)', () => {
    const fx = JSON.parse(out['fixture.json']) as Fixture;
    const j = fx.demoWeekJobs.find((x) => x.jobNumber === 24_871) as Fixture['demoWeekJobs'][number];
    j.date = '2026-09-17';
    const fails = bookingWindowCheck(files({ 'fixture.json': JSON.stringify(fx) }), branch());
    expect(fails).toEqual([expect.stringMatching(/^booking-windows: job 24871 has a 4-hour window on 2026-09-17, which is not a seeded 4-hour day/)]);
  });

  it('a Columbus window pushed over its limit fails the check (known-bad)', () => {
    const fx = JSON.parse(out['fixture.json']) as Fixture;
    const b = branch();
    for (const j of fx.demoWeekJobs) if (j.date === '2026-09-15' && jobBranch(j, b) === 'columbus') { j.windowStart = '16:00'; j.windowEnd = '18:00'; }
    const fails = bookingWindowCheck(files({ 'fixture.json': JSON.stringify(fx) }), b);
    expect(fails.some((f) => f.includes('2026-09-15') && f.includes('16:00') && f.includes('limit 10'))).toBe(true);
  });
});

// why: FR-IMP-6
describe('the checks hold their own copy of the FR-IMP-6 table (F-204)', () => {
  it('FR_IMP_6 in checks.ts equals the numbers in docs/REQUIREMENTS.md and the generator TARGETS', () => {
    const req = readFileSync(path.join(PKG, '../../docs/REQUIREMENTS.md'), 'utf8');
    const table = req.slice(req.indexOf('**Import target counts (FR-IMP-6).**'));
    const n = (re: RegExp): number => Number((re.exec(table) as RegExpExecArray)[1]?.replace(/,/g, ''));
    expect(FR_IMP_6.customers).toBe(n(/\| Customers \| ([\d,]+):/));
    expect(FR_IMP_6.customersFlagged).toBe(n(/, (\d+) imported and flagged/));
    expect(FR_IMP_6.visits).toBe(n(/\| Service visits[^|]*\| ([\d,]+):/));
    expect(FR_IMP_6.visitsNotImported).toBe(n(/, (\d+) not imported \|\n\| Equipment/));
    expect(FR_IMP_6.equipment).toBe(n(/\| Equipment \| ([\d,]+):/));
    expect(FR_IMP_6.equipmentNotImported).toBe(n(/, (\d+) not imported \|\n\| Problem/));
    expect(FR_IMP_6.problemRows).toBe(n(/\| Problem rows \| ([\d,]+):/));
    expect(FR_IMP_6.visitNoCustomer).toBe(n(/visit with no customer (\d+)/));
    expect(FR_IMP_6.missingZip).toBe(n(/missing ZIP code (\d+)/));
    expect(FR_IMP_6.badPhone).toBe(n(/bad phone number (\d+)/));
    expect(FR_IMP_6.visitDateUnreadable).toBe(n(/visit date not readable (\d+)/));
    expect(FR_IMP_6.equipmentNoAddress).toBe(n(/equipment with no address (\d+)/));
    expect(FR_IMP_6.customerNameBlank).toBe(n(/customer name blank (\d+)/));
    expect(FR_IMP_6.pairs).toBe(n(/\| Likely duplicates \| ([\d,]+):/));
    expect(FR_IMP_6.exactPairs).toBe(n(/: (\d+) exact, merged/));
    expect(FR_IMP_6.likelyPairs).toBe(n(/; (\d+) listed for the office/));
    expect(TARGETS).toEqual(FR_IMP_6);
  });
});
