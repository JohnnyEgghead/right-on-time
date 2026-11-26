// SPDX-License-Identifier: AGPL-3.0-or-later
// @bw/generator (SPECIFICATIONS section 6.7, SD-24, SD-25; BUILD_PLAN D-3 step 2): the old system's export and the
// world seed's fixture, from 1 seeded PRNG in 1 fixed order. Pure: it takes the street list, the roster and the named
// people, returns file texts, and writes no database row (the world seed writes pilot_call rows later, D-3 step 5).
import { planTechnicians } from '../../db/src/seed/reference-data.ts';
import { foldStreetName as fold } from '../../db/src/street-list.ts';
import { day, hhmm, iso, isoDow, minutesOf, weekStart } from './calendar.ts';
import { toCsv } from './csv.ts';
import {
  EMAIL_DOMAIN, EQUIPMENT_TYPES, FIRST_NAMES, FORMER_TECHNICIANS, GETTING_IN, HISPANIC_FIRST_NAMES, HISPANIC_SURNAMES,
  HOME_TYPES, NICKNAMES, NOT_RECORDED, OLD_SERVICES, SERVICES, SURNAMES, type ServiceId,
} from './pools.ts';
import { Prng, SEED } from './prng.ts';

// ---------------------------------------------------------------------------------------------------------------
// Inputs and targets

export interface StreetRow {
  branch: string;
  name: string;
  city: string;
  zip: string;
  points: [number, number][];
}

export interface Technician {
  employeeNumber: string;
  name: string;
  branch: string;
  installer: boolean;
}

interface NamedVisit { date: string; windowStart: string; windowEnd: string; arrivedAt: string; technician: string; service: string; workDone: string }
interface NamedEquipment { type: string; year: number; location: string; details: string }

export interface NamedPerson {
  key: string;
  name: string;
  street: { name: string; city: string; zip: string };
  houseNumber: number;
  mobile: string;
  homePhone: string;
  email: string;
  textLanguage: 'en' | 'es';
  timeZone: string;
  textsOn: boolean;
  customerSince: string;
  homeType: string;
  gettingIn: string;
  membership?: { since: string; renews: string; benefitsKey: string };
  pastVisits?: NamedVisit[];
  equipment?: NamedEquipment[];
  likelyPairWith?: string;
}

