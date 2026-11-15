// SPDX-License-Identifier: AGPL-3.0-or-later
// API-100 Today's jobs (P5-TWA-TODAY) on the real database through the production kernel, as the technicians of the reference seed
// with real sessions (the tech-items test world). Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TodayAnswer } from '@bw/api';
import { createPool } from '@bw/db';
import { realNow } from '@bw/time';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { sessionCookie, SqlSessionStore, startSession } from '../kernel/sessions.ts';
import { loginUrl, ORIGIN } from '../office-writes/testing.ts';
import { demoAt, techWorld, type Tech, type TechWorld } from '../tech-items/testing.ts';

const db = useMigratedDatabase();
let w: TechWorld;
let maria: Tech;
let kevin: Tech;

const today = async (who: Tech): Promise<TodayAnswer> => {
  const r = await w.get('/tech/day', who);
  if (r.status !== 200) throw new Error(`answered ${r.status}: ${await r.text()}`);
  return ((await r.json()) as { data: TodayAnswer }).data;
};

beforeAll(async () => {
  w = await techWorld(db);
  [maria, kevin] = w.techs;
}, 120_000);
afterAll(async () => {
  await w?.close();
});

describe('API-100 Today', () => {
  // why: FR-TECH-1
  it('lists the technician\'s jobs for demo today in window order, numbered, with the day\'s date', async () => {
    await w.runningClock(demoAt('07:45'));
    const late = await w.newJob({ tech: maria });
    await w.admin().query(`UPDATE world.job SET window_start = '2026-09-15T14:00:00-04:00', window_end = '2026-09-15T16:00:00-04:00' WHERE job_number = $1`, [late]);
    const early = await w.newJob({ tech: maria });
    const tomorrow = await w.newJob({ tech: maria, date: '2026-09-16' });
    const d = await today(maria);
    expect(d.date).toBe('2026-09-15');
    const mine = d.jobs.filter((j) => [late, early, tomorrow].includes(j.jobNumber));
    expect(mine.map((j) => j.jobNumber)).toEqual([early, late]);
    expect(d.jobs.map((j) => j.position)).toEqual(d.jobs.map((_, i) => i + 1));
    expect(d.jobs.every((j) => j.status === 'scheduled')).toBe(true);
  });

  // why: FR-TECH-12
  it('answers the van number', async () => {
    const [row] = await w.rows<{ number: string }>('SELECT v.number FROM world.technician t JOIN world.van v ON v.id = t.van_id WHERE t.id = $1', [maria.technicianId]);
    expect((await today(maria)).van?.number).toBe(row!.number);
  });

  // why: FR-AUTH-4
  it('includes the customer\'s phone for a job of demo today', async () => {
    const n = await w.newJob({ tech: kevin, customerId: w.texting[0] as string });
    const j = (await today(kevin)).jobs.find((x) => x.jobNumber === n);
    expect(j?.customer.phone).toBe('(614) 555-0110');
  });

  // why: FR-TECH-2
  it('answers the on-the-way text as Send would make it, in the customer\'s language, and stores and sends nothing', async () => {
    const n = await w.newJob({ tech: maria, customerId: w.texting[1] as string });
    const before = (await w.rows<{ n: string }>('SELECT count(*)::text AS n FROM world.outbox_text'))[0]!.n;
    const tokens = (await w.rows<{ n: string }>('SELECT count(*)::text AS n FROM world.link_token'))[0]!.n;
    const j = (await today(maria)).jobs.find((x) => x.jobNumber === n);
    expect(j?.onMyWayPreview?.language).toBe('en');
    expect(j?.onMyWayPreview?.text).toContain(`${maria.nameInTexts} is on the way! Arriving about `);
    expect(j?.onMyWayPreview?.text).toContain('bw.j7l.io/m/...');
    expect((await w.rows<{ n: string }>('SELECT count(*)::text AS n FROM world.outbox_text'))[0]!.n).toBe(before);
    expect((await w.rows<{ n: string }>('SELECT count(*)::text AS n FROM world.link_token'))[0]!.n).toBe(tokens);
    await w.admin().query(`UPDATE world.customer SET text_language = 'es' WHERE id = $1`, [w.texting[1]]);
    const es = (await today(maria)).jobs.find((x) => x.jobNumber === n);
    expect(es?.onMyWayPreview?.language).toBe('es');
    expect(es?.onMyWayPreview?.text).toContain('Brightwater:');
  });

  // why: FR-TECH-1 (the late text the server sent shows on the card, FR-TEXT-5)
  it('reports the late text: when it went, the new time and the time it measured against', async () => {
    const n = await w.newJob({ tech: maria });
    await w.admin().query(
      `UPDATE world.job SET texted_arrival = '2026-09-15T13:05:00-04:00', late_text_sent_at = '2026-09-15T12:52:00-04:00', late_text_was_arrival = '2026-09-15T12:40:00-04:00' WHERE job_number = $1`, [n]);
    const j = (await today(maria)).jobs.find((x) => x.jobNumber === n);
    expect(j?.lateText).toMatchObject({ sentAt: expect.stringContaining('12:52'), eta: expect.stringContaining('13:05'), wasEta: expect.stringContaining('12:40') });
  });

  /** Room for a reassigned job in the new technician's window, whatever the cases before left there (F-1046: no case depends on file order). */
  const makeRoom = () => w.admin().query(`UPDATE world.job SET status = 'canceled' WHERE technician_id = $1 AND date = '2026-09-15' AND status <> 'canceled'`, [kevin.technicianId]);

  // why: FR-TEXT-4 (owner ruling d0c0a033, Nov 2, 2026, "Back to Scheduled"; F-566; moved from P4-JOB, F-703)
  it('reads a job the office reassigned from On the way as Scheduled in the new technician\'s list, and drops it from the old one', async () => {
    await makeRoom(); // F-1046: the case passes in any order, shuffled included
    const n = await w.newJob({ tech: maria, status: 'on_the_way' });
    expect((await today(maria)).jobs.find((x) => x.jobNumber === n)?.status).toBe('on_the_way');
    const version = (await w.rows<{ version: number }>('SELECT version FROM world.job WHERE job_number = $1', [n]))[0]!.version;
    const r = await w.post(`/jobs/${n}/assignment`, { technicianId: kevin.technicianId, baseVersion: version }, w.keisha);
    expect(r.status).toBe(200);
    expect((await today(kevin)).jobs.find((x) => x.jobNumber === n)?.status).toBe('scheduled');
    expect((await today(maria)).jobs.find((x) => x.jobNumber === n)).toBeUndefined();
  });

  // why: FR-TEXT-4 (SPECIFICATIONS job.status: assignJob on an on_the_way or on_site job sets it back to scheduled for the new technician; owner ruling d0c0a033; F-1020 d)
  it('reads a job the office reassigned from On site as Scheduled in the new technician\'s list, and drops it from the old one', async () => {
    await makeRoom(); // F-1046
    const n = await w.newJob({ tech: maria, status: 'on_site' });
    expect((await today(maria)).jobs.find((x) => x.jobNumber === n)?.status).toBe('on_site');
    const version = (await w.rows<{ version: number }>('SELECT version FROM world.job WHERE job_number = $1', [n]))[0]!.version;
    const r = await w.post(`/jobs/${n}/assignment`, { technicianId: kevin.technicianId, baseVersion: version }, w.keisha);
    expect(r.status).toBe(200);
    expect((await today(kevin)).jobs.find((x) => x.jobNumber === n)?.status).toBe('scheduled');
    expect((await today(maria)).jobs.find((x) => x.jobNumber === n)).toBeUndefined();
  });

  // why: FR-TECH-1 (F-252 item 7, F-278: the reviewer sample user has no technician row; Today answers an empty day, not an error)
  it('answers an empty day for the reviewer sample user, a technician-role user with no technician row', async () => {
    const a = w.admin();
    const u = (await a.query<{ id: string }>(
      `INSERT INTO world."user" (email, name, name_search, password_hash, role, branch_id, language, status, sample, reviewer)
       VALUES ('reviewer@brightwater.example', 'App Reviewer', 'app reviewer', NULL, 'technician', 'columbus', 'en', 'active', false, true) RETURNING id`)).rows[0]!;
    const pool = createPool({ connectionString: loginUrl(db.url(), 'bw_web'), max: 1 });
    const token = await startSession(new SqlSessionStore(pool), { realNow: () => realNow('session_lifetime') }, { userId: u.id, role: 'technician' }, { client: 'web', via: 'password', keepSignedIn: false });
    await pool.end();
    const cookie = sessionCookie(token, false, false).split(';')[0] as string;
    const reviewer = { ...maria, userId: u.id, cookie, auth: { cookie, origin: ORIGIN } };
    const d = await today(reviewer);
    expect(d.jobs).toEqual([]);
    expect(d.van).toBeNull();
  });

  // why: FR-TECH-1
  it('refuses a signed-out caller and an office user', async () => {
    const r = await w.kernel.router.handle(new Request('http://web:3000/api/v1/tech/day', { headers: { origin: ORIGIN } }), { address: '203.0.113.9' });
    expect(r.status).toBe(401);
    expect((await w.get('/tech/day', w.keisha)).status).toBe(403);
  });
});
