// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-8, FR-DISP-2, FR-MAP-3, FR-TECH-5 (P6-TESTFLIGHT-4: the script that adds the 1 job whose leg is routed live to the staging copy's demo day through the office channel, freeing 1 slot of Maria Santos's full day first; offline, with a stubbed fetch)
// The script's own calls are checked against a stub of the server: no address is opened, nothing is created. F-1348: the stub's Maria
// day is the seeded one (the generator fixture, seed 20260915: 5 jobs on Sep 15, the two_hour day's capacity 5), and the stub answers
// API-28 and API-22 with technician_no_room by the server's own room rule (SD-27: live jobs that day under the capacity and live jobs
// in the window under 2), so a script that assumes room the world does not have fails here as it would on the copy.
import { describe, expect, it } from 'vitest';
import { addLiveJob, AddRefused, checkServer, CUSTOMER_NAME, HAROLD, HOUSE_NUMBER, parseArgs, type FetchFn } from '../deploy/staging/add-live-job.ts';

interface Call { method: string; url: string; body: any; cookie: string | undefined } // eslint-disable-line @typescript-eslint/no-explicit-any
interface Job { jobNumber: number; version: number; customerName: string; serviceId: string; windowId: string; tech: string | null; canceled: boolean }

const SERVER = 'https://203-0-113-9.sslip.io';
const OFFICE = { officeLogin: 'o@example.test', officePassword: 'p'.repeat(12) };
const MARIA = { officeLogin: OFFICE.officeLogin, officePassword: OFFICE.officePassword, server: SERVER, date: '2026-09-15', assign: 'Maria Santos' };
const CAPACITY = 5;
const WINDOWS = ['08', '10', '12', '14', '16'].map((h) => ({
  windowId: `w-${h}`, start: `2026-09-15T${h}:00:00-04:00[America/New_York]`, end: `2026-09-15T${String(Number(h) + 2).padStart(2, '0')}:00:00-04:00[America/New_York]`,
}));
const TECHS = [
  { id: 't-maria', name: 'Maria Santos' },
  { id: 't-dave', name: 'Dave Kowalski' },
  { id: 't-ryan', name: 'Ryan Mitchell' },
  { id: 't-greg', name: 'Greg Hoffman' },
];
/** Maria Santos's seeded Sep 15 (fixture demoWeekJobs; .build/evidence/W36-NATIVE-STEPS/run4/steps-setup.txt): full at 5. */
const SEEDED_MARIA: [number, string, string, string][] = [
  [24825, 'Diego Vargas', 'ac_tune_up', 'w-08'],
  [24830, HAROLD, 'furnace_tune_up', 'w-10'],
  [24828, 'Linda Miller', 'ac_tune_up', 'w-12'],
  [24839, 'Paula Morgan', 'plumbing_repair', 'w-14'],
  [24845, 'Philip Bui', 'boiler_repair', 'w-16'],
];
/** Dave Kowalski's seeded 3 (room at 4 PM); Ryan Mitchell's seeded 4 (room at 4 PM). */
const SEEDED_OTHERS: [number, string, string, string, string][] = [
  [24804, 'C1', 'furnace_tune_up', 'w-08', 't-dave'], [24813, 'C2', 'boiler_repair', 'w-10', 't-dave'], [24833, 'C3', 'ac_tune_up', 'w-14', 't-dave'],
  [24812, 'C4', 'boiler_repair', 'w-08', 't-ryan'], [24814, 'C5', 'furnace_tune_up', 'w-10', 't-ryan'], [24823, 'C6', 'thermostat', 'w-12', 't-ryan'], [24834, 'C7', 'heating_or_ac_fix', 'w-14', 't-ryan'],
];

interface World { jobs: Job[]; customers: { id: string; name: string }[]; nextJob: number }
function seededWorld(maria: [number, string, string, string][] = SEEDED_MARIA): World {
  return {
    jobs: [
      ...maria.map(([jobNumber, customerName, serviceId, windowId]) => ({ jobNumber, version: 3, customerName, serviceId, windowId, tech: 't-maria', canceled: false })),
      ...SEEDED_OTHERS.map(([jobNumber, customerName, serviceId, windowId, tech]) => ({ jobNumber, version: 2, customerName, serviceId, windowId, tech, canceled: false })),
    ],
    customers: [],
    nextJob: 25001,
  };
}

