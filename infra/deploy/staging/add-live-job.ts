// SPDX-License-Identifier: AGPL-3.0-or-later
// P6-TESTFLIGHT-4: adds 1 job for a new customer to the staging copy's demo day, so its leg is routed live (SD-49) when the owner opens
// Directions to it on the phone. The builder runs it once, after `staging.sh world` and before the owner's session; nothing starts it on
// its own. It talks only to the server address given as its 1st argument.
//   node infra/deploy/staging/add-live-job.ts <https://staging name> --date <YYYY-MM-DD> --office-login <email> --office-password-file <file>
//        [--assign <technician name>]
// Why the office create and not the online booking: the phone's Directions on a job opens the leg to the NEXT job of the same demo day
// (tech-job.ts: nextJob is filled only when the job's date is the demo clock's today), so the new job must sit on the demo day, and
// online booking never offers the demo day (FR-BOOK-9: closed at 5:00 PM the day before). The office channel allows the same day
// (FR-DISP-8, office-writes/service.ts officeDay). What makes the leg live is the new job number (the bake's legs are keyed by the world
// seed's job numbers, packages/maps/src/legs.ts), not the channel.
// Steps: the office signs in (API-03; the password is read from the file and never printed), API-31 technicians, API-111 street search,
// API-34 finds the customer or API-139 creates it, API-20 reads the technician's day. F-1348: the seeded world gives Maria Santos a full
// Sep 15 (5 jobs, the two_hour day's capacity), so when the technician's day is full 1 slot is freed first through the office's own
// writes: her last job of the day (never Harold Jenkins's job, nor the job right after it, which session step 3 drives to) goes to the
// first technician API-30 ranks with room and the skill (API-22), else it is canceled (API-25). Then API-28 creates the new job in the
// freed window, assigned to her (or, with room already, API-29's latest open window that sorts after Harold's next job), and API-20 is
// read again to prove Harold's job and his next job are unchanged and to say which job the new one follows.
// A re-run converges: a day that already holds the new customer's job writes nothing and answers that job; a run that freed the slot
// but did not create the job finds the room and creates it, moving nothing more; the customer is found by name, never made twice.
// Prints 1 line per step and ends with a line that starts "add-live-job:". Exit 0 added; 1 refused or no window; 2 usage.
import { readFileSync } from 'node:fs';
import { isMain } from '../../../ci/is-main.ts';

/**
 * The customer. Why it is outside the baked set: a new customer and a new job number have no baked leg, whatever the street. The name is
 * not in the generator's pools (packages/generator/src/pools.ts), so no seeded customer shares it and the owner can tell the job on Today.
 */
export const CUSTOMER_NAME = 'Nora Quillfeather';
/** House number 1: the job's point is the street's 1st point (SD-23). */
export const HOUSE_NUMBER = 1;
/** The streets tried in order (API-111 text search; real Columbus street names): the first Columbus street found is used. */
export const STREET_QUERIES = ['Broad', 'High', 'Main', 'Fifth'] as const;
/** Session step 3 opens this customer's job and drives to the job after it: neither is moved, and the new job never comes between them. */
export const HAROLD = 'Harold Jenkins';
/** The hosted server stays a locked placeholder until release; the script never names it. */
const HOSTED = 'bw.j7l.io';
const BRANCH = 'columbus';
const SERVICE_ID = 'furnace_tune_up';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export type FetchFn = typeof fetch;

export interface Options {
  server: string;
  date: string;
  officeLogin?: string | undefined;
  officePassword?: string | undefined;
  assign?: string | undefined;
}
/** How 1 slot of the technician's full day was freed before the create (F-1348). */
export interface Freed {
  jobNumber: number; customerName: string; window: string;
  how: 'moved' | 'canceled';
  /** The technician the job went to; null when it was canceled. */
  to: string | null;
}
export interface Added {
  jobNumber: number; address: string; window: string; assignedTo: string | null;
  /** The job before it on the technician's day (what the owner opens, then taps Directions), null when it is the day's first or unassigned. */
  follows: { jobNumber: number; customerName: string; window: string } | null;
  /** The slot freed for it; null when the day had room (or the job was already there). */
  freed: Freed | null;
  /** True when the day already held the customer's job: nothing was written (a re-run). */
  already: boolean;
}

