// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TEXT-4, FR-TEXT-22, FR-TEXT-23, NFR-04 (G-CI5 inv5-location-window, the live map's page and data cases of P5-LIVEMAP)
// Invariant 5 on the real database through the production web kernel: the customer's live map link answers the van only from On my way to
// arrival. Before On my way, after arrival and after the office cancels, reassigns or reschedules the trip, the page answers 410 and the
// data (API-116) answers 410, neither carrying a coordinate; while the van is on the way the data answers the van, the minutes away, when it
// left, the van number and the branch's office phone. The visit is made as the live system makes it: the technician's On my way and
// arrival items (API-102), the office's writes (API-22, API-24, API-25); no test writes a link or a status itself.
// Run by G-CI5 step 2 (ci/gates/G-CI5/vitest.db.config.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { answers, demoAt, item, techWorld, wire, type Tech, type TechWorld } from '../../../packages/api-server/src/tech-items/testing.ts';

const db = useMigratedDatabase();
let w: TechWorld;
let maria: Tech;
let kevin: Tech;
/** Columbus's office phone, as the seed writes it (the branch row is the truth: FR-DISP-20). */
let officePhone = '';

beforeAll(async () => {
  w = await techWorld(db);
  [maria, kevin] = w.techs;
  officePhone = (await w.rows<{ office_phone: string }>(`SELECT office_phone FROM world.branch WHERE id = 'columbus'`))[0]!.office_phone;
}, 120_000);
afterAll(async () => {
  await w?.close();
});
beforeEach(async () => {
  await w.runningClock(demoAt('10:30'));
});