interface StubOpts {
  /** API-30's answer, in its rank order: id, room, reason (skill_missing). Default: Dave and Ryan with room and the skill, Greg skill_missing, Maria (room with the job left out). */
  ranked?: { id: string; room: boolean; reason: string | null }[];
  /** Technicians whose API-22 answers 409 technician_no_room whatever the count (the server's own check decides). */
  refuseAssign?: string[];
  /** API-29 windows; default every window open. */
  open?: boolean;
  /** Windows whose API-28 answers 409 window_full. */
  fullWindows?: string[];
  /** API-31's status when not 200 (a 403 or 500 read). */
  techListStatus?: number;
  /** API-28 answers 409 with this code for every window. */
  createRefusal?: string;
}

/** A stub of the server over a small world: it applies the writes, so a read after a write sees them. */
function stub(world: World, calls: Call[], opts: StubOpts = {}): FetchFn {
  const live = (tech: string) => world.jobs.filter((j) => j.tech === tech && !j.canceled);
  const hasRoom = (tech: string, windowId: string, exclude = -1) => {
    const mine = live(tech).filter((j) => j.jobNumber !== exclude);
    return mine.length < CAPACITY && mine.filter((j) => j.windowId === windowId).length < 2;
  };
  const reply = (status: number, data: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json', ...headers } });
  const problem = (status: number, code: string) => new Response(JSON.stringify({ code, status }), { status });
  const win = (id: string) => WINDOWS.find((w) => w.windowId === id)!;
  const boardJob = (j: Job) => ({ jobNumber: j.jobNumber, version: j.version, customerName: j.customerName, serviceId: j.serviceId, windowId: j.windowId, window: { start: win(j.windowId).start, end: win(j.windowId).end } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body, cookie: (init?.headers as Record<string, string> | undefined)?.cookie });
    const path = url.slice(`${SERVER}/api/v1`.length);
    if (path === '/sessions') return new Response('{}', { status: 200, headers: { 'set-cookie': 'bw_session=OFFICE; Path=/; HttpOnly' } });
    if (path.startsWith('/technicians?')) return opts.techListStatus ? problem(opts.techListStatus, 'forbidden') : reply(200, { technicians: TECHS });
    if (path === '/public/street-searches') return reply(200, { streets: [{ streetId: `s-${body.query}`, name: `${body.query} Street`, city: 'Columbus', zip: '43215', branch: 'columbus' }] });
    if (path === '/customer-searches') {
      return reply(200, { customers: world.customers.filter((c) => c.name === body.query).map((c) => ({ ...c, address: { houseNumber: 1, street: 'Broad Street', city: 'Columbus', zip: '43215' } })) });
    }
    if (path === '/customers' && method === 'POST') {
      world.customers.push({ id: 'c-new', name: body.name });
      return reply(201, { id: 'c-new', name: body.name });
    }
    if (path.startsWith('/board?')) {
      return reply(200, { technicians: TECHS.map((t) => ({ id: t.id, name: t.name, capacity: CAPACITY, jobs: live(t.id).map(boardJob) })) });
    }
    if (path.startsWith('/technicians/room?')) {
      const ranked = opts.ranked ?? [
        { id: 't-dave', room: true, reason: null }, { id: 't-ryan', room: true, reason: null }, { id: 't-maria', room: true, reason: null }, { id: 't-greg', room: true, reason: 'skill_missing' },
      ];
      return reply(200, { serviceSkill: 'heating_cooling', technicians: ranked.map((r) => ({ ...r, name: TECHS.find((t) => t.id === r.id)!.name })) });
    }
    if (path.startsWith('/availability?')) {
      return reply(200, { days: [{ date: '2026-09-15', windows: opts.open === false ? [] : WINDOWS.map((w) => ({ ...w, state: 'open', left: 3 })) }] });
    }
    const assign = /^\/jobs\/(\d+)\/assignment$/.exec(path);
    if (assign && method === 'POST') {
      const j = world.jobs.find((x) => x.jobNumber === Number(assign[1]))!;
      if (body.baseVersion !== j.version) return problem(409, 'version_conflict');
      if (opts.refuseAssign?.includes(body.technicianId) || !hasRoom(body.technicianId, j.windowId, j.jobNumber)) return problem(409, 'technician_no_room');
      j.tech = body.technicianId;
      j.version += 1;
      return reply(200, { job: { jobNumber: j.jobNumber, version: j.version } });
    }
    const cancel = /^\/jobs\/(\d+)\/cancellation$/.exec(path);
    if (cancel && method === 'POST') {
      const j = world.jobs.find((x) => x.jobNumber === Number(cancel[1]))!;
      if (body.baseVersion !== j.version) return problem(409, 'version_conflict');
      j.canceled = true;
      j.version += 1;
      return reply(200, { job: { jobNumber: j.jobNumber, version: j.version } });
    }
    if (path === '/jobs' && method === 'POST') {
      if (opts.createRefusal) return problem(409, opts.createRefusal);
      if (opts.fullWindows?.includes(body.windowId)) return problem(409, 'window_full');
      if (body.technicianId !== null && !hasRoom(body.technicianId, body.windowId)) return problem(409, 'technician_no_room');
      const jobNumber = world.nextJob++;
      world.jobs.push({ jobNumber, version: 1, customerName: CUSTOMER_NAME, serviceId: body.serviceId, windowId: body.windowId, tech: body.technicianId, canceled: false });
      return reply(201, { job: { jobNumber }, confirmationText: null });
    }
    return reply(404, null);
  }) as FetchFn;
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET' && !/\/(sessions|public\/street-searches|customer-searches)$/.test(c.url));
const job = (w: World, n: number) => w.jobs.find((j) => j.jobNumber === n)!;