/** REQUIREMENTS FR-IMP-6's import target table: the counts the generator plants (section 6.7 "Target counts"). */
export const TARGETS = {
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

/**
 * FR-BOOK-6: the Columbus branch's 5 two-hour windows take at most 12, 12, 11, 11 and 10 bookings, in time order.
 * The demo week's weekdays book 2 under each limit (46 a day), so the booking site still offers every window (F-201).
 */
const COLUMBUS_WINDOW_LIMITS = [12, 12, 11, 11, 10] as const;
const DEMO_COLUMBUS_WINDOWS = COLUMBUS_WINDOW_LIMITS.map((n) => n - 2);
/**
 * F-236: the sample day's Columbus windows follow the approved Sep 15 booking page (mockups/pages/customer-booking.html):
 * 8-10 Full (12 of 12, so FR-BOOK-6's 13th booking is refused), 10-12 Open (8 of 12), 12-2 "2 left" (9 of 11),
 * 2-4 Full (11 of 11), 4-6 Open (6 of 10). The other demo weekdays keep DEMO_COLUMBUS_WINDOWS.
 */
const SAMPLE_DAY_COLUMBUS_WINDOWS = [12, 8, 9, 11, 6] as const;
/**
 * F-236: Dayton's demo weekdays book 29 jobs (6, 6, 6, 6, 5 by window) for its 6 technicians of 5 a day each, so 1
 * Dayton technician has room every weekday instead of all 6 at 5 of 5.
 */
const DEMO_DAYTON_WINDOWS = [6, 6, 6, 6, 5] as const;

/** The export's 1 fixed stamp: Mon, Aug 31, 2026, 5:00 AM America/New_York (EDT, UTC-4) (SD-24). */
export const EXPORTED_AT = '2026-08-31T05:00:00-04:00';
const BRANCH_ZONE = 'America/New_York';
const LAST_VISIT_DAY = day('2026-08-30');
const HISTORY_START = day('2020-09-01');
export const PILOT_FIRST = day('2026-06-01');
export const AFTER_FIRST = day('2026-07-20');
const PILOT_JOBS_FIRST = day('2026-08-31');
const PILOT_JOBS_LAST = day('2026-09-14');
const DEMO_FIRST = day('2026-09-15');
const DEMO_LAST = day('2026-09-21');
const SAMPLE_DAY = DEMO_FIRST;
const FIRST_LIVE_JOB_NUMBER = 24_800;
const HAROLD_SAMPLE_JOB = 24_830;

/** A story job's sample-day visit (SD-21): the script row's minutes the page's 10:28 AM state needs, set over the drawn row. */
interface StoryScript { onMyWayLeadMinutes?: number; arrivalDelayMinutes?: number; workMinutes: number }

/** A job the requirements or an approved page tell as a story (F-238, F-292, F-318, F-555), pinned so no renumbering moves it. */
export interface StoryJob {
  jobNumber: number;
  /** The employee number; null for a job the page tells as Unassigned ("No technician yet"). */
  technician: string | null;
  date: string;
  windowStart: string;
  /** Only for a window that is not 2 hours (24871's 4-hour window, F-318). */
  windowEnd?: string;
  /** The customer the page names, in the city the page tells (a Columbus neighborhood is its ZIPs: CITY_AREAS). */
  customer?: { name: string; city: string } | { named: string };
  service?: ServiceId;
  /** The page's words for the job where they are not the service's name (world.job.problem, the customer's words). */
  problem?: string;
  /** The booking channel the page tells (F-555); the office person is BOOKER_PINS in @bw/setup world-seed.ts. */
  bookedVia?: 'office' | 'online';
  /** When the job was booked, where the page's story needs it first in its technician's window (planDay orders by it). */
  bookedAt?: string;
  /**
   * The technician the job is handed to once every pin is placed (F-1651). The job keeps the number, customer and window the
   * pin gave it with `technician`, so its baked legs (keyed by job number) stay right.
   */
  handedTo?: string;
  script?: StoryScript;
}

/**
 * The job numbers REQUIREMENTS, SPECIFICATIONS and the approved pages tell as a story, each pinned to its technician, day and
 * window so no renumbering moves it (F-238): 24830 is Harold Jenkins's furnace tune-up with Maria Santos, Tue, Sep 15,
 * 10 AM-12 PM (DU-2, SCR-OFC-03); 24825 is Maria Santos's job before it, 8-10 AM the same day, the one the office moves to
 * Kevin Doyle while she finishes it offline (FR-DISP-2, FR-DISP-9). 24821 (Sep 15, 12-2 PM) is pinned on technician 40702 and
 * then handed to 40705 (Dave Kowalski, F-1651), so it ends on 40705; it is the stop the 6 baked legs whose arrive step carries a
 * meter all end at (F-1444). SPECIFICATIONS no longer names the job number (SD-49 does not).
 * F-292 (manager ruling Nov 1, owner ruling b23b26d9 "Match the page"): the approved Jobs page (office-jobs.html, DK-88,
 * OA-76) tells each of its sample rows' customer, city, service, day, window, technician, status and booking channel (F-555),
 * and the seed matches it; 24825's customer is Ruth Whitman (owner answer a91a6f41, Nov 14; its Live row). The page's
 * services the SD-20 catalog does not name are the nearest catalog service with the page's words as the job's problem. The
 * statuses are the page's at 10:28 AM: a done or on-site job's visit is scripted to end or start where the page says; Late,
 * At risk and On the way follow from the drive and the script, Unassigned is a job with no technician.
 */
export const STORY_JOBS: readonly StoryJob[] = [
  { jobNumber: 24_825, technician: '40712', date: '2026-09-15', windowStart: '08:00', customer: { name: 'Ruth Whitman', city: 'Bexley' }, service: 'boiler_repair', script: { workMinutes: 100 } },
  { jobNumber: HAROLD_SAMPLE_JOB, technician: '40712', date: '2026-09-15', windowStart: '10:00', customer: { named: 'harold-jenkins' }, service: 'furnace_tune_up', bookedVia: 'online' },
  { jobNumber: 24_800, technician: '40703', date: '2026-09-15', windowStart: '08:00', customer: { name: 'Paul Marsh', city: 'Gahanna' }, service: 'tankless_heater_flush', bookedVia: 'office', script: { onMyWayLeadMinutes: 19, arrivalDelayMinutes: 0, workMinutes: 91 } },
  { jobNumber: 24_790, technician: '40701', date: '2026-09-15', windowStart: '08:00', customer: { name: 'Don Hartley', city: 'Clintonville' }, service: 'plumbing_repair', problem: 'Drain cleaning', bookedVia: 'online', script: { onMyWayLeadMinutes: 16, arrivalDelayMinutes: 0, workMinutes: 74 } },
  { jobNumber: 24_791, technician: '40701', date: '2026-09-15', windowStart: '10:00', customer: { name: 'Grace Okafor', city: 'Bexley' }, service: 'water_heater', problem: 'Water heater leak', bookedVia: 'office', script: { onMyWayLeadMinutes: 20, arrivalDelayMinutes: -7, workMinutes: 120 } },
  { jobNumber: 24_797, technician: '40702', date: '2026-09-15', windowStart: '10:00', customer: { name: 'Dennis Hale', city: 'Grove City' }, service: 'plumbing_repair', problem: 'Kitchen sink leak', bookedVia: 'online' },
  { jobNumber: 24_805, technician: '40704', date: '2026-09-15', windowStart: '10:00', customer: { name: 'Carmen Reyes', city: 'Dublin' }, service: 'plumbing_repair', problem: 'Water softener service', bookedVia: 'office' },
  { jobNumber: 24_819, technician: '40707', date: '2026-09-15', windowStart: '12:00', customer: { name: 'Linda Voss', city: 'Dublin' }, service: 'ac_tune_up', bookedVia: 'online' },
  // F-1651: the 10:28 AM Late and At risk words and ETAs come from the visits before each story job (etaDay: an on-site job
  // ends at its arrival plus its service's minutes, then the tracked drive; a job's late text is sent when its ETA is 20 or
  // more minutes after its plan). Greg Hoffman: 24810, then 24815 handed to him from Brian Schaefer, arriving 10:59, so
  // 24805 is Late, ETA 12:25 PM, and its plan of 11:27 sends the text. Jamal Carter: 24809, then 24814 handed to him from Tom
  // Reinhart, booked before 24797 and on site from 10:18, so 24797 is At risk, ETA 11:50 AM, 18 minutes after its 11:32
  // plan: no text. 24821 (the stop the 6 baked legs named above end at; F-1444) is placed on Jamal's 12-2 PM job and handed to Dave Kowalski, off 24797's
  // route, so it is on time. Ashley Nguyen at 24803 from 8:55, with 24812's 2 hours after it, makes 24819 At risk, 19
  // minutes over its plan. Luis Ortega's 24804 arrives on its plan, so his day is on time (its drawn row ran 40 minutes late
  // and made 24822, 24813 and 24833 Late and At risk). Each service is one its technician's skills cover (F-1663). 24812
  // pins only its service (120 minutes, which 24819's ETA needs): the billing pages' 24812 (Whitaker, Maria Santos, AC
  // tune-up) was never this seed job, which keeps its drawn customer, technician and window.
  { jobNumber: 24_821, technician: '40702', date: '2026-09-15', windowStart: '12:00', handedTo: '40705' },
  { jobNumber: 24_810, technician: '40704', date: '2026-09-15', windowStart: '08:00', service: 'tankless_heater_flush', script: { arrivalDelayMinutes: 0, workMinutes: 60 } },
  { jobNumber: 24_815, technician: '40710', date: '2026-09-15', windowStart: '10:00', handedTo: '40704', bookedAt: '2026-08-25T09:00', service: 'tankless_heater_flush', script: { arrivalDelayMinutes: 29, workMinutes: 60 } },
  { jobNumber: 24_809, technician: '40702', date: '2026-09-15', windowStart: '08:00', service: 'tankless_heater_flush', script: { arrivalDelayMinutes: 0, workMinutes: 60 } },
  { jobNumber: 24_814, technician: '40709', date: '2026-09-15', windowStart: '10:00', handedTo: '40702', bookedAt: '2026-08-25T09:00', service: 'tankless_heater_flush', script: { arrivalDelayMinutes: 18, workMinutes: 60 } },
  { jobNumber: 24_803, technician: '40707', date: '2026-09-15', windowStart: '08:00', service: 'boiler_repair', script: { onMyWayLeadMinutes: 36, arrivalDelayMinutes: 19, workMinutes: 125 } },
  { jobNumber: 24_812, technician: '40707', date: '2026-09-15', windowStart: '10:00', service: 'boiler_repair' },
  { jobNumber: 24_804, technician: '40708', date: '2026-09-15', windowStart: '08:00', script: { arrivalDelayMinutes: 0, workMinutes: 128 } },
  { jobNumber: 24_871, technician: '40712', date: '2026-09-16', windowStart: '08:00', windowEnd: '12:00', customer: { name: 'Beth Whitfield', city: 'Westerville' }, service: 'heating_or_ac_fix', problem: 'Heat pump check', bookedVia: 'online' },
  { jobNumber: 24_866, technician: '40706', date: '2026-09-17', windowStart: '10:00', customer: { named: 'sean-obrien' }, service: 'furnace_tune_up', bookedVia: 'online' },
  // Unassigned last, so a technician's pinned job is never the one that loses its technician.
  { jobNumber: 24_840, technician: null, date: '2026-09-15', windowStart: '12:00', customer: { name: 'Thanh Pham', city: 'Gahanna' }, service: 'heating_or_ac_fix', problem: 'AC not cooling', bookedVia: 'office' },
  { jobNumber: 24_841, technician: null, date: '2026-09-15', windowStart: '14:00', customer: { name: 'Angela Russo', city: 'Worthington' }, service: 'thermostat', problem: 'Thermostat install', bookedVia: 'online' },
  { jobNumber: 24_842, technician: null, date: '2026-09-15', windowStart: '16:00', customer: { name: 'Janet Kline', city: 'Hilliard' }, service: 'plumbing_repair', problem: 'Garbage disposal', bookedVia: 'online' },
];

/**
 * A Columbus neighborhood a page tells as the city, which the street list holds as Columbus: its ZIPs. Clintonville is
 * 43202 and 43214 (Sean O'Brien's Arcadia Avenue home, named-people.json, is 43202).
 */
export const CITY_AREAS: Readonly<Record<string, { city: string; zips: readonly string[] }>> = {
  Clintonville: { city: 'Columbus', zips: ['43202', '43214'] },
};

/**
 * Job numbers the approved pages and UI-SPECIFICATION tell that the fixture does not pin (F-292), each with why. A number an
 * approved page tells that is in neither STORY_JOBS nor here fails the sweep in generator.test.ts, so a new page cannot add a
 * story job unnoticed. No job of the Jobs page's sample rows is here (generator.test.ts checks it).
 */
export const STORY_JOBS_NOT_PINNED: Readonly<Record<number, string>> = {
  24_903: 'Maria Santos\'s job 10 AM-12 PM on the time-off day a visitor picks on the Technicians page (office-technicians.html); the page tells no date',
  24_877: 'created during the demo by the New job flow (Thu, Sep 17, Kevin Doyle, 12-2 PM), not a job the sample world holds',
  24_838: 'the board\'s Control details example (office-board.html, CTL-OFC-02-15, kit 0.9; not a frame) tells it as Marcus Bell\'s, with an offline note and a 9:40 AM cancel, and tells no window',
};
const AREA: Readonly<Record<string, string>> = { columbus: '614', dayton: '937', springfield: '937' };
const BRANCH_ORDER = ['columbus', 'dayton', 'springfield'];

export const FILES = ['customers.csv', 'visits.csv', 'equipment.csv', 'fixture.json', 'truth.json'] as const;
export type FileName = (typeof FILES)[number];
export type Output = Record<FileName, string>;

export const CUSTOMER_COLUMNS = [
  'customer_ref', 'name', 'mobile', 'home_phone', 'email', 'street', 'house_number', 'city', 'zip', 'text_language',
  'time_zone', 'texts_on', 'customer_since', 'home_type', 'getting_in', 'exported_at',
] as const;
export const VISIT_COLUMNS = [
  'visit_ref', 'customer_ref', 'date', 'window_start', 'window_end', 'arrived_at', 'outcome', 'technician', 'service',
  'work_done',
] as const;
export const EQUIPMENT_COLUMNS = [
  'equipment_ref', 'customer_ref', 'street', 'house_number', 'city', 'zip', 'type', 'year', 'location', 'details',
] as const;

// ---------------------------------------------------------------------------------------------------------------
// Keys shared with the checks

const streetKey = (s: { name: string; city: string; zip: string }): string => `${s.name}|${s.city}|${s.zip}`;
export const digits = (s: string): string => s.replace(/\D/g, '');

/** The import's exact-match key (section 6.7): folded name, street and house number, mobile digits. */
export function exactKey(name: string, street: string, city: string, zip: string, house: string | number, mobile: string): string {
  return `${fold(name)}#${street}|${city}|${zip}#${house}#${digits(mobile)}`;
}

/** The fixture's lookup key (BUILD_PLAN D-3 step 5, R-BP1): name_search, street and house number. */
export function lookupKey(name: string, street: string, city: string, zip: string, house: string | number): string {
  return `${fold(name)}#${street}|${city}|${zip}#${house}`;
}

/**
 * The generator's model of section 6.7's blocking keys: each token of the folded last name plus ZIP code, and the
 * folded first name plus street. The name's first token is the first name, the rest is the last name, so
 * "O'Brien-Miller" gives the tokens obrien and miller. The generator keeps every block with 2 or more customers to
 * exactly 1 planted pair, so no pair outside the truth file can be found within a block (README "Blocking").
 */
export function blockingKeys(name: string, street: string, city: string, streetZip: string, zipCell: string): string[] {
  const toks = fold(name).split(' ').filter((t) => t !== '');
  const first = toks[0] ?? '';
  const keys = [`F|${first}|${street}|${city}|${streetZip}`];
  for (const t of toks.slice(1)) keys.push(`L|${t}|${zipCell}`);
  return keys;
}

// ---------------------------------------------------------------------------------------------------------------
// Internal model

type Flag = 'none' | 'missing_zip' | 'bad_phone' | 'blank_name';

interface Customer {
  ref: number;
  name: string;
  street: StreetRow;
  house: number;
  mobile: string;
  homePhone: string;
  email: string;
  lang: 'en' | 'es';
  zone: string;
  textsOn: boolean;
  since: number;
  homeType: string;
  gettingIn: string;
  flag: Flag;
  pair: number; // -1 when none
  named: string; // '' when none
}

interface Visit {
  gen: number;
  ref: string;
  customerRef: number;
  branch: string;
  d: number;
  dateCell: string;
  start: number;
  end: number;
  arrived: number; // -1 for no one home
  tech: string;
  service: string;
  done: string;
  imported: boolean;
  customer: Customer | null;
}

interface FixtureJob {
  jobNumber: number;
  customer: Customer;
  /** null only for a story job the page tells as Unassigned (F-292), set after the demo week is numbered. */
  technician: Technician | null;
  service: ServiceId;
  problem?: string;
  /** F-1666: the service whose minutes the sample-day script draws the visit's work from, where it is not `service`. */
  workAs?: ServiceId;
  d: number;
  start: number;
  end: number;
  status: 'done' | 'no_one_home' | 'scheduled';
  arrived: number;
  ended: number;
  bookedVia: 'office' | 'online';
  bookedAt: string;
  order: number;
}

const zipCell = (c: Customer): string => (c.flag === 'missing_zip' ? '' : c.street.zip);
/** F-889: the customer number in the form the approved page DK-99 shows (plain digits, "10288"): the pool's 100001.. less 90000 gives 10001..28701. */
const custRef = (n: number): string => String(n - 90_000);
const phone = (area: string, line: number): string => `(${area}) 555-${String(line).padStart(4, '0')}`;

function dedupe(list: readonly string[]): string[] {
  const seen = new Set<string>();
  return list.filter((w) => {
    const k = fold(w);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Lines 0101 to 0199 (0100 is the office's own number, MOCKUP-ADDITIONS). */
function line(rng: Prng): number {
  return rng.range(101, 199);
}

function weightedPick<T extends { weight: number }>(rng: Prng, items: readonly T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rng.int(total);
  for (const it of items) {
    if (r < it.weight) return it;
    r -= it.weight;
  }
  throw new Error('weightedPick: unreachable');
}

// ---------------------------------------------------------------------------------------------------------------
// The generator

export interface GenerateInput {
  streets: readonly StreetRow[];
  technicians: readonly Technician[];
  people: readonly NamedPerson[];
  seed?: number;
}

export function generate(input: GenerateInput): Output {
  const rng = new Prng(input.seed ?? SEED);
  const g = new Generator(rng, input);
  return g.run();
}

class Generator {
  private readonly blocks = new Map<string, number>();
  private readonly customers: Customer[] = [];
  private readonly pairs: { kind: 'exact' | 'likely'; a: Customer; b: Customer }[] = [];
  private readonly streets: StreetRow[];
  private readonly zipFreeStreets: StreetRow[];
  private readonly byKey = new Map<string, StreetRow>();
  private readonly firsts = dedupe(FIRST_NAMES);
  private readonly hispFirsts = dedupe(HISPANIC_FIRST_NAMES);
  private readonly lasts = dedupe([...SURNAMES, ...HISPANIC_SURNAMES]);
  private readonly hispLasts = dedupe(HISPANIC_SURNAMES);
  private readonly techsByBranch = new Map<string, Technician[]>();
  private readonly installer: Technician;
  /** F-1666: each technician's skills in the pools' words (hvac, plumbing, install), from the seed's technician plan. */
  private readonly skills = new Map<string, ReadonlySet<string>>();
  private nextOwner = 0;
  private readonly rng: Prng;
  private readonly input: GenerateInput;

  constructor(rng: Prng, input: GenerateInput) {
    this.rng = rng;
    this.input = input;
    const keyCount = new Map<string, number>();
    const nameCity = new Map<string, number>();
    for (const s of input.streets) {
      keyCount.set(streetKey(s), (keyCount.get(streetKey(s)) ?? 0) + 1);
      nameCity.set(`${s.name}|${s.city}`, (nameCity.get(`${s.name}|${s.city}`) ?? 0) + 1);
    }
    // A street key the list holds twice cannot be resolved by the importer, so the generator never draws it.
    this.streets = input.streets.filter((s) => keyCount.get(streetKey(s)) === 1);
    for (const s of this.streets) this.byKey.set(streetKey(s), s);
    // A customer with no ZIP code is resolved by street name and city alone, so draw those from unique pairs only.
    this.zipFreeStreets = this.streets.filter((s) => nameCity.get(`${s.name}|${s.city}`) === 1);
    for (const t of input.technicians) {
      if (t.installer) continue;
      const list = this.techsByBranch.get(t.branch) ?? [];
      list.push(t);
      this.techsByBranch.set(t.branch, list);
    }
    const inst = input.technicians.find((t) => t.installer);
    if (!inst) throw new Error('generator: the roster has no installer');
    this.installer = inst;
    for (const t of planTechnicians(input.technicians as Parameters<typeof planTechnicians>[0])) {
      this.skills.set(t.employeeNumber, new Set(t.skills.map((k) => (k === 'heating_cooling' ? 'hvac' : k))));
    }
    for (const b of BRANCH_ORDER) if (!this.techsByBranch.get(b)?.length) throw new Error(`generator: no technician in branch ${b}`);
  }

  run(): Output {
    this.placeNamed();
    this.placePairs();
    this.placeSingles();
    this.assignRefs();
    const visits = this.makeVisits();
    const equipment = this.makeEquipment();
    const fixture = this.makeFixture(visits);
    return {
      'customers.csv': this.customersCsv(),
      'visits.csv': this.visitsCsv(visits),
      'equipment.csv': equipment,
      'fixture.json': fixture,
      'truth.json': this.truthJson(),
    };
  }

  // ----- customers -----

  private keysOf(c: Customer): string[] {
    return blockingKeys(c.name, c.street.name, c.street.city, c.street.zip, zipCell(c));
  }

  /** Register a single customer or a pair as 1 unit; false when any of its blocks is already held. */
  private tryPlace(unit: Customer[]): boolean {
    const keys = new Set(unit.flatMap((c) => this.keysOf(c)));
    for (const k of keys) if (this.blocks.has(k)) return false;
    const owner = this.nextOwner++;
    for (const k of keys) this.blocks.set(k, owner);
    for (const c of unit) this.customers.push(c);
    return true;
  }

  private base(street: StreetRow, name: string, flag: Flag, lang: 'en' | 'es'): Customer {
    const rng = this.rng;
    const area = AREA[street.branch] ?? '614';
    const hasMobile = flag === 'bad_phone' || rng.chance(92, 100);
    let mobile = hasMobile ? phone(area, line(rng)) : '';
    if (flag === 'bad_phone') mobile = this.badPhone(area);
    const toks = name.split(' ');
    const email = name !== '' && rng.chance(40, 100)
      ? `${fold(toks[0] ?? '').replace(/ /g, '')}.${fold(toks.slice(1).join(' ')).replace(/ /g, '')}${rng.range(1, 99)}@${EMAIL_DOMAIN}`
      : '';
    return {
      ref: 0,
      name,
      street,
      house: this.house(),
      mobile,
      homePhone: rng.chance(30, 100) ? phone(area, line(rng)) : '',
      email,
      lang,
      zone: BRANCH_ZONE,
      textsOn: hasMobile && flag !== 'bad_phone' && rng.chance(88, 100),
      since: rng.range(day('2005-01-03'), day('2026-08-28')),
      homeType: rng.chance(92, 100) ? rng.pick(HOME_TYPES) : '',
      gettingIn: rng.chance(8, 100) ? rng.pick(GETTING_IN) : '',
      flag,
      pair: -1,
      named: '',
    };
  }

  /** A phone cell too short to be a number: an area code and fewer than 7 more digits (FR-IMP-6 "bad phone number"). */
  private badPhone(area: string): string {
    const l = String(line(this.rng)).padStart(4, '0');
    switch (this.rng.int(3)) {
      case 0: return `(${area}) 555-${l.slice(0, 3)}`;
      case 1: return `(${area}) 555-${l.slice(0, 2)}`;
      default: return `${area}-555-${l.slice(0, 2)}`;
    }
  }

  /** Made-up house numbers from the PRNG (FR-IMP-8, OA-41): the street list has no house-number field. */
  private house(): number {
    const r = this.rng.int(100);
    if (r < 10) return this.rng.range(1, 99);
    if (r < 85) return this.rng.range(100, 4999);
    return this.rng.range(5000, 9999);
  }

  private personName(lang: 'en' | 'es'): [string, string] {
    const rng = this.rng;
    const first = lang === 'es' ? rng.pick(this.hispFirsts) : rng.pick(this.firsts);
    const last = lang === 'es' && rng.chance(7, 10) ? rng.pick(this.hispLasts) : rng.pick(this.lasts);
    return [first, last];
  }

  private lang(): 'en' | 'es' {
    return this.rng.chance(8, 100) ? 'es' : 'en';
  }

  private placeNamed(): void {
    const people = this.input.people;
    const byKey = new Map(people.map((p) => [p.key, p]));
    const done = new Set<string>();
    for (const p of people) {
      if (done.has(p.key)) continue;
      const unit = [p];
      if (p.likelyPairWith) {
        const q = byKey.get(p.likelyPairWith);
        if (!q) throw new Error(`named-people: ${p.key} pairs with a missing person ${p.likelyPairWith}`);
        unit.push(q);
      }
      const cs = unit.map((x) => this.namedCustomer(x));
      if (!this.tryPlace(cs)) throw new Error(`named-people: ${p.key} shares a blocking key with an earlier named person`);
      if (cs.length === 2) this.pairs.push({ kind: 'likely', a: cs[0] as Customer, b: cs[1] as Customer });
      for (const x of unit) done.add(x.key);
    }
  }

  private namedCustomer(p: NamedPerson): Customer {
    const street = this.byKey.get(streetKey(p.street));
    if (!street) throw new Error(`named-people: ${p.key}'s street ${streetKey(p.street)} is not a unique row of the street list`);
    return {
      ref: 0, name: p.name, street, house: p.houseNumber, mobile: p.mobile, homePhone: p.homePhone, email: p.email,
      lang: p.textLanguage, zone: p.timeZone, textsOn: p.textsOn, since: day(p.customerSince), homeType: p.homeType,
      gettingIn: p.gettingIn, flag: 'none', pair: -1, named: p.key,
    };
  }

  private placePairs(): void {
    const namedLikely = this.pairs.length;
    let exact = 0;
    let likely = namedLikely;
    // Alternate the 2 kinds so neither crowds the other out of the dense ZIP codes.
    while (exact < TARGETS.exactPairs || likely < TARGETS.likelyPairs) {
      const wantExact = exact < TARGETS.exactPairs && (likely >= TARGETS.likelyPairs || this.rng.chance(TARGETS.exactPairs, TARGETS.pairs));
      if (wantExact ? this.placeExact() : this.placeLikely()) {
        if (wantExact) exact++;
        else likely++;
      }
    }
  }

  private pairBase(): Customer {
    const lang = this.lang();
    const [first, last] = this.personName(lang);
    const c = this.base(this.rng.pick(this.streets), `${first} ${last}`, 'none', lang);
    if (c.mobile === '') c.mobile = phone(AREA[c.street.branch] ?? '614', line(this.rng));
    return c;
  }

  /** An exact pair: the same folded name, street, house number and mobile digits; other fields may differ. */
  private placeExact(): boolean {
    const a = this.pairBase();
    const b: Customer = { ...a, since: this.rng.range(a.since, day('2026-08-28')), email: this.rng.chance(1, 2) ? a.email : '' };
    switch (this.rng.int(4)) {
      case 0: b.name = a.name.toUpperCase(); break;
      case 1: b.mobile = a.mobile.replace(/^\((\d{3})\) (\d{3})-(\d{4})$/, '$1-$2-$3'); break;
      case 2: b.homePhone = ''; b.homeType = ''; break;
      default: break;
    }
    if (exactKeyOf(a) !== exactKeyOf(b)) throw new Error('generator: exact pair keys differ');
    if (!this.tryPlace([a, b])) return false;
    a.pair = b.pair = this.pairs.length;
    this.pairs.push({ kind: 'exact', a, b });
    return true;
  }

  /** A likely pair: a name variant inside a shared block, never an exact match (section 6.7 "Duplicates"). */
  private placeLikely(): boolean {
    const rng = this.rng;
    const a = this.pairBase();
    const [first, ...rest] = a.name.split(' ');
    const last = rest.join(' ');
    const b: Customer = { ...a, since: rng.range(a.since, day('2026-08-28')), email: '' };
    const kind = rng.int(3);
    if (kind === 0) {
      const nick = NICKNAMES[first ?? ''];
      if (!nick) return false;
      b.name = `${nick} ${last}`;
      if (rng.chance(1, 3)) b.house = this.house(); // moved within the street: the last-name block still holds them
    } else if (kind === 1) {
      const typo = typoOf(rng, last);
      if (!typo) return false;
      b.name = `${first} ${typo}`;
    } else {
      b.name = `${first} ${last}-${rng.pick(this.lasts)}`;
    }
    if (rng.chance(1, 2)) b.mobile = phone(AREA[a.street.branch] ?? '614', line(rng));
    if (exactKeyOf(a) === exactKeyOf(b)) return false;
    const ka = new Set(this.keysOf(a));
    if (!this.keysOf(b).some((k) => ka.has(k))) return false;
    if (!this.tryPlace([a, b])) return false;
    a.pair = b.pair = this.pairs.length;
    this.pairs.push({ kind: 'likely', a, b });
    return true;
  }

  private placeSingles(): void {
    const rng = this.rng;
    const singles = TARGETS.customers - this.customers.length;
    const flags: Flag[] = [
      ...Array<Flag>(TARGETS.missingZip).fill('missing_zip'),
      ...Array<Flag>(TARGETS.badPhone).fill('bad_phone'),
      ...Array<Flag>(TARGETS.customerNameBlank).fill('blank_name'),
    ];
    while (flags.length < singles) flags.push('none');
    rng.shuffle(flags);
    for (const flag of flags) {
      for (let attempt = 0; ; attempt++) {
        if (attempt > 10_000) throw new Error('generator: could not place a single customer');
        const lang = this.lang();
        const [first, last] = this.personName(lang);
        const street = rng.pick(flag === 'missing_zip' ? this.zipFreeStreets : this.streets);
        const c = this.base(street, flag === 'blank_name' ? '' : `${first} ${last}`, flag, lang);
        if (this.tryPlace([c])) break;
      }
    }
  }

  /** Old-system customer numbers: shuffled over a range with gaps; the gaps are deleted customers (orphan visits). */
  private deletedRefs: number[] = [];
  private assignRefs(): void {
    const pool: number[] = [];
    for (let n = 100_001; n < 100_001 + TARGETS.customers + 300; n++) pool.push(n);
    this.rng.shuffle(pool);
    this.customers.forEach((c, i) => { c.ref = pool[i] as number; });
    this.deletedRefs = pool.slice(TARGETS.customers).sort((x, y) => x - y);
    this.customers.sort((x, y) => x.ref - y.ref);
  }

  private customersCsv(): string {
    return toCsv(CUSTOMER_COLUMNS, this.customers.map((c) => [
      custRef(c.ref), c.name, c.mobile, c.homePhone, c.email, c.street.name, c.house, c.street.city, zipCell(c), c.lang,
      c.zone, c.textsOn ? 'yes' : 'no', iso(c.since), c.homeType, c.gettingIn, EXPORTED_AT,
    ]));
  }

  private truthJson(): string {
    const seed = this.input.seed ?? SEED;
    const rows = (kind: 'exact' | 'likely') => this.pairs
      .filter((p) => p.kind === kind)
      .map((p) => (p.a.ref < p.b.ref ? [p.a.ref, p.b.ref] : [p.b.ref, p.a.ref]) as [number, number])
      .sort((x, y) => x[0] - y[0])
      .map(([a, b]) => ({ a: custRef(a), b: custRef(b) }));
    return jsonLines({
      _doc: 'The planted-truth file (FR-IMP-3, FR-IMP-6): every planted duplicate pair by customers.csv customer_ref; a is the pair\'s row that comes first in customers.csv (record A, OI-50). Written by @bw/generator from seed ' + seed + '.',
      seed,
      counts: { exact: TARGETS.exactPairs, likely: TARGETS.likelyPairs },
      exact: rows('exact'),
      likely: rows('likely'),
    });
  }

  // ----- visits -----

  private branchTechs(branch: string): Technician[] {
    return this.techsByBranch.get(branch) as Technician[];
  }

  private makeVisits(): Visit[] {
    const rng = this.rng;
    const visits: Visit[] = [];
    const harold = this.customers.find((c) => c.named === 'harold-jenkins');
    const eligible = this.customers.filter((c) => c !== harold).sort((x, y) => x.since - y.since || x.ref - y.ref);
    const sinces = eligible.map((c) => c.since);
    // Mon to Fri twice, Saturday once (a half day), Sunday never.
    const dayPool: number[] = [];
    for (let d = HISTORY_START; d <= LAST_VISIT_DAY; d++) {
      const w = isoDow(d);
      if (w === 7) continue;
      dayPool.push(d);
      if (w !== 6) dayPool.push(d);
    }
    const prePilotPool = dayPool.filter((d) => d < PILOT_FIRST);
    let gen = 0;
    const add = (v: Omit<Visit, 'gen' | 'ref'>): void => { visits.push({ ...v, gen: gen++, ref: '' }); };

    for (const p of this.input.people) {
      for (const pv of p.pastVisits ?? []) {
        const c = this.customers.find((x) => x.named === p.key) as Customer;
        add({
          customerRef: c.ref, branch: c.street.branch, d: day(pv.date), dateCell: pv.date, start: minutesOf(pv.windowStart),
          end: minutesOf(pv.windowEnd), arrived: pv.arrivedAt === '' ? -1 : minutesOf(pv.arrivedAt), tech: pv.technician,
          service: pv.service, done: pv.workDone, imported: true, customer: c,
        });
      }
    }
    const namedVisits = visits.length;
    const randomVisits = TARGETS.visits - TARGETS.visitNoCustomer - namedVisits;
    for (let i = 0; i < randomVisits; i++) {
      const d = rng.pick(dayPool);
      const n = upperBound(sinces, d);
      const c = eligible[rng.int(n)] as Customer;
      add(this.visitFor(c.ref, c.street.branch, d, c));
    }
    // Visits whose customer the old system deleted (FR-IMP-6 "visit with no customer").
    for (let i = 0; i < TARGETS.visitNoCustomer; i++) {
      const d = rng.pick(prePilotPool);
      const v = this.visitFor(rng.pick(this.deletedRefs), rng.pick(this.streets).branch, d, null);
      add({ ...v, imported: false });
    }
    // Unreadable dates (FR-IMP-6 "visit date not readable"), all before the pilot period.
    const candidates = visits.filter((v) => v.customer !== null && v.d < PILOT_FIRST && v.customer.named === '');
    rng.shuffle(candidates);
    for (const v of candidates.slice(0, TARGETS.visitDateUnreadable)) {
      v.dateCell = this.badDate(v.d);
      v.imported = false;
    }
    this.plantPilotOutcomes(visits);
    visits.sort((x, y) => x.d - y.d || x.gen - y.gen);
    visits.forEach((v, i) => { v.ref = `V${2_000_001 + i}`; });
    return visits;
  }

  private visitFor(customerRef: number, branch: string, d: number, c: Customer | null): Omit<Visit, 'gen' | 'ref'> {
    const rng = this.rng;
    const sat = isoDow(d) === 6;
    let start: number;
    let end: number;
    if (d < AFTER_FIRST) {
      start = sat || rng.chance(1, 2) ? 8 * 60 : 12 * 60; // the old way: 4-hour windows (STORY)
      end = start + 240;
    } else {
      start = (8 + 2 * rng.int(sat ? 2 : 5)) * 60; // the pilot: 2-hour windows
      end = start + 120;
    }
    const svc = rng.pick(OLD_SERVICES);
    let tech: string;
    if (d < day('2022-01-01') && rng.chance(2, 100)) tech = NOT_RECORDED;
    else if (d < day('2024-01-01') && rng.chance(25, 100)) tech = rng.pick(FORMER_TECHNICIANS);
    else if (svc.service === 'Sump pump install' && branch === this.installer.branch) tech = this.installer.name;
    else tech = rng.pick(this.branchTechs(branch)).name;
    // Outside the pilot period: the old way's rates; inside it, plantPilotOutcomes sets exact quotas.
    const noh = rng.chance(6, 100);
    const arrived = noh ? -1 : this.arrival(start, end, rng.chance(74, 100));
    return { customerRef, branch, d, dateCell: iso(d), start, end, arrived, tech, service: svc.service, done: noh ? '' : rng.pick(svc.done), imported: true, customer: c };
  }

  private arrival(start: number, end: number, onTime: boolean): number {
    return onTime ? start + this.rng.int(end - start + 1) : end + this.rng.range(1, 75);
  }

  private badDate(d: number): string {
    const s = iso(d);
    switch (this.rng.int(4)) {
      case 0: return `${s.slice(0, 4)}-13-${s.slice(8)}`;
      case 1: return `${s.slice(0, 4)}-02-30`;
      case 2: return `${s.slice(8)}/${s.slice(5, 7)}/${s.slice(2, 4)}x`;
      default: return '00/00/0000';
    }
  }

  /**
   * SD-25: imported visits dated Jun 1 to Aug 30, 2026 get exact per-week quotas. Before period (weeks starting Jun 1
   * to Jul 13): 6% no one home, 74% of the rest on time. After period (weeks from Jul 20): under 2.5% no one home and
   * at least 92% of the rest on time, so every week clears SD-25's "at least 90%, under 3%".
   */
  private plantPilotOutcomes(visits: Visit[]): void {
    const weeks = new Map<number, Visit[]>();
    for (const v of visits) {
      if (!v.imported || v.d < PILOT_FIRST || v.d > LAST_VISIT_DAY) continue;
      const w = weekStart(v.d);
      const list = weeks.get(w) ?? [];
      list.push(v);
      weeks.set(w, list);
    }
    for (const w of [...weeks.keys()].sort((x, y) => x - y)) {
      const list = weeks.get(w) as Visit[];
      this.applyQuota(list, w < AFTER_FIRST ? 'before' : 'after', (v, outcome) => {
        v.arrived = outcome === 'noh' ? -1 : this.arrival(v.start, v.end, outcome === 'on');
        const svc = OLD_SERVICES.find((s) => s.service === v.service);
        v.done = outcome === 'noh' ? '' : this.rng.pick(svc?.done ?? ['Done.']);
        if (v.tech === NOT_RECORDED || FORMER_TECHNICIANS.includes(v.tech)) v.tech = this.rng.pick(this.branchTechs(v.branch)).name;
      });
    }
  }

  private applyQuota<T>(items: T[], period: 'before' | 'after', set: (item: T, outcome: 'noh' | 'on' | 'late') => void): void {
    const n = items.length;
    const { noh, on } = quota(n, period);
    const order = this.rng.shuffle(items.map((_, i) => i));
    order.forEach((idx, k) => set(items[idx] as T, k < noh ? 'noh' : k < noh + on ? 'on' : 'late'));
  }

  private visitsCsv(visits: Visit[]): string {
    return toCsv(VISIT_COLUMNS, visits.map((v) => [
      v.ref, custRef(v.customerRef), v.dateCell, hhmm(v.start), hhmm(v.end), v.arrived < 0 ? '' : hhmm(v.arrived),
      v.arrived < 0 ? 'no_one_home' : 'done', v.tech, v.service, v.arrived < 0 ? 'No one home. Left a door tag.' : v.done,
    ]));
  }

  // ----- equipment -----

  private makeEquipment(): string {
    const rng = this.rng;
    type Eq = { gen: number; c: Customer; type: string; year: string; location: string; details: string; noAddress: boolean };
    const rows: Eq[] = [];
    let gen = 0;
    for (const p of this.input.people) {
      const c = this.customers.find((x) => x.named === p.key) as Customer;
      for (const e of p.equipment ?? []) rows.push({ gen: gen++, c, type: e.type, year: String(e.year), location: e.location, details: e.details, noAddress: false });
    }
    const pool = this.customers.filter((c) => c.flag !== 'missing_zip' && c.named === '');
    const random = TARGETS.equipment - rows.length;
    for (let i = 0; i < random; i++) {
      const c = rng.pick(pool);
      const t = weightedPick(rng, EQUIPMENT_TYPES);
      const sinceYear = Number(iso(c.since).slice(0, 4));
      const year = rng.chance(9, 10) ? String(rng.range(Math.max(1995, sinceYear - 12), 2026)) : '';
      rows.push({ gen: gen++, c, type: t.type, year, location: rng.pick(t.location), details: rng.pick(t.label), noAddress: false });
    }
    const randomRows = rows.filter((r) => r.c.named === '');
    rng.shuffle(randomRows);
    for (const r of randomRows.slice(0, TARGETS.equipmentNoAddress)) r.noAddress = true;
    rows.sort((x, y) => x.c.ref - y.c.ref || x.gen - y.gen);
    return toCsv(EQUIPMENT_COLUMNS, rows.map((r, i) => [
      `E${3_000_001 + i}`, custRef(r.c.ref), r.noAddress ? '' : r.c.street.name, r.noAddress ? '' : r.c.house,
      r.noAddress ? '' : r.c.street.city, r.noAddress ? '' : zipCell(r.c), r.type, r.year, r.location, r.details,
    ]));
  }

  // ----- the world seed's fixture (D-3 step 2): the customers its rows name (the import writes them, the seed finds them), pilot and demo-week jobs, pilot calls, memberships and the sample day script -----

  private makeFixture(visits: Visit[]): string {
    const seed = this.input.seed ?? SEED;
    const rng = this.rng;
    const named = new Map(this.customers.filter((c) => c.named !== '').map((c) => [c.named, c]));
    const used = new Set<number>();
    const pick = this.fixturePicker(used);
    const techByNumber = new Map(this.input.technicians.map((t) => [t.employeeNumber, t]));
    const maria = techByNumber.get('40712');
    const marcus = this.input.technicians.find((t) => t.name === 'Marcus Bell');
    if (!maria || maria.name !== 'Maria Santos' || !marcus) throw new Error('generator: the roster needs Maria Santos (40712) and Marcus Bell');

    // Pilot jobs, Mon, Aug 31 to Mon, Sep 14, 2026 (SD-25, OI-59), with per-day quotas so any 7 days clear 90% (OI-25).
    const pilotJobs: FixtureJob[] = [];
    let order = 0;
    for (let d = PILOT_JOBS_FIRST; d <= PILOT_JOBS_LAST; d++) {
      if (isoDow(d) === 7) continue;
      const dayJobs = this.dayJobs(d, isoDow(d) === 6 ? { columbus: 12, dayton: 6, springfield: 2 } : { columbus: 36, dayton: 16, springfield: 4 }, pick, () => order++);
      this.applyQuota(dayJobs, 'after', (j, outcome) => {
        j.status = outcome === 'noh' ? 'no_one_home' : 'done';
        const svc = SERVICES.find((s) => s.id === j.service) as (typeof SERVICES)[number];
        if (outcome === 'noh') {
          j.arrived = -1;
          j.ended = j.start + rng.range(20, 100);
        } else {
          j.arrived = this.arrival(j.start, j.end, outcome === 'on');
          j.ended = Math.min(j.arrived + svc.minutes + rng.range(-15, 30), 23 * 60 + 59);
        }
      });
      pilotJobs.push(...dayJobs);
    }
    pilotJobs.sort(jobOrder);
    // The pilot jobs end just below 24800, leaving out the numbers there the pages tell as demo-week jobs (24790, 24791, 24797).
    const toldBelow = STORY_JOBS.map((p) => p.jobNumber).filter((n) => n < FIRST_LIVE_JOB_NUMBER).sort((x, y) => x - y);
    const pilotNumbers: number[] = [];
    for (let n = FIRST_LIVE_JOB_NUMBER - 1; pilotNumbers.length < pilotJobs.length; n--) if (!toldBelow.includes(n)) pilotNumbers.unshift(n);
    pilotJobs.forEach((j, i) => { j.jobNumber = pilotNumbers[i] as number; });
    this.fitSkills(pilotJobs);

    // Demo-week jobs, Tue, Sep 15 to Mon, Sep 21 (Sunday off), with the sample day's named visits placed on purpose.
    const demoJobs: FixtureJob[] = [];
    for (let d = DEMO_FIRST; d <= DEMO_LAST; d++) {
      if (isoDow(d) === 7) continue;
      const sat = isoDow(d) === 6;
      const perWindow = sat ? undefined : { columbus: d === SAMPLE_DAY ? SAMPLE_DAY_COLUMBUS_WINDOWS : DEMO_COLUMBUS_WINDOWS, dayton: DEMO_DAYTON_WINDOWS };
      demoJobs.push(...this.dayJobs(d, sat ? { columbus: 22, dayton: 10, springfield: 4 } : { columbus: 46, dayton: 30, springfield: 10 }, pick, () => order++, d === SAMPLE_DAY ? maria : undefined, perWindow));
    }
    // A service the story or an approved page tells; fitSkills never changes one (F-1666).
    const told = new Set<FixtureJob>();
    const place = (customer: Customer, tech: Technician, start: number, service: ServiceId, words?: { problem: string; workAs: ServiceId }): void => {
      const slot = demoJobs.find((j) => j.d === SAMPLE_DAY && j.technician === tech && j.start === start);
      if (!slot) throw new Error(`generator: no sample-day slot for ${tech.name} at ${hhmm(start)}`);
      slot.customer = customer;
      slot.service = service;
      if (words) Object.assign(slot, words);
      told.add(slot);
    };
    place(named.get('harold-jenkins') as Customer, maria, 10 * 60, 'furnace_tune_up');
    place(named.get('linda-miller') as Customer, maria, 12 * 60, 'ac_tune_up');
    // F-1666: the pages tell Rosa Delgado's visit as a sump pump install with Marcus Bell, 2-4 PM, but the catalog's sump pump
    // install needs the install skill, which only the installer has. Marcus is a plumber, so the job is the nearest catalog
    // service his skill covers, with the pages' words as its problem (the F-292 rule for a page service the catalog lacks). Its
    // visit's work is still drawn on the install's 180 minutes, the time those words take, so the SD-21 script rows stay byte
    // for byte as drawn; it is his last stop that day, so no other visit moves.
    place(named.get('rosa-delgado') as Customer, marcus, 14 * 60, 'plumbing_repair', { problem: 'Sump pump install', workAs: 'sump_pump_install' });
    demoJobs.sort(jobOrder);
    // The demo week takes the told numbers below 24800 first, then 24800 on; the pins then move each told number to its slot.
    const demoNumbers = [...toldBelow, ...demoJobs.slice(toldBelow.length).map((_, i) => FIRST_LIVE_JOB_NUMBER + i)];
    demoJobs.forEach((j, i) => { j.jobNumber = demoNumbers[i] as number; });
    // Pin the story's job numbers (F-238): each pinned slot takes its number from whichever job held it, then the facts the
    // page tells (F-292): customer, service, problem, window end, booking channel; an Unassigned job loses its technician.
    const pinned = new Set<FixtureJob>();
    for (const pin of STORY_JOBS) {
      const tech = pin.technician === null ? undefined : this.input.technicians.find((t) => t.employeeNumber === pin.technician);
      const free = (j: FixtureJob): boolean => j.d === day(pin.date) && hhmm(j.start) === pin.windowStart && j.technician !== null
        && j.technician !== this.installer && j.customer.named === '' && !pinned.has(j);
      let slot = tech ? demoJobs.find((j) => j.d === day(pin.date) && j.technician === tech && hhmm(j.start) === pin.windowStart) : undefined;
      if (!slot) {
        // The technician holds no job in that window that day (F-292), or the job is Unassigned: an unpinned, unnamed job of the
        // same branch and window changes hands, so no window changes its count and a technician still holds 1 job in the window.
        slot = demoJobs.find((j) => free(j) && (j.technician as Technician).branch === (tech?.branch ?? 'columbus'));
        if (slot) slot.technician = tech ?? null;
      }
      const holder = demoJobs.find((j) => j.jobNumber === pin.jobNumber);
      if (!slot || !holder) throw new Error(`generator: no demo-week slot for story job ${pin.jobNumber}`);
      [holder.jobNumber, slot.jobNumber] = [slot.jobNumber, pin.jobNumber];
      pinned.add(slot);
      if (pin.customer) slot.customer = 'named' in pin.customer ? named.get(pin.customer.named) as Customer : this.storyCustomer(pin.customer, used);
      if (pin.service) { slot.service = pin.service; told.add(slot); }
      if (pin.problem) slot.problem = pin.problem;
      if (pin.windowEnd) slot.end = minutesOf(pin.windowEnd);
      if (pin.bookedVia) slot.bookedVia = pin.bookedVia;
      if (pin.bookedAt) slot.bookedAt = pin.bookedAt;
    }
    // Hand-overs after every pin is placed, so no pin above finds a handed-over job in its technician's window.
    for (const pin of STORY_JOBS) {
      if (!pin.handedTo) continue;
      const to = this.input.technicians.find((t) => t.employeeNumber === pin.handedTo);
      if (!to) throw new Error(`generator: story job ${pin.jobNumber} is handed to an unknown technician ${pin.handedTo}`);
      (demoJobs.find((j) => j.jobNumber === pin.jobNumber) as FixtureJob).technician = to;
    }
    this.fitSkills(demoJobs, told);
    const harold = demoJobs.find((j) => j.customer.named === 'harold-jenkins') as FixtureJob;
    if (harold.jobNumber !== HAROLD_SAMPLE_JOB) throw new Error('generator: Harold Jenkins is not on story job 24830');
    demoJobs.sort((x, y) => x.jobNumber - y.jobNumber);

    // Simulated "where is my tech" calls (SD-25): the before period near twice the after period's rate per visit.
    const calls = this.pilotCalls(visits, pilotJobs);

    // Memberships: Harold's and Sean's from named-people.json, then about 6% of the customers the fixture may name.
    const members: { c: Customer; since: string; renews: string; benefitsKey: string }[] = [];
    for (const p of this.input.people) {
      if (p.membership) members.push({ c: named.get(p.key) as Customer, ...p.membership });
    }
    for (let i = 0; i < 1100; i++) {
      const c = pick(undefined);
      const lo = Math.max(c.since, day('2012-01-02'));
      const sinceDay = rng.range(lo, day('2026-08-28'));
      const s = iso(sinceDay);
      const since = `${s.slice(0, 7)}-01`;
      let ry = Number(s.slice(0, 4)) + 1;
      while (`${ry}${since.slice(4)}` <= '2026-09-15') ry++;
      members.push({ c, since, renews: `${ry}${since.slice(4)}`, benefitsKey: 'comfort_club' });
    }
    members.sort((x, y) => x.c.ref - y.c.ref);

    const storyScripts = new Map(STORY_JOBS.flatMap((p) => (p.script ? [[p.jobNumber, p.script] as const] : [])));
    // The sample-day script (SD-21): every demo-week job except Maria's from Harold's 10 AM-12 PM job onward.
    const script = demoJobs
      .filter((j) => j.technician !== null && !(j.d === SAMPLE_DAY && j.technician === maria && j.start >= 10 * 60))
      .map((j) => {
        const r = rng.int(100);
        const noOne = r < 2;
        const late = !noOne && r < 10;
        const svc = SERVICES.find((s) => s.id === (j.workAs ?? j.service)) as (typeof SERVICES)[number];
        return {
          jobNumber: j.jobNumber,
          onMyWayLeadMinutes: rng.range(15, 35),
          arrivalDelayMinutes: noOne ? 0 : late ? rng.range(20, 50) : rng.range(-10, 12),
          outcome: noOne ? 'no_one_home' : 'finished',
          workMinutes: noOne ? rng.range(5, 15) : svc.minutes + rng.range(-15, 30),
          partsCount: noOne ? 0 : rng.int(4),
        };
      })
      // A story job's visit as the page tells it at 10:28 AM (F-292), laid over the drawn row: a pinned row still takes its
      // draws, so the pins move no other row's numbers. The filter above does move them (F-1742): a job it drops takes no
      // draw (Maria's sample-day jobs from 10 AM, and the week's jobs with no technician, 3 of them), so every later row
      // reads the stream from a different point than it would with those jobs drawn.
      .map((row) => {
        const pinScript = storyScripts.get(row.jobNumber);
        return pinScript ? { ...row, ...pinScript, outcome: 'finished' } : row;
      });

    const referenced = new Map<number, Customer>();
    for (const j of [...pilotJobs, ...demoJobs]) referenced.set(j.customer.ref, j.customer);
    for (const m of members) referenced.set(m.c.ref, m.c);
    const fixtureCustomers = [...referenced.values()].sort((x, y) => x.ref - y.ref).map((c) => ({
      ref: custRef(c.ref), name: c.name, nameSearch: fold(c.name), street: c.street.name, city: c.street.city,
      zip: c.street.zip, houseNumber: c.house,
    }));
    const job = (j: FixtureJob) => ({
      jobNumber: j.jobNumber, customer: custRef(j.customer.ref), technician: j.technician?.employeeNumber ?? null,
      ...(j.technician === null ? { branch: j.customer.street.branch } : {}), service: j.service,
      ...(j.problem ? { problem: j.problem } : {}),
      date: iso(j.d), windowStart: hhmm(j.start), windowEnd: hhmm(j.end), status: j.status,
      arrivedAt: j.arrived < 0 ? null : hhmm(j.arrived), endedAt: j.ended < 0 ? null : hhmm(j.ended),
      bookedVia: j.bookedVia, bookedAt: j.bookedAt,
    });
    return jsonLines({
      _doc: 'The world seed\'s fixture (BUILD_PLAN D-3 step 2; SD-21, SD-25), written by @bw/generator from seed ' + seed + '. Times are local wall clock in zone; job and call customers are named by customers.ref, and customers carries the import\'s exact-match key (nameSearch, street, city, zip, houseNumber) the world seed resolves (R-BP1). No customer here is in a truth.json pair. Technicians are employee numbers of technicians.json; services are the ids of the generator README. sampleDayScript holds each visit\'s minutes; the world seed chains them on the technician-day (src/chain.ts), since the drive minutes need the baked tracks.',
      seed,
      zone: BRANCH_ZONE,
      customers: fixtureCustomers,
      pilotJobs: pilotJobs.map(job),
      pilotCalls: calls,
      demoWeekJobs: demoJobs.map(job),
      memberships: members.map((m) => ({ customer: custRef(m.c.ref), since: m.since, renews: m.renews, benefitsKey: m.benefitsKey })),
      sampleDayScript: script,
    });
  }

  /**
   * F-292: the customer a story job's page names, made from an unused customer the fixture may name, in the page's city (no
   * PRNG draw, so the rest of the world stays as drawn): the first by ref with an English mobile that takes texts, renamed, its
   * email user name and blocking keys moved to the new name. A candidate whose new keys another customer holds is passed over,
   * so the rename plants no duplicate the truth file does not list. When every candidate's new keys are held (another seed's
   * world can hold the page's surname in the page's zip), the first candidate trades names with the 1 plain customer that holds
   * them, if both new key sets are then free.
   */
  private storyCustomer(want: { name: string; city: string }, used: Set<number>): Customer {
    const area = CITY_AREAS[want.city];
    const city = area?.city ?? want.city;
    const plain = (c: Customer): boolean => !used.has(c.ref) && c.flag === 'none' && c.pair < 0 && c.named === '';
    const candidates = this.customers.filter((c) => plain(c) && c.street.city === city && c.lang === 'en' && c.textsOn && c.mobile !== ''
      && (!area || area.zips.includes(c.street.zip)));
    for (const c of candidates) {
      if (this.renameAll([[c, want.name]])) { used.add(c.ref); return c; }
    }
    for (const c of candidates) {
      const held = new Set(blockingKeys(want.name, c.street.name, c.street.city, c.street.zip, zipCell(c)).filter((k) => this.blocks.has(k)));
      const holders = this.customers.filter((o) => o !== c && this.keysOf(o).some((k) => held.has(k)));
      const [o] = holders;
      if (holders.length !== 1 || !o || !plain(o)) continue;
      if (this.renameAll([[c, want.name], [o, c.name]])) { used.add(c.ref); return c; }
    }
    throw new Error(`generator: no fixture customer in ${want.city} to name ${want.name}`);
  }

  /** Give each single customer its new name, email user name and blocking keys, or change nothing when a new key is held by another. */
  private renameAll(moves: readonly (readonly [Customer, string])[]): boolean {
    const owners = moves.map(([c]) => this.blocks.get(this.keysOf(c)[0] as string) as number);
    const mine = new Set(owners);
    const next = moves.map(([c, name]) => blockingKeys(name, c.street.name, c.street.city, c.street.zip, zipCell(c)));
    const all = next.flat();
    if (new Set(all).size !== all.length || all.some((k) => this.blocks.has(k) && !mine.has(this.blocks.get(k) as number))) return false;
    moves.forEach(([c], i) => { for (const k of this.keysOf(c)) if (this.blocks.get(k) === owners[i]) this.blocks.delete(k); });
    moves.forEach(([c, name], i) => {
      for (const k of next[i] as string[]) this.blocks.set(k, owners[i] as number);
      const toks = name.split(' ');
      const n = /(\d+)@/.exec(c.email)?.[1] ?? '';
      c.name = name;
      if (c.email !== '') c.email = `${fold(toks[0] ?? '').replace(/ /g, '')}.${fold(toks.slice(1).join(' ')).replace(/ /g, '')}${n}@${EMAIL_DOMAIN}`;
    });
    return true;
  }

  /** Customers the fixture may name: no flag, no planted partner, not a named person (D-3 step 5, R-BP1). */
  private fixturePicker(used: Set<number>): (branch: string | undefined) => Customer {
    const byBranch = new Map<string, Customer[]>();
    const all: Customer[] = [];
    for (const c of this.customers) {
      if (c.flag !== 'none' || c.pair >= 0 || c.named !== '') continue;
      all.push(c);
      const list = byBranch.get(c.street.branch) ?? [];
      list.push(c);
      byBranch.set(c.street.branch, list);
    }
    return (branch) => {
      const list = branch ? (byBranch.get(branch) as Customer[]) : all;
      for (let attempt = 0; attempt < 10_000; attempt++) {
        const c = this.rng.pick(list);
        if (!used.has(c.ref)) { used.add(c.ref); return c; }
      }
      throw new Error('generator: ran out of fixture customers');
    };
  }

  /**
   * 1 day's jobs per branch in 2-hour windows, 5 on a weekday and 2 on Saturday. Technicians take a window in turn;
   * `first`, when given, works every window of its branch that day. On a Columbus weekday the installer takes the
   * first window's last job as a sump pump install.
   */
  private dayJobs(d: number, counts: Record<string, number>, pick: (b: string) => Customer, nextOrder: () => number, first?: Technician, perWindow?: Record<string, readonly number[]>): FixtureJob[] {
    const rng = this.rng;
    const sat = isoDow(d) === 6;
    const windows = sat ? 2 : 5;
    const jobs: FixtureJob[] = [];
    for (const branch of BRANCH_ORDER) {
      const techs = this.branchTechs(branch);
      const total = counts[branch] ?? 0;
      for (let w = 0; w < windows; w++) {
        const c = perWindow?.[branch]?.[w] ?? Math.floor(total / windows) + (w < total % windows ? 1 : 0);
        const others = techs.filter((t) => t !== first);
        const offset = (d * 3 + w) % others.length;
        const rotated = [...others.slice(offset), ...others.slice(0, offset)];
        const seq = first && first.branch === branch ? [first, ...rotated] : rotated;
        for (let k = 0; k < c; k++) {
          const installer = !sat && branch === this.installer.branch && w === 0 && k === c - 1;
          // Past the end of the turn, the others take a second job in the window (never `first`: 1 job per window).
          const turn = k < seq.length ? seq[k] : rotated[(k - seq.length) % rotated.length];
          const technician = installer ? this.installer : (turn as Technician);
          const service: ServiceId = installer ? 'sump_pump_install' : rng.pick(SERVICES.filter((s) => s.skill !== 'install')).id;
          const start = (8 + 2 * w) * 60;
          const booked = d - rng.range(1, 21);
          jobs.push({
            jobNumber: 0, customer: pick(branch), technician, service, d, start, end: start + 120, status: 'scheduled',
            arrived: -1, ended: -1, bookedVia: rng.chance(35, 100) ? 'online' : 'office',
            bookedAt: `${iso(booked)}T${hhmm(rng.range(8 * 60, 17 * 60))}`, order: nextOrder(),
          });
        }
      }
    }
    return jobs;
  }

  /**
   * F-1666: a drawn job whose service needs a skill its technician lacks (the draw, a window's change of hands or a hand-over
   * puts any service on any technician) takes the service of the same minutes the technician's skills cover, by job number
   * among them (a furnace tune-up on a plumber becomes a tankless heater flush; a plumbing repair on a heating and cooling
   * technician becomes a heating or AC fix). No PRNG draw, and the minutes stay, so every other drawn value, plan, ETA and
   * script row stays as drawn. A `told` service (the story's or a page's) is never changed: a mismatch there throws.
   */
  private fitSkills(jobs: readonly FixtureJob[], told: ReadonlySet<FixtureJob> = new Set()): void {
    for (const j of jobs) {
      if (j.technician === null) continue;
      const has = this.skills.get(j.technician.employeeNumber) ?? new Set<string>();
      const svc = SERVICES.find((s) => s.id === j.service) as (typeof SERVICES)[number];
      if (has.has(svc.skill)) continue;
      if (told.has(j)) throw new Error(`generator: job ${j.jobNumber}'s told service ${j.service} needs ${svc.skill}, which ${j.technician.name} lacks`);
      const fits = SERVICES.filter((s) => has.has(s.skill) && s.minutes === svc.minutes);
      const to = fits[j.jobNumber % Math.max(fits.length, 1)];
      if (!to) throw new Error(`generator: no ${svc.minutes}-minute service fits ${j.technician.name} for job ${j.jobNumber}`);
      j.service = to.id;
    }
  }

  private pilotCalls(visits: Visit[], pilotJobs: FixtureJob[]): ({ at: string; visitRef: string } | { at: string; jobNumber: number })[] {
    const rng = this.rng;
    const inPilot = visits.filter((v) => v.imported && v.d >= PILOT_FIRST && v.d <= LAST_VISIT_DAY);
    const before = inPilot.filter((v) => v.d < AFTER_FIRST);
    const after = inPilot.filter((v) => v.d >= AFTER_FIRST);
    const target = (v: Visit): boolean => v.customer !== null && v.customer.flag === 'none' && v.customer.pair < 0;
    const weight = (arrived: number, end: number): number => (arrived < 0 || arrived > end ? 4 : 1);
    type T = { at: (k: number) => string; weight: number; ref: { visitRef: string } | { jobNumber: number } };
    const vT = (v: Visit): T => ({
      weight: weight(v.arrived, v.end),
      ref: { visitRef: v.ref },
      at: () => `${iso(v.d)}T${hhmm(v.start + rng.int(Math.max(1, (v.arrived < 0 ? v.end : Math.min(v.arrived, v.end + 60)) - v.start)))}`,
    });
    const jT = (j: FixtureJob): T => ({
      weight: weight(j.arrived, j.end),
      ref: { jobNumber: j.jobNumber },
      at: () => `${iso(j.d)}T${hhmm(j.start + rng.int(Math.max(1, (j.arrived < 0 ? j.end : Math.min(j.arrived, j.end + 60)) - j.start)))}`,
    });
    const draw = (targets: T[], n: number): { at: string; ref: T['ref'] }[] => {
      const cum: number[] = [];
      let total = 0;
      for (const t of targets) { total += t.weight; cum.push(total); }
      const out: { at: string; ref: T['ref'] }[] = [];
      for (let i = 0; i < n; i++) {
        const t = targets[upperBound(cum, rng.int(total))] as T;
        out.push({ at: t.at(i), ref: t.ref });
      }
      return out;
    };
    const calls = [
      ...draw(before.filter(target).map(vT), Math.round((before.length * CALLS_PER_100_BEFORE) / 100)),
      ...draw([...after.filter(target).map(vT), ...pilotJobs.map(jT)], Math.round(((after.length + pilotJobs.length) * CALLS_PER_100_AFTER) / 100)),
    ];
    const refKey = (r: T['ref']): string => ('visitRef' in r ? r.visitRef : `J${r.jobNumber}`);
    calls.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : refKey(x.ref) < refKey(y.ref) ? -1 : refKey(x.ref) > refKey(y.ref) ? 1 : 0));
    return calls.map((c) => ({ at: c.at, ...c.ref }));
  }
}

/** Calls per 100 visits: STORY's 260 calls a day over about 380 visits a day before; half that after (SD-25). */
const CALLS_PER_100_BEFORE = 68;
const CALLS_PER_100_AFTER = 34;

/** SD-25 quotas for n visits: no one home, then on time among the rest. */
export function quota(n: number, period: 'before' | 'after'): { noh: number; on: number } {
  if (period === 'before') {
    const noh = Math.round((n * 6) / 100);
    return { noh, on: Math.round(((n - noh) * 74) / 100) };
  }
  const noh = Math.floor((n * 25) / 1000);
  return { noh, on: Math.ceil(((n - noh) * 92) / 100) };
}

/** The numbering order; it runs before any story job is Unassigned, so every job holds its technician. */
function jobOrder(x: FixtureJob, y: FixtureJob): number {
  const [a, b] = [x.technician as Technician, y.technician as Technician];
  return x.d - y.d || BRANCH_ORDER.indexOf(a.branch) - BRANCH_ORDER.indexOf(b.branch)
    || x.start - y.start || (a.employeeNumber < b.employeeNumber ? -1 : a.employeeNumber > b.employeeNumber ? 1 : 0)
    || x.order - y.order;
}

function exactKeyOf(c: Customer): string {
  return exactKey(c.name, c.street.name, c.street.city, zipCell(c), c.house, c.mobile);
}

/** Count of items <= x in a sorted array. */
function upperBound(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as number) <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A typo inside a surname: 2 neighboring letters swapped, or 1 letter dropped (never the first letter). */
function typoOf(rng: Prng, last: string): string | null {
  if (last.length < 5 || /[^A-Za-z]/.test(last)) return null;
  const i = rng.range(1, last.length - 2);
  const t = rng.chance(1, 2)
    ? last.slice(0, i) + (last[i + 1] as string) + (last[i] as string) + last.slice(i + 2)
    : last.slice(0, i) + last.slice(i + 1);
  return t.toLowerCase() === last.toLowerCase() ? null : t;
}

/** JSON with 1 array element per line: stable, diffable and byte-identical (key order is construction order). */
function jsonLines(obj: Record<string, unknown>): string {
  const parts = Object.entries(obj).map(([k, v]) => {
    if (Array.isArray(v)) return `${JSON.stringify(k)}: [\n${v.map((x) => JSON.stringify(x)).join(',\n')}\n]`;
    return `${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  });
  return `{\n${parts.join(',\n')}\n}\n`;
}