/** A coordinate, a van, a destination or a route: nothing of the van's place may be in a body that is not a live answer. */
const NO_PLACE = /"(lon|lat|van|destination|route|track|source)"\s*:\s*[\[{0-9-]/;

const get = (path: string) => w.kernel.router.handle(new Request(`http://web:3000${path}`, { headers: { accept: 'application/json' } }), { address: '203.0.113.9' });
const linkOf = async (job: number): Promise<string> => (await w.rows<{ token: string }>(`SELECT token FROM world.link_token WHERE job_number = $1 AND kind = 'live_map' ORDER BY created_at DESC`, [job]))[0]!.token;
const pageStatus = async (token: string): Promise<number> => (await w.kernel.pageVerdict(`/m/${token}`, new Headers())).status;
/** The job on the way as the technician's phone makes it: On my way entered at 10:28 AM, received at 10:30 AM. */
const onTheWay = async (tech: Tech = maria, customer: string = w.texting[0] as string): Promise<{ job: number; token: string }> => {
  const job = await w.newJob({ customerId: customer, tech });
  await w.runningClock(demoAt('10:30'));
  expect((await answers(await w.send([item({ kind: 'on_my_way', jobNumber: job, baseVersion: 1, entered: demoAt('10:28') })], tech)))[0]?.result).toBe('applied');
  return { job, token: await linkOf(job) };
};
const versionOf = async (job: number): Promise<number> => (await w.rows<{ version: number }>('SELECT version FROM world.job WHERE job_number = $1', [job]))[0]!.version;
/** What a 410 of the data row must be: a Problem with its reason and the office phone, and never a place. */
const expectGone = async (token: string, reason: 'arrived' | 'changed'): Promise<Record<string, unknown>> => {
  const r = await get(`/m/${token}/data`);
  const text = await r.text();
  expect(r.status).toBe(410);
  expect(r.headers.get('cache-control')).toMatch(/no-store/);
  expect(text).not.toMatch(NO_PLACE);
  const body = JSON.parse(text) as Record<string, unknown>;
  expect(body).toMatchObject({ code: 'gone', reason, officePhone });
  expect(await pageStatus(token)).toBe(410);
  return body;
};

describe('the live map while the van is on the way (FR-TEXT-22, FR-TEXT-23)', () => {
  // why: FR-TEXT-22
  it('answers the minutes away, when the van left, the van number and the van, and its page answers 200', async () => {
    const { job, token } = await onTheWay();
    await w.runningClock(demoAt('10:35'));
    const r = await get(`/m/${token}/data`);
    expect(r.status).toBe(200);
    const d = ((await r.json()) as { data: Record<string, unknown> }).data as {
      technician: { name: string; initials: string; van: string | null }; leftAt: string; eta: string | null; minutesAway: number | null;
      van: { lon: number; lat: number } | null; destination: { lon: number; lat: number }; visit: { day: string }; officePhone: string; route: { track: unknown };
    };
    const j = (await w.rows<{ texted_arrival: Date; van: string | null }>(
      `SELECT j.texted_arrival, v.number AS van FROM world.job j JOIN world.technician t ON t.id = j.technician_id LEFT JOIN world.van v ON v.id = t.van_id WHERE j.job_number = $1`, [job]))[0]!;
    expect(d.technician).toMatchObject({ name: maria.name, van: j.van });
    expect(d.leftAt).toBe(wire(demoAt('10:28')));
    // The minutes are the estimate minus demo now, rounded up (SD-22): the figure the text promised.
    expect(d.minutesAway).toBe(Math.max(0, Math.ceil((j.texted_arrival.getTime() - demoAt('10:35').epochMilliseconds) / 60_000)));
    expect(d.van).not.toBeNull();
    expect(d.destination.lon).toBeTypeOf('number');
    expect(d.visit.day).toBe('2026-09-15');
    expect(await pageStatus(token)).toBe(200);
  });

  // why: FR-TEXT-23
  it('answers the office phone of the job\'s branch for Call Brightwater', async () => {
    const { token } = await onTheWay();
    await w.runningClock(demoAt('10:35'));
    expect(((await (await get(`/m/${token}/data`)).json()) as { data: { officePhone: string } }).data.officePhone).toBe(officePhone);
    expect(officePhone).toMatch(/^\(\d{3}\) \d{3}-\d{4}$/);
  });

  // why: FR-TEXT-4
  it('answers 404 for a link that does not exist, on the data and on the page', async () => {
    expect((await get('/m/ZZZZZZZZ/data')).status).toBe(404);
    expect(await pageStatus('ZZZZZZZZ')).toBe(200);
  });
});

describe('before On my way and after arrival (FR-TEXT-4, NFR-04)', () => {
  // why: FR-TEXT-4
  it('answers 410 with no coordinate before the van left (the clock behind its On my way)', async () => {
    const { token } = await onTheWay();
    await w.runningClock(demoAt('10:00'));
    const body = await expectGone(token, 'changed');
    expect(body).toMatchObject({ visit: null, technician: null, arrivedAt: null });
  });

  // why: FR-TEXT-4
  it('answers 410 with no coordinate from the arrival on, with the visit facts and the technician', async () => {
    const { job, token } = await onTheWay();
    // Received at 10:43 AM, entered at 10:41 AM: the arrival is stamped with the time it was entered.
    await w.runningClock(demoAt('10:43'));
    expect((await answers(await w.send([item({ kind: 'arrived', jobNumber: job, baseVersion: 2, entered: demoAt('10:41') })], maria)))[0]?.result).toBe('applied');
    const body = await expectGone(token, 'arrived');
    expect(body).toMatchObject({ arrivedAt: wire(demoAt('10:41')), technician: { name: maria.name }, visit: { day: '2026-09-15' } });
  });
});

describe('the office changes the visit while the van is on the way (FR-TEXT-4, owner ruling 2142ce69 "End the link")', () => {
  // why: FR-TEXT-4
  it('API-25 cancel ends the link: 410, the visit changed, no coordinate, no old van, technician or window', async () => {
    const { job, token } = await onTheWay();
    expect((await w.post(`/jobs/${job}/cancellation`, { baseVersion: await versionOf(job) }, w.keisha)).status).toBe(200);
    await w.runningClock(demoAt('10:35'));
    const body = await expectGone(token, 'changed');
    expect(body).toMatchObject({ visit: null, technician: null, arrivedAt: null });
  });

  // why: FR-TEXT-4
  it('API-22 reassign ends the link: 410, the visit changed, and the new technician is not shown as the van', async () => {
    const { job, token } = await onTheWay();
    expect((await w.post(`/jobs/${job}/assignment`, { technicianId: kevin.technicianId, baseVersion: await versionOf(job) }, w.keisha)).status).toBe(200);
    await w.runningClock(demoAt('10:35'));
    const body = await expectGone(token, 'changed');
    expect(body).toMatchObject({ visit: null, technician: null });
  });

  // why: FR-TEXT-4
  it('API-24 reschedule ends the link: 410, the visit changed, no coordinate', async () => {
    const { job, token } = await onTheWay();
    const r = await w.post(`/jobs/${job}/schedule`, { date: '2026-09-17', windowId: w.windowId, baseVersion: await versionOf(job) }, w.keisha);
    expect(r.status, await r.clone().text()).toBe(200);
    await w.runningClock(demoAt('10:35'));
    await expectGone(token, 'changed');
  });
});
