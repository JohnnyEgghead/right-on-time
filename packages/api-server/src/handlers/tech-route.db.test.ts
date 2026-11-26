// SPDX-License-Identifier: AGPL-3.0-or-later
// The web technician app's map reads (P5-TWA-MAP-ME: API-100, API-104, API-163) on the real database through the production kernel as bw_web,
// as the seeded technicians with real sessions. Run by the G-CI7 database step with the other api-server database tests.
import { hashPassword } from '@bw/db';
import { approximateDriveMinutes } from '@bw/domain';
import type { dayRoute, techRoute, todayJobs } from '@bw/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { demoAt, techWorld, type TechWorld } from '../tech-items/testing.ts';

const db = useMigratedDatabase();
let w: TechWorld;
/** The first technician (Maria's place in this world) has the day below; the second owns the stranger's job. */
let jobs: number[] = [];
let strangerJob = 0;

type Route = z.output<typeof techRoute.response>;
type Day = z.output<typeof dayRoute.response>;
type MyDay = z.output<typeof todayJobs.response>;

const read = async <T>(r: Response): Promise<T> => {
  if (r.status !== 200) throw new Error(`answered ${r.status}: ${await r.text()}`);
  return ((await r.json()) as { data: T }).data;
};

/** The polyline of Google's reference example (3 points) with 600 s per vertex: a 20 minute, 5 km baked leg. */
const POLYLINE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

beforeAll(async () => {
  w = await techWorld(db);
  const [a] = w.techs;
  // 3 jobs in the day's order: done, scheduled (the next), scheduled. The customers sit at their own points near the depot.
  const done = await w.newJob({ tech: a, status: 'done' });
  const next = await w.newJob({ tech: a });
  const later = await w.newJob({ tech: a });
  jobs = [done, next, later];
  strangerJob = await w.newJob({ tech: w.techs[1] });
  await w.admin().query(`UPDATE world.job SET ended_at = '2026-09-15T12:30:00Z', version = 2 WHERE job_number = $1`, [done]);
  // A baked track depot to the done job, and one from the done job to the next job; the leg from the next job to the later one has none.
  const q = (from: string, to: string, last: number, meters: number) => w.admin().query(
    `INSERT INTO world.van_track (branch_id, from_ref, to_ref, polyline, seconds, distance_m, build_id) VALUES ('columbus', $1, $2, $3, $4, $5, 'test')`,
    [from, to, POLYLINE, `{0,${Math.floor(last / 2)},${last}}`, meters]);
  await q('depot', String(done), 600, 3000);
  await q(String(done), String(next), 1230, 5800);
}, 120_000);
afterAll(async () => {
  await w?.close();
});