export class AddRefused extends Error {}

interface BoardJob { jobNumber: number; version: number; customerName: string; serviceId: string; windowId: string; window: { start: string; end: string } }
interface DayRow { id: string; name: string; capacity: number; jobs: BoardJob[] }

function api(origin: string, fetchFn: FetchFn, cookie: string | null) {
  return async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> => {
    const r = await fetchFn(`${origin}/api/v1${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(method === 'GET' ? {} : { origin, 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
}
type Api = ReturnType<typeof api>;

/** The server address, checked: https, a host, and not the hosted server. */
export function checkServer(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AddRefused(`not an address: ${raw}`);
  }
  if (u.protocol !== 'https:' && u.hostname !== 'localhost') throw new AddRefused('the server address must be https');
  if (u.hostname === HOSTED) throw new AddRefused('refused: the hosted server stays locked until release');
  return u.origin;
}

/** A wire time as milliseconds, for ordering (the zone suffix in brackets is dropped, as apps/web/src/clock does). */
const ms = (wire: string): number => Date.parse(wire.replace(/\[.*\]$/, ''));
const span = (w: { start: string; end: string }): string => `${w.start} to ${w.end}`;
const code = (r: { json: Json }): string => String(r.json?.error?.code ?? r.json?.code ?? '');

/**
 * The technician's day in the phone's order: API-101's nextJob comes from the technician's live jobs that day ordered by window start,
 * then job number (packages/api-server/src/handlers/tech-job.ts:73-80); API-20 lists the same live (not canceled) jobs.
 */
export const phoneOrder = (jobs: readonly BoardJob[]): BoardJob[] =>
  [...jobs].sort((a, b) => ms(a.window.start) - ms(b.window.start) || a.jobNumber - b.jobNumber);

async function readDay(office: Api, date: string, technicianId: string): Promise<DayRow> {
  const board = await office('GET', `/board?branch=${BRANCH}&date=${date}`);
  const row = (board.json?.data?.technicians as Json[] | undefined)?.find((t) => t.id === technicianId);
  if (board.status !== 200 || !row) throw new AddRefused(`the board answered ${board.status} with no row for the technician`);
  return { id: row.id, name: row.name, capacity: Number(row.capacity), jobs: phoneOrder(row.jobs as BoardJob[]) };
}

/** Harold Jenkins's job and the job after it on the day, when his job is on it (session step 3); refused when his job has no next job. */
function protectedPair(day: DayRow): { harold: BoardJob; next: BoardJob } | null {
  const at = day.jobs.findIndex((j) => j.customerName === HAROLD);
  if (at < 0) return null;
  const next = day.jobs[at + 1];
  if (!next) throw new AddRefused(`${HAROLD}'s job ${day.jobs[at]!.jobNumber} has no next job on ${day.name}'s day (session step 3 needs one)`);
  return { harold: day.jobs[at]!, next };
}

/**
 * F-1348: free 1 slot of a full day. Least destructive first: the day's last job goes to another technician of the branch whom API-30
 * ranks with room and the service's skill (API-22, tried in API-30's order; the server's own room check decides each), else it is
 * canceled (API-25). Harold's job and the job after it are never the one freed.
 */
async function freeSlot(office: Api, date: string, day: DayRow, keep: ReadonlySet<number>, log: (line: string) => void): Promise<{ freed: Freed; windowId: string }> {
  const last = day.jobs[day.jobs.length - 1];
  if (!last || keep.has(last.jobNumber)) {
    throw new AddRefused(`${day.name}'s day is full and its last job is ${HAROLD}'s or the one after it: no job to free`);
  }
  const base = { jobNumber: last.jobNumber, customerName: last.customerName, window: span(last.window) };
  const room = await office('GET', `/technicians/room?branch=${BRANCH}&date=${date}&windowId=${last.windowId}&serviceId=${last.serviceId}&jobNumber=${last.jobNumber}`);
  if (room.status !== 200) throw new AddRefused(`the suggested technicians read answered ${room.status}`);
  const candidates = (room.json.data.technicians as Json[]).filter((t) => t.room === true && t.reason === null && t.id !== day.id);
  for (const t of candidates) {
    const r = await office('POST', `/jobs/${last.jobNumber}/assignment`, { technicianId: t.id, baseVersion: last.version });
    if (r.status === 200) {
      log(`add-live-job: freed 1 slot: moved job ${last.jobNumber} (${last.customerName}, ${base.window}) from ${day.name} to ${t.name}`);
      return { freed: { ...base, how: 'moved', to: t.name as string }, windowId: last.windowId };
    }
    if (r.status === 409 && ['technician_no_room', 'time_overlap', 'rule_refused'].includes(code(r))) continue; // this one has no room after all: the next
    throw new AddRefused(`moving job ${last.jobNumber} to ${t.name} answered ${r.status} ${code(r)}`);
  }
  const c = await office('POST', `/jobs/${last.jobNumber}/cancellation`, { baseVersion: last.version });
  if (c.status !== 200) throw new AddRefused(`no technician had room for job ${last.jobNumber}, and its cancel answered ${c.status} ${code(c)}`);
  log(`add-live-job: freed 1 slot: no technician had room, so job ${last.jobNumber} (${last.customerName}, ${base.window}) was canceled`);
  return { freed: { ...base, how: 'canceled', to: null }, windowId: last.windowId };
}

export async function addLiveJob(opts: Options, fetchFn: FetchFn = fetch, log: (line: string) => void = () => {}): Promise<Added> {
  const server = checkServer(opts.server);
  if (!opts.officeLogin || !opts.officePassword) throw new AddRefused('the office sign-in is needed: --office-login and --office-password-file');
  const signIn = await fetchFn(`${server}/api/v1/sessions`, {
    method: 'POST', headers: { origin: server, 'content-type': 'application/json' },
    body: JSON.stringify({ login: opts.officeLogin, password: opts.officePassword, client: 'web', keepSignedIn: false }),
  });
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c?.startsWith('bw_session='));
  if (signIn.status !== 200 || !cookie) throw new AddRefused(`the office sign-in answered ${signIn.status}`);
  const office = api(server, fetchFn, cookie);
  const pub = api(server, fetchFn, null);

  let tech: Json | undefined;
  if (opts.assign) {
    const techs = await office('GET', `/technicians?branch=${BRANCH}`);
    if (techs.status !== 200) throw new AddRefused(`the technician list answered ${techs.status}`);
    tech = (techs.json?.data?.technicians as Json[] | undefined)?.find((t) => t.name === opts.assign);
    if (!tech) throw new AddRefused(`no technician named ${opts.assign}`);
  }

  let street: Json | undefined;
  for (const query of STREET_QUERIES) {
    const found = await pub('POST', '/public/street-searches', { query });
    if (found.status !== 200) throw new AddRefused(`street search answered ${found.status}`);
    street = (found.json.data.streets as Json[]).find((s) => s.branch === BRANCH);
    if (street) break;
  }
  if (!street) throw new AddRefused('no Columbus street was found');
  // The customer is found by name first, so a re-run never makes a 2nd one (API-34 exact name in the branch).
  const search = await office('POST', '/customer-searches', { query: CUSTOMER_NAME, filters: { branch: BRANCH } });
  if (search.status !== 200) throw new AddRefused(`the customer search answered ${search.status}`);
  const known = (search.json.data.customers as Json[]).find((c) => c.name === CUSTOMER_NAME);
  let customerId: string;
  let address: string;
  if (known) {
    customerId = known.id as string;
    address = `${known.address.houseNumber} ${known.address.street}`;
    log(`add-live-job: customer ${CUSTOMER_NAME} at ${address} (already on the copy)`);
  } else {
    const made = await office('POST', '/customers', { name: CUSTOMER_NAME, mobile: null, streetId: street.streetId, houseNumber: HOUSE_NUMBER, textLanguage: 'en', textsOn: false });
    if (made.status !== 201) throw new AddRefused(`the customer create answered ${made.status} ${JSON.stringify(made.json?.error ?? made.json).slice(0, 160)}`);
    customerId = made.json.data.id as string;
    address = `${HOUSE_NUMBER} ${street.name}`;
    log(`add-live-job: customer ${CUSTOMER_NAME} at ${address}`);
  }

  // The technician's day before any write: a re-run stops here; Harold's pair is kept; a full day gets 1 slot freed.
  let day: DayRow | null = null;
  let pair: ReturnType<typeof protectedPair> = null;
  let freed: Freed | null = null;
  let windows: { windowId: string; label: string }[] | null = null; // the windows tried, in order; null: API-29's open windows
  if (tech) {
    day = await readDay(office, opts.date, tech.id as string);
    const there = day.jobs.find((j) => j.customerName === CUSTOMER_NAME);
    if (there) {
      log(`add-live-job: job ${there.jobNumber} for ${CUSTOMER_NAME} is already on ${day.name}'s day: nothing written`);
      return { jobNumber: there.jobNumber, address, window: span(there.window), assignedTo: day.name, follows: followOf(day, there.jobNumber), freed: null, already: true };
    }
    pair = protectedPair(day);
    if (day.jobs.length >= day.capacity) {
      const keep = new Set(pair ? [pair.harold.jobNumber, pair.next.jobNumber] : []);
      const f = await freeSlot(office, opts.date, day, keep, log);
      freed = f.freed;
      windows = [{ windowId: f.windowId, label: f.freed.window }];
    }
  }

  if (windows === null) {
    const avail = await office('GET', `/availability?branch=${BRANCH}&serviceId=${SERVICE_ID}&from=${opts.date}&to=${opts.date}&channel=office`);
    if (avail.status !== 200) throw new AddRefused(`availability answered ${avail.status}`);
    const found = (avail.json.data.days as Json[]).find((d) => d.date === opts.date);
    // The latest window first: a job is only reachable when an earlier job leads to it. With Harold's pair on the day, only windows that
    // sort the new job after his next job (its job number is the newest, so the same window start is after too) keep step 3's drive.
    const floor = pair ? ms(pair.next.window.start) : -Infinity;
    const open = ((found?.windows as Json[] | undefined) ?? []).filter((w) => w.state === 'open' && w.left > 0 && ms(w.start) >= floor).reverse();
    if (open.length === 0) throw new AddRefused(`no window with room on ${opts.date}${pair ? ` after ${HAROLD}'s next job` : ''}`);
    windows = open.map((w) => ({ windowId: w.windowId as string, label: span(w) }));
  }

  const tried: string[] = []; // the 409 codes the server sent, in order, for the end line
  for (const { windowId, label } of windows) {
    const r = await office('POST', '/jobs', {
      customerId, serviceId: SERVICE_ID, equipmentId: null, problem: null, date: opts.date, windowId, technicianId: tech?.id ?? null,
    });
    // Only these 3 mean "this window has no room": rule_refused, day_closed and day_past are 409 too, and end the run with their code.
    if (r.status === 409 && !freed && ['window_full', 'technician_no_room', 'time_overlap'].includes(code(r))) {
      tried.push(code(r));
      continue;
    }
    if (r.status !== 201) {
      throw new AddRefused(`the job create answered ${r.status} ${code(r) || JSON.stringify(r.json?.error ?? r.json).slice(0, 160)}${freed ? ` (job ${freed.jobNumber} was ${freed.how}; a re-run creates the job in the freed slot)` : ''}`);
    }
    const jobNumber = r.json.data.job.jobNumber as number;
    if (!tech || !day) {
      log(`add-live-job: job ${jobNumber} for ${CUSTOMER_NAME} on ${opts.date}, window ${label}`);
      return { jobNumber, address, window: label, assignedTo: null, follows: null, freed, already: false };
    }
    const after = await readDay(office, opts.date, tech.id as string);
    const made = after.jobs.find((j) => j.jobNumber === jobNumber);
    if (!made) throw new AddRefused(`job ${jobNumber} is not on the technician's day`);
    if (pair) keptPair(pair, after);
    log(`add-live-job: job ${jobNumber} for ${CUSTOMER_NAME} on ${opts.date}, window ${span(made.window)}, assigned to ${after.name}`);
    return { jobNumber, address, window: span(made.window), assignedTo: after.name, follows: followOf(after, jobNumber), freed, already: false };
  }
  throw new AddRefused(`no window on ${opts.date} took the job for ${opts.assign ?? 'the day'}; the server answered 409 ${tried.join(', ')}`);
}

/** Harold's job and his next job, read again after the writes: the same jobs, at the same versions, still next to each other. */
function keptPair(before: { harold: BoardJob; next: BoardJob }, day: DayRow): void {
  const at = day.jobs.findIndex((j) => j.jobNumber === before.harold.jobNumber);
  const harold = day.jobs[at];
  const next = day.jobs[at + 1];
  if (!harold || harold.version !== before.harold.version || next?.jobNumber !== before.next.jobNumber || next.version !== before.next.version) {
    throw new AddRefused(`${HAROLD}'s job ${before.harold.jobNumber} or its next job ${before.next.jobNumber} changed: session step 3 depends on them`);
  }
}

/** The job before `jobNumber` on the technician's day, in the phone's order. */
function followOf(day: DayRow, jobNumber: number): Added['follows'] {
  const at = day.jobs.findIndex((j) => j.jobNumber === jobNumber);
  const prev = at > 0 ? day.jobs[at - 1] : undefined;
  return prev ? { jobNumber: prev.jobNumber, customerName: prev.customerName, window: span(prev.window) } : null;
}

export function parseArgs(argv: string[]): Options {
  const [server, ...rest] = argv;
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const date = flag('--date');
  const file = flag('--office-password-file');
  const login = flag('--office-login');
  if (!server || server.startsWith('--') || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !login || !file) {
    throw new AddRefused('usage: add-live-job.ts <server address> --date YYYY-MM-DD --office-login <email> --office-password-file <file> [--assign <technician name>]');
  }
  return { server, date, assign: flag('--assign'), officeLogin: login, officePassword: readFileSync(file, 'utf8').trim() };
}

if (isMain(import.meta.url)) {
  try {
    const a = await addLiveJob(parseArgs(process.argv.slice(2)), fetch, (l) => process.stdout.write(`${l}\n`));
    const after = a.follows
      ? `follows job ${a.follows.jobNumber} (${a.follows.customerName}, ${a.follows.window}): open that job, tap Directions`
      : a.assignedTo ? "is the technician's first job of the day: no job leads to it" : 'not assigned';
    const freed = a.freed ? `, freed by ${a.freed.how === 'moved' ? `moving job ${a.freed.jobNumber} (${a.freed.customerName}) to ${a.freed.to}` : `canceling job ${a.freed.jobNumber} (${a.freed.customerName})`}` : '';
    process.stdout.write(`add-live-job: done, job ${a.jobNumber}, ${CUSTOMER_NAME}, ${a.address}, ${a.assignedTo ? `assigned to ${a.assignedTo}` : 'not assigned'}, ${after}${freed}${a.already ? ' (already there)' : ''}\n`);
  } catch (e) {
    const msg = (e as Error).message;
    process.stderr.write(`add-live-job: ${msg}\n`);
    process.exit(msg.startsWith('usage') ? 2 : 1);
  }
}