describe('add-live-job (P6-TESTFLIGHT-4)', () => {
  // why: FR-DISP-2 F-1348 the seeded day is full: her last job goes to the first technician API-30 ranks with room and the skill, then the new job takes the freed window
  it('on the seeded full day moves Philip Bui\'s 24845 to Dave Kowalski, then creates the job for Maria in the 4 PM window after Paula Morgan', async () => {
    const world = seededWorld();
    const calls: Call[] = [];
    const lines: string[] = [];
    const out = await addLiveJob(MARIA, stub(world, calls), (l) => lines.push(l));
    expect(out).toMatchObject({
      jobNumber: 25001, address: '1 Broad Street', assignedTo: 'Maria Santos', already: false,
      follows: { jobNumber: 24839, customerName: 'Paula Morgan' },
      freed: { jobNumber: 24845, customerName: 'Philip Bui', how: 'moved', to: 'Dave Kowalski' },
    });
    expect(job(world, 24845).tech).toBe('t-dave');
    expect(job(world, 25001)).toMatchObject({ tech: 't-maria', windowId: 'w-16' });
    expect(writes(calls).map((c) => `${c.method} ${c.url.split('/api/v1')[1]}`)).toEqual(['POST /customers', 'POST /jobs/24845/assignment', 'POST /jobs']);
    expect(calls.find((c) => c.url.endsWith('/jobs/24845/assignment'))!.body).toEqual({ technicianId: 't-dave', baseVersion: 3 });
    const create = calls.find((c) => c.url.endsWith('/jobs') && c.method === 'POST')!;
    expect(create.body).toEqual({ customerId: 'c-new', serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: '2026-09-15', windowId: 'w-16', technicianId: 't-maria' });
    expect(create.cookie).toBe('bw_session=OFFICE');
    expect(lines).toContain('add-live-job: freed 1 slot: moved job 24845 (Philip Bui, 2026-09-15T16:00:00-04:00[America/New_York] to 2026-09-15T18:00:00-04:00[America/New_York]) from Maria Santos to Dave Kowalski');
    expect(calls.every((c) => c.url.startsWith(`${SERVER}/api/v1/`))).toBe(true);
    expect(calls.some((c) => c.url.includes('/public/bookings'))).toBe(false);
  });

  // why: FR-TECH-5 F-1348 step 3 opens Harold's job and drives to the job after it: neither is written, and the job after Harold's stays Linda Miller's
  it('leaves Harold Jenkins\'s job and the job after it unchanged', async () => {
    const world = seededWorld();
    const calls: Call[] = [];
    await addLiveJob(MARIA, stub(world, calls), () => {});
    expect(writes(calls).some((c) => /\/jobs\/(24830|24828)\//.test(c.url))).toBe(false);
    expect([job(world, 24830), job(world, 24828)].map((j) => [j.tech, j.version, j.canceled])).toEqual([['t-maria', 3, false], ['t-maria', 3, false]]);
    const order = world.jobs.filter((j) => j.tech === 't-maria' && !j.canceled).sort((a, b) => a.windowId.localeCompare(b.windowId) || a.jobNumber - b.jobNumber).map((j) => j.jobNumber);
    expect(order[order.indexOf(24830) + 1]).toBe(24828);
  });

  // why: FR-DISP-2 the server's own room check decides each move: a technician refused with technician_no_room is passed over for the next, Maria and a technician without the skill never
  it('passes over a technician the assign refuses, and never offers the job to Maria or to one without the skill', async () => {
    const world = seededWorld();
    const calls: Call[] = [];
    const out = await addLiveJob(MARIA, stub(world, calls, { refuseAssign: ['t-dave'] }), () => {});
    expect(out.freed).toMatchObject({ how: 'moved', to: 'Ryan Mitchell' });
    expect(calls.filter((c) => c.url.endsWith('/assignment')).map((c) => c.body.technicianId)).toEqual(['t-dave', 't-ryan']);
  });

  // why: FR-DISP-6 with no technician who has room the last job is canceled through the office's cancel, and the job takes its window
  it('cancels the last job when no technician has room for it', async () => {
    const world = seededWorld();
    const calls: Call[] = [];
    const out = await addLiveJob(MARIA, stub(world, calls, { ranked: [{ id: 't-maria', room: true, reason: null }, { id: 't-greg', room: true, reason: 'skill_missing' }, { id: 't-ryan', room: false, reason: null }] }), () => {});
    expect(out.freed).toMatchObject({ jobNumber: 24845, how: 'canceled', to: null });
    expect(writes(calls).map((c) => c.url.split('/api/v1')[1])).toEqual(['/customers', '/jobs/24845/cancellation', '/jobs']);
    expect(job(world, 24845).canceled).toBe(true);
    expect(job(world, 25001).windowId).toBe('w-16');
  });

  // why: FR-TECH-5 F-1348 the job freed is never Harold's next job: a full day that ends with it is refused before any job write
  it('refuses a full day whose last job is the one after Harold\'s', async () => {
    const world = seededWorld(SEEDED_MARIA.slice(0, 3));
    world.jobs.push(...[24901, 24902].map((n) => ({ jobNumber: n, version: 1, customerName: 'Early', serviceId: 'thermostat', windowId: 'w-08', tech: 't-maria', canceled: false })));
    const calls: Call[] = [];
    await expect(addLiveJob(MARIA, stub(world, calls), () => {})).rejects.toThrow(/no job to free/);
    expect(writes(calls).filter((c) => c.url.includes('/jobs'))).toHaveLength(0);
  });

  // why: FR-DISP-8 a re-run after a done run writes nothing and answers the job already there
  it('writes nothing on a re-run once the job is on the day', async () => {
    const world = seededWorld();
    await addLiveJob(MARIA, stub(world, []), () => {});
    const calls: Call[] = [];
    const again = await addLiveJob(MARIA, stub(world, calls), () => {});
    expect(again).toMatchObject({ jobNumber: 25001, already: true, freed: null, follows: { jobNumber: 24839 } });
    expect(writes(calls)).toHaveLength(0);
    expect(job(world, 24839).tech).toBe('t-maria');
  });

  // why: FR-DISP-8 a re-run after a run that freed the slot but made no job finds the room, moves nothing more, and reuses the customer
  it('creates the job without moving another when a run freed the slot and stopped', async () => {
    const world = seededWorld();
    job(world, 24845).tech = 't-dave';
    world.customers.push({ id: 'c-new', name: CUSTOMER_NAME });
    const calls: Call[] = [];
    const out = await addLiveJob(MARIA, stub(world, calls), () => {});
    expect(out).toMatchObject({ jobNumber: 25001, freed: null, follows: { jobNumber: 24839, customerName: 'Paula Morgan' } });
    expect(writes(calls).map((c) => c.url.split('/api/v1')[1])).toEqual(['/jobs']);
    expect(calls.find((c) => c.url.endsWith('/jobs'))!.body.windowId).toBe('w-16');
  });

  // why: FR-DISP-8 with room on the day, a window the technician has no room in is skipped for the next
  it('tries the next window when one answers 409', async () => {
    const world = seededWorld(SEEDED_MARIA.slice(1, 3)); // Harold's 24830 and Linda's 24828, then 2 of hers in the 4 PM window: 4 of 5
    world.jobs.push(...[24903, 24904].map((n) => ({ jobNumber: n, version: 1, customerName: 'Late', serviceId: 'thermostat', windowId: 'w-16', tech: 't-maria', canceled: false })));
    const calls: Call[] = [];
    const out = await addLiveJob(MARIA, stub(world, calls), () => {});
    expect(calls.filter((c) => c.url.endsWith('/jobs') && c.method === 'POST').map((c) => c.body.windowId)).toEqual(['w-16', 'w-14']);
    expect(out).toMatchObject({ freed: null, follows: { jobNumber: 24828, customerName: 'Linda Miller' } });
  });

  // why: F-1353 a refused read is named by its status, not reported as a technician who does not exist
  it('names the status when the technician list read is refused', async () => {
    await expect(addLiveJob(MARIA, stub(seededWorld(), [], { techListStatus: 403 }), () => {})).rejects.toThrow(/the technician list answered 403/);
  });

  // why: F-1353 day_closed, day_past and rule_refused are 409 too: they end the run with their code instead of trying the next window
  it.each(['day_closed', 'day_past', 'rule_refused'])('stops on a %s 409 and prints its code', async (refusal) => {
    const world = seededWorld(SEEDED_MARIA.slice(1, 3));
    const calls: Call[] = [];
    await expect(addLiveJob(MARIA, stub(world, calls, { createRefusal: refusal }), () => {})).rejects.toThrow(new RegExp(`409 ${refusal}`));
    expect(calls.filter((c) => c.url.endsWith('/jobs') && c.method === 'POST')).toHaveLength(1);
  });

  // why: F-1353 when every window is full the end line carries the codes the server sent
  it('prints the codes of the 409s it passed over when no window took the job', async () => {
    const world = seededWorld(SEEDED_MARIA.slice(1, 3));
    await expect(addLiveJob(MARIA, stub(world, [], { createRefusal: 'window_full' }), () => {})).rejects.toThrow(/409 window_full, window_full/);
  });

  // why: FR-TECH-5 a window before Harold's next job would put the new job between Harold's and his next: never tried
  it('never tries a window before the job after Harold\'s', async () => {
    const world = seededWorld(SEEDED_MARIA.slice(1, 3));
    world.jobs.push(...[24903, 24904].map((n) => ({ jobNumber: n, version: 1, customerName: 'Late', serviceId: 'thermostat', windowId: 'w-16', tech: 't-maria', canceled: false })));
    const calls: Call[] = [];
    await expect(addLiveJob(MARIA, stub(world, calls, { fullWindows: ['w-14', 'w-12'] }), () => {})).rejects.toThrow(/no window on 2026-09-15 took the job/);
    expect(calls.filter((c) => c.url.endsWith('/jobs') && c.method === 'POST').map((c) => c.body.windowId)).toEqual(['w-16', 'w-14', 'w-12']);
  });

  // why: NFR-05 the office password is only in the sign-in body
  it('sends the office password only in the sign-in body', async () => {
    const calls: Call[] = [];
    await addLiveJob(MARIA, stub(seededWorld(), calls), () => {});
    expect(calls.filter((c) => JSON.stringify(c.body ?? '').includes('p'.repeat(12))).map((c) => c.url.split('/api/v1')[1])).toEqual(['/sessions']);
  });

  // why: FR-DISP-8 with no window with room on the day nothing is created, and it says so
  it('creates no job when no window has room', async () => {
    const calls: Call[] = [];
    await expect(addLiveJob({ server: SERVER, date: '2026-09-15', ...OFFICE }, stub(seededWorld(), calls, { open: false }), () => {})).rejects.toThrow(/no window with room/);
    expect(calls.some((c) => c.url.endsWith('/jobs') && c.method === 'POST')).toBe(false);
  });

  // why: NFR-09 the hosted server stays locked: its address, a plain-http address and a missing office sign-in are refused before any call
  it('refuses the hosted server, a plain http address and a missing office sign-in', async () => {
    const calls: Call[] = [];
    await expect(addLiveJob({ server: 'https://bw.j7l.io', date: '2026-09-15', ...OFFICE }, stub(seededWorld(), calls))).rejects.toBeInstanceOf(AddRefused);
    await expect(addLiveJob({ server: SERVER, date: '2026-09-15' }, stub(seededWorld(), calls))).rejects.toThrow(/office sign-in/);
    expect(() => checkServer('http://203.0.113.9')).toThrow(/https/);
    expect(calls).toHaveLength(0);
  });

  // why: FR-DISP-8 the arguments need a server, a date, and the office sign-in
  it('refuses arguments with no date or no office sign-in', () => {
    expect(() => parseArgs([SERVER])).toThrow(/usage/);
    expect(() => parseArgs([SERVER, '--date', '2026-09-15'])).toThrow(/usage/);
  });

  // why: FR-DISP-8 the customer is made once, at house number 1 of the first Columbus street found
  it('makes the customer at house number 1 of the first Columbus street', async () => {
    const calls: Call[] = [];
    await addLiveJob(MARIA, stub(seededWorld(), calls), () => {});
    expect(calls.find((c) => c.url.endsWith('/customers'))!.body).toMatchObject({ name: CUSTOMER_NAME, houseNumber: HOUSE_NUMBER, streetId: 's-Broad' });
  });
});