describe('API-163 My route', () => {
  // why: FR-TECH-11 the stops are numbered in the day's order, the finished one is done, the first open one is next and the rest later
  it('numbers the stops, marks done, next and later, and names the next stop', async () => {
    const d = await read<Day>(await w.get('/tech/day-route', w.techs[0]));
    expect(d.date).toBe('2026-09-15');
    expect(d.stops.map((s) => [s.number, s.jobNumber, s.state])).toEqual([[1, jobs[0], 'done'], [2, jobs[1], 'next'], [3, jobs[2], 'later']]);
    expect(d.next).toBe(jobs[1]);
    expect(d.stops[1]).toMatchObject({ customer: expect.any(String), address: expect.stringMatching(/^\d+ .+, .+$/), window: { start: expect.stringContaining('08:00'), end: expect.stringContaining('10:00') } });
  });

  // why: FR-TECH-13 the leg into each stop is the baked track's drive minutes (last second / 60, rounded up) and length, or the approximate line with the approximate minutes (SD-22) and no length
  it('takes each leg from its baked track, else the approximate line', async () => {
    const d = await read<Day>(await w.get('/tech/day-route', w.techs[0]));
    const leg = (job: number) => d.legs.find((l) => l.toJob === job)!;
    expect(leg(jobs[0]!)).toMatchObject({ minutes: 10, distanceMeters: 3000 });
    expect(leg(jobs[0]!).track).toHaveLength(3);
    expect(leg(jobs[1]!)).toMatchObject({ minutes: Math.ceil(1230 / 60), distanceMeters: 5800 });
    const approx = leg(jobs[2]!);
    expect(approx.track).toBeNull();
    expect(approx.distanceMeters).toBeNull();
    expect(approx.minutes).toBe(approximateDriveMinutes(approx.from, approx.to));
  });

  // why: FR-TECH-11 a technician-role user with no technician row (the App Reviewer sample user) reads an empty day, not an error
  it('answers an empty day for a technician-role user with no technician row', async () => {
    const token = 'a'.repeat(43);
    // The reviewer is a technician-role user with no technician row: a copy of a technician's user row under another name and email.
    const cols = (await w.rows<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'world' AND table_name = 'user'`)).map((c) => c.column_name);
    const over: Record<string, string> = { id: 'uuidv7()', email: `'reviewer@brightwater.example'`, employee_number: 'NULL', name: `'App Reviewer'`, name_search: `'app reviewer'` };
    await w.admin().query(
      `INSERT INTO world."user" (${cols.map((c) => `"${c}"`).join(', ')}) SELECT ${cols.map((c) => over[c] ?? `"${c}"`).join(', ')} FROM world."user" WHERE id = $1`, [w.techs[1].userId]);
    await w.admin().query(
      `INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
       SELECT sha256(convert_to($1, 'UTF8')), id, 'web', 'password', false, now(), now(), now() + interval '8 hours' FROM world."user" WHERE email = 'reviewer@brightwater.example'`, [token]);
    const reviewer = { userId: '', name: 'App Reviewer', cookie: `bw_session=${token}` };
    const d = await read<Day>(await w.get('/tech/day-route', reviewer));
    expect(d.stops).toEqual([]);
    expect(d.next).toBeNull();
    const day = await read<MyDay>(await w.get('/tech/day', reviewer));
    expect(day.jobs).toEqual([]);
    expect(day.van).toBeNull();
    // F-1018: the reviewer's own name and the branch phone answer (the Me screen shows who is signed in), not a null technician
    expect(day.technician).toEqual(expect.objectContaining({ name: 'App Reviewer', skill: null }));
    expect(day.officePhone).toMatch(/^\(614\)/);
  });
});

describe('API-104 Route', () => {
  // why: FR-TECH-5 the route to the next job starts at the last finished stop and carries its baked track
  it('answers the baked track from the last finished stop to the job', async () => {
    const r = await read<Route>(await w.get(`/tech/route?toJob=${jobs[1]}`, w.techs[0]));
    expect(r.leg.track).toHaveLength(3);
    expect(r.leg.distanceMeters).toBe(5800);
  });

  // why: FR-TECH-13 the Directions button's minutes are the minutes of the route it opens, which are the minutes of the Map tab's leg
  it('shows the same minutes as the Map tab for the same stop', async () => {
    const d = await read<Day>(await w.get('/tech/day-route', w.techs[0]));
    // the next stop from the last finished one; a later stop from the stop before it
    const next = await read<Route>(await w.get(`/tech/route?toJob=${jobs[1]}`, w.techs[0]));
    expect(next.leg.minutes).toBe(d.legs.find((l) => l.toJob === jobs[1])!.minutes);
    const later = await read<Route>(await w.get(`/tech/route?fromJob=${jobs[1]}&toJob=${jobs[2]}`, w.techs[0]));
    expect(later.leg.minutes).toBe(d.legs.find((l) => l.toJob === jobs[2])!.minutes);
  });

  // why: FR-TECH-5 a route from a named job to the one after it, with no baked track, is the straight line labeled approximate (track null)
  it('draws an approximate line where no track is baked, and says whether the technician would be inside the window', async () => {
    const r = await read<Route>(await w.get(`/tech/route?fromJob=${jobs[1]}&toJob=${jobs[2]}`, w.techs[0]));
    expect(r.leg.track).toBeNull();
    expect(r.leg.minutes).toBe(approximateDriveMinutes(r.leg.from, r.leg.to));
    // demo now is 10:00 and the window ends at 10:00: any drive arrives after it
    expect(r.insideWindow).toBe(false);
  });

  // why: FR-AUTH-4 own jobs only: another technician's job, and a job that does not exist, answer 404
  it('refuses a job that is not the caller\'s', async () => {
    expect((await w.get(`/tech/route?toJob=${strangerJob}`, w.techs[0])).status).toBe(404);
    expect((await w.get(`/tech/route?toJob=${jobs[1]}&fromJob=${strangerJob}`, w.techs[0])).status).toBe(404);
    expect((await w.get('/tech/route?toJob=999999999', w.techs[0])).status).toBe(404);
    expect((await w.get(`/tech/route?toJob=${jobs[1]}`, w.keisha)).status).toBe(403);
  });
});

describe('API-163 stops out of window order (F-1005)', () => {
  // why: FR-TECH-11 a stop's state is its status: a job ended after the next stop is done, and the job being worked on is the next stop
  it('marks an ended job done wherever it sits, and names the job on the way as next while an earlier one is still scheduled', async () => {
    const q = (status: string, job: number) => w.admin().query(`UPDATE world.job SET status = $1, version = version + 1 WHERE job_number = $2`, [status, job]);
    try {
      await q('no_one_home', jobs[2]!); // the third stop ended before the second
      let d = await read<Day>(await w.get('/tech/day-route', w.techs[0]));
      expect(d.stops.map((s) => s.state)).toEqual(['done', 'next', 'done']);
      expect(d.next).toBe(jobs[1]!);
      await q('scheduled', jobs[2]!);
      await q('on_the_way', jobs[2]!); // on the way to the third while the second is still scheduled
      d = await read<Day>(await w.get('/tech/day-route', w.techs[0]));
      expect(d.stops.map((s) => s.state)).toEqual(['done', 'later', 'next']);
      expect(d.next).toBe(jobs[2]!);
    } finally {
      await q('scheduled', jobs[2]!);
      await w.admin().query(`UPDATE world.job SET on_the_way_at = NULL WHERE job_number = $1`, [jobs[2]!]);
    }
  });
});

describe('the route from the van while the technician is on the way (F-1003)', () => {
  /** Great-circle meters, written here apart from the product's own, so the length check is not the code checking itself. */
  const meters = (a: [number, number], b: [number, number]): number => {
    const r = Math.PI / 180;
    const h = Math.sin(((b[1] - a[1]) * r) / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2;
    return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  // POLYLINE decodes to these 3 points (lon, lat); the done -> next track has seconds {0, 615, 1230}.
  const V: [number, number][] = [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]];

  // why: FR-TECH-5 with no fromJob the route starts at the van's computed position (API-104): 10 minutes into the 1230 s leg the van is 600/615 along its first segment
  it('starts Directions and the Map tab\'s next leg at the van\'s point on its track, with the time and length left', async () => {
    // demo now is 10:00 AM (14:00Z); the technician tapped On my way to the next job 10 minutes before
    await w.admin().query(`UPDATE world.job SET status = 'on_the_way', on_the_way_at = '2026-09-15T13:50:00Z', version = version + 1 WHERE job_number = $1`, [jobs[1]]);
    try {
      const f = 600 / 615;
      const van: [number, number] = [V[0]![0] + (V[1]![0] - V[0]![0]) * f, V[0]![1] + (V[1]![1] - V[0]![1]) * f];
      const left = Math.round(meters(van, V[1]!) + meters(V[1]!, V[2]!));
      const r = await read<Route>(await w.get(`/tech/route?toJob=${jobs[1]}`, w.techs[0]));
      expect(r.leg.from.lon).toBeCloseTo(van[0], 5);
      expect(r.leg.from.lat).toBeCloseTo(van[1], 5);
      expect(r.leg.track).toHaveLength(3);
      expect(r.leg.track![0]![0]).toBeCloseTo(van[0], 5);
      expect(r.leg.track!.slice(1)).toEqual(V.slice(1));
      expect(r.leg.minutes).toBe(Math.ceil((1230 - 600) / 60));
      expect(r.leg.distanceMeters).toBe(left);
      // the Map tab's leg into the next stop is the same leg (FR-TECH-13: the card's minutes are its Directions button's)
      const d = await read<Day>(await w.get('/tech/day-route', w.techs[0]));
      const { toJob, ...mapLeg } = d.legs.find((l) => l.toJob === jobs[1])!;
      expect(toJob).toBe(jobs[1]);
      expect(mapLeg).toEqual(r.leg);
      // a named fromJob is still the stop-to-stop leg, whatever the van is doing
      const fromStop = await read<Route>(await w.get(`/tech/route?fromJob=${jobs[0]}&toJob=${jobs[1]}`, w.techs[0]));
      expect(fromStop.leg).toMatchObject({ minutes: Math.ceil(1230 / 60), distanceMeters: 5800 });
    } finally {
      await w.admin().query(`UPDATE world.job SET status = 'scheduled', on_the_way_at = NULL, version = version + 1 WHERE job_number = $1`, [jobs[1]]);
    }
  });
});

describe('API-100 My day', () => {
  // why: FR-TECH-15 the Me screen reads the van, the office number and the day's jobs; no start until the technician's first action of the day
  it('answers the van, the office number and the jobs, with no start yet', async () => {
    const d = await read<MyDay>(await w.get('/tech/day', w.techs[1]));
    expect(d.date).toBe('2026-09-15');
    expect(d.van).toEqual(expect.objectContaining({ number: expect.any(String), vehicle: expect.any(String) }));
    expect(d.officePhone).toMatch(/^\(614\)/);
    expect(d.startedAt).toBeNull();
    expect(d.jobs.map((j) => j.jobNumber)).toEqual([strangerJob]);
  });

  // why: FR-TECH-15 the start is the first sign-in of the day by the demo clock, and a later sign-in leaves it
  it('starts the day at the first sign-in and keeps it at the later ones', async () => {
    const [u] = await w.rows<{ email: string }>(`SELECT email::text AS email FROM world."user" WHERE id = $1`, [w.techs[0].userId]);
    await w.admin().query(`UPDATE world."user" SET password_hash = $2 WHERE id = $1`, [w.techs[0].userId, await hashPassword('aaaaaaaaaa')]);
    const starts = async () => w.rows<{ started_at: Date }>('SELECT started_at FROM world.technician_day WHERE technician_id = $1', [w.techs[0].technicianId]);
    const signIn = async (password: string) => (await w.kernel.router.handle(new Request('http://web:3000/api/v1/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:8080' },
      body: JSON.stringify({ login: u!.email, password }),
    }), { address: '203.0.113.9' })).status;
    expect(await starts()).toEqual([]);
    expect(await signIn('wrong-password')).toBe(401);
    expect(await starts()).toEqual([]);
    await w.runningClock(demoAt('07:45'));
    expect(await signIn('aaaaaaaaaa')).toBe(200);
    const first = (await starts())[0]!.started_at.toISOString();
    expect(first).toBe(new Date(demoAt('07:45').epochMilliseconds).toISOString());
    await w.runningClock(demoAt('09:10'));
    expect(await signIn('aaaaaaaaaa')).toBe(200);
    expect((await starts()).map((r) => r.started_at.toISOString())).toEqual([first]);
    await w.runningClock(demoAt('10:00'));
    const d = await read<MyDay>(await w.get('/tech/day', w.techs[0]));
    expect(d.startedAt).toMatch(/^2026-09-15T07:45/);
    // F-1007: a start earlier than the one kept (an offline status item sent late, here a sign-in under an earlier demo time) wins
    await w.runningClock(demoAt('07:30'));
    expect(await signIn('aaaaaaaaaa')).toBe(200);
    expect((await starts()).map((r) => r.started_at.toISOString())).toEqual([new Date(demoAt('07:30').epochMilliseconds).toISOString()]);
  });
});
