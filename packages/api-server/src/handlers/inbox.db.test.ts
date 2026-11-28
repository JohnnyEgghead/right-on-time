// SPDX-License-Identifier: AGPL-3.0-or-later
// The customer's text inbox (API-120, API-121) and Change your visit time (API-117, API-118) through the production kernel (P5-INBOX;
// FR-TEXT-8, FR-TEXT-14, FR-TEXT-18, FR-TEXT-21 by link path, F-421, F-799, F-808, F-829), over the real handlers, the real catalogs and
// real PostgreSQL 18 as the web login. Run by gate G-CI7 (ci/gates/G-CI7/vitest.db.config.ts); the merge set excludes *.db.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@bw/config';
import { createPool, inTransaction } from '@bw/db';
import { createLogger } from '@bw/log';
import { sendConfirmation } from '@bw/outbox';
import { Temporal } from '@bw/time';
import { catalogs } from '../../../i18n/src/catalog.ts';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { addCustomer, addJob, seedOutboxWorld, type OutboxRef } from '../../../outbox/src/testing/world.ts';
import { createWebKernel, type WebKernel } from '../web.ts';
import { inboxTokenChecks, rescheduleLinkEnded } from './inbox.ts';

const db = useMigratedDatabase();
const NOW = '2026-09-15T14:00:00Z'; // Tue, Sep 15, 10:00 AM EDT
const ORIGIN = 'http://localhost:8080';
const loginUrl = (url: string, login: string) => {
  const u = new URL(url);
  u.username = login;
  return u.toString();
};

let kernel: WebKernel;
let web: ReturnType<typeof createPool>;
let ref: OutboxRef;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { data: Record<string, any>; code?: string };

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await kernel.router.handle(new Request(`http://web:3000${path}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(method === 'GET' ? {} : { origin: ORIGIN }) },
  }), { address: '203.0.113.9' });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : { data: {} }) as Reply };
}
const inbox = (customer: Customer, extra = '') => call('GET', `/api/v1/inbox/${customer.token}/messages${extra}`);
const reply = (customer: Customer, body: string) => call('POST', `/api/v1/inbox/${customer.token}/replies`, { body });

interface Customer { id: string; token: string }
async function customer(over: Parameters<typeof addCustomer>[2] = {}): Promise<Customer> {
  const id = await addCustomer(db.admin(), ref, over);
  const token = (await db.admin().query<{ inbox_token: string }>('SELECT inbox_token FROM world.customer WHERE id = $1', [id])).rows[0]!.inbox_token;
  return { id, token };
}
const textsOf = (customerId: string, kind: string) =>
  db.admin().query<{ id: string; status: string; reason_key: string | null; body: string }>(
    `SELECT id, status, reason_key, body FROM world.outbox_text WHERE customer_id = $1 AND kind = $2 ORDER BY created_at, id`, [customerId, kind]).then((r) => r.rows);
const tokenOf = async (job: number) => (await db.admin().query<{ token: string; ended_at: Date | null }>(
  `SELECT token, ended_at FROM world.link_token WHERE job_number = $1 AND kind = 'reschedule' ORDER BY created_at DESC, token LIMIT 1`, [job])).rows[0]!;

beforeAll(async () => {
  const a = db.admin();
  ref = await seedOutboxWorld(a, NOW);
  // The fixture service's text label joins the real catalog's keys (as the triggers' own db test does).
  await a.query(`UPDATE world.service_type SET text_label_key = 'service.furnace_tune_up.text', screen_label_key = 'service.furnace_tune_up.screen'`);
  web = createPool({ connectionString: loginUrl(db.url(), 'bw_web'), max: 4 });
  kernel = createWebKernel({
    settings: loadConfig({
      DATABASE_URL: loginUrl(db.url(), 'bw_web'), ACCESS_CODE_ON: 'off', PBS_URL: 'http://127.0.0.1:9', BACKUP_TARGET: 'lightsail',
      DATA_LOCATION_APP: 'AWS Lightsail, US East (Virginia)', DATA_LOCATION_BACKUPS: 'AWS Lightsail object storage, US East (Virginia)',
    }),
    log: createLogger({ process: 'web', write: () => undefined }),
  });
});

afterAll(async () => {
  await kernel?.close();
  await web?.end();
});

describe('the inbox thread (API-120, FR-TEXT-14, FR-TEXT-18)', () => {
  // why: FR-TEXT-14
  it('answers the customer, every sent text and reply in time order, and refreshes with only what is newer than `after`', async () => {
    const c = await customer({ name: 'Harold Jenkins' });
    const job = await addJob(db.admin(), ref, c.id, '2026-09-16');
    await db.admin().query(
      `INSERT INTO world.inbox_message (customer_id, direction, body, at, job_number) VALUES ($1, 'out', 'Brightwater: first', '2026-09-14T23:42:00Z', $2)`, [c.id, job]);
    const r1 = await inbox(c);
    expect(r1.status).toBe(200);
    expect(r1.json.data['customer']).toEqual({ name: 'Harold Jenkins', firstName: 'Harold', officePhone: '(614) 555-0100', hasMobile: true, textsOn: true, language: 'en', today: '2026-09-15' });
    expect(r1.json.data['messages']).toHaveLength(1);
    expect(r1.json.data['messages'][0]).toMatchObject({ direction: 'out', body: 'Brightwater: first', links: [], liveMapPreview: null, handling: null });
    expect(r1.json.data['messages'][0].sentAt).toMatch(/^2026-09-14T19:42/);
    const after = r1.json.data['messages'][0].id as string;
    expect((await reply(c, 'hello there')).status).toBe(201);
    const r2 = await inbox(c, `?after=${after}`);
    expect(r2.json.data['messages']).toHaveLength(1);
    expect(r2.json.data['messages'][0]).toMatchObject({ direction: 'in', body: 'hello there', handling: 'not_understood' });
  });

  // why: FR-TEXT-14
  it('2 customers sharing 1 sample mobile number each see only their own texts and replies', async () => {
    const ann = await customer({ name: 'Ann Share', mobile: '(614) 555-0188' });
    const bob = await customer({ name: 'Bob Share', mobile: '(614) 555-0188' });
    const distinct = (await db.admin().query<{ n: string }>(
      'SELECT count(DISTINCT mobile) AS n FROM world.customer WHERE id = ANY($1::uuid[])', [[ann.id, bob.id]])).rows[0]!.n;
    expect(Number(distinct)).toBe(1);
    await db.admin().query(
      `INSERT INTO world.inbox_message (customer_id, direction, body, at) VALUES ($1, 'out', 'Brightwater: for Ann', $3), ($2, 'out', 'Brightwater: for Bob', $3)`,
      [ann.id, bob.id, NOW]);
    expect((await reply(ann, 'hello from Ann')).status).toBe(201);
    const bodies = async (c: Customer) => ((await inbox(c)).json.data['messages'] as { body: string }[]).map((m) => m.body);
    expect(await bodies(ann)).toEqual(['Brightwater: for Ann', 'hello from Ann']);
    expect(await bodies(bob)).toEqual(['Brightwater: for Bob']);
  });

  // why: FR-TEXT-14
  it('answers a token that does not exist with not_found', async () => {
    expect((await call('GET', '/api/v1/inbox/no-such-token-0000/messages')).status).toBe(404);
    expect((await call('POST', '/api/v1/inbox/no-such-token-0000/replies', { body: 'C' })).status).toBe(404);
  });

  // why: FR-TEXT-18
  it('lists the live map and reschedule links of a text as paths on this server, with a preview path for the live map', async () => {
    const c = await customer();
    await db.admin().query(
      `INSERT INTO world.inbox_message (customer_id, direction, body, at) VALUES
         ($1, 'out', 'Brightwater: Maria is on the way! Follow the van: bw.j7l.io/m/7Hk2Ab9Q (this link stops working when Maria arrives).', '2026-09-15T14:00:00Z'),
         ($1, 'out', 'Brightwater: No problem. Pick a new time: bw.j7l.io/r/9Tm4Xy2Z or call (614) 555-0100.', '2026-09-15T14:01:00Z')`, [c.id]);
    const m = (await inbox(c)).json.data['messages'];
    expect(m[0].links).toEqual([{ kind: 'live_map', path: '/m/7Hk2Ab9Q', text: 'bw.j7l.io/m/7Hk2Ab9Q' }]);
    expect(m[0].liveMapPreview).toBe('/m/7Hk2Ab9Q/preview');
    expect(m[1].links).toEqual([{ kind: 'reschedule', path: '/r/9Tm4Xy2Z', text: 'bw.j7l.io/r/9Tm4Xy2Z' }]);
    expect(m[1].liveMapPreview).toBeNull();
  });
});

describe('replies (API-121, FR-TEXT-8, SD-46)', () => {
  // why: FR-TEXT-8
  it('C confirms the visit; R queues the R-reply with a reschedule link and the office phone; other text is listed for the office', async () => {
    const c = await customer();
    const job = await addJob(db.admin(), ref, c.id, '2026-09-16');
    const rc = await reply(c, ' c ');
    expect(rc).toMatchObject({ status: 201, json: { data: { handling: 'confirmed' } } });
    expect((await db.admin().query('SELECT confirmed_at FROM world.job WHERE job_number = $1', [job])).rows[0]!.confirmed_at).not.toBeNull();
    const rr = await reply(c, 'R');
    expect(rr.json.data['handling']).toBe('reschedule_sent');
    const t = await tokenOf(job);
    const [text] = await textsOf(c.id, 'r_reply');
    expect(text!.body).toContain(`bw.j7l.io/r/${t.token}`);
    expect(text!.body).toContain('(614) 555-0100');
    const other = await reply(c, 'what time exactly?');
    expect(other.json.data['handling']).toBe('not_understood');
    expect(await textsOf(c.id, 'r_reply')).toHaveLength(1);
  });

  // why: FR-TEXT-13
  it('refuses a reply from a customer with no mobile phone or with texts off, as the page has no reply controls', async () => {
    const noMobile = await customer({ mobile: null });
    const off = await customer({ textsOn: false });
    expect((await reply(noMobile, 'C')).json.code).toBe('no_mobile');
    expect((await reply(off, 'C')).json.code).toBe('texts_off');
  });
});

describe('Change your visit time (API-117, API-118, FR-TEXT-8, SD-45)', () => {
  async function visit(over: Parameters<typeof customer>[0] = {}, date = '2026-09-16') {
    const c = await customer(over);
    const job = await addJob(db.admin(), ref, c.id, date);
    expect((await reply(c, 'R')).json.data['handling']).toBe('reschedule_sent');
    return { c, job, token: (await tokenOf(job)).token };
  }
  const windowId = () => ref.windowId;

  // why: FR-TEXT-8
  it('shows the current visit and the days the online rules offer: none today (5 PM cutoff), none on Sunday, 21 days at most', async () => {
    const v = await visit();
    const r = await call('GET', `/r/${v.token}/data`);
    expect(r.status).toBe(200);
    expect(r.json.data['visit']).toMatchObject({ serviceLabelKey: 'service.furnace_tune_up.screen', day: '2026-09-16' });
    expect(r.json.data['officePhone']).toBe('(614) 555-0100');
    const days = r.json.data['days'] as { date: string; mode: string; state: string; windows: { windowId: string; state: string }[] }[];
    expect(days[0]!.date).toBe('2026-09-16'); // 10:00 AM Tuesday: tomorrow is still open (it closes at 5:00 PM today)
    expect(days.some((d) => d.date === '2026-09-15')).toBe(false);
    expect(days.some((d) => d.date === '2026-09-20')).toBe(false); // a Sunday
    expect(days.some((d) => d.date === '2026-09-19')).toBe(false); // a Saturday no technician works (the fixture technician works Mon to Fri)
    expect(days.at(-1)!.date <= '2026-10-06').toBe(true);
    expect(days[0]!.windows).toEqual([expect.objectContaining({ windowId: windowId(), state: 'open' })]);
  });

  // why: FR-TEXT-8
  it('moves the visit, ends the link, sends the new confirmation and cancels a held one with text_reason.visit_changed (F-799, F-829)', async () => {
    const v = await visit();
    // A confirmation still held from the booking (made at 12:30 AM, quiet hours) names the old day.
    const held = await inTransaction(web, (tx) => sendConfirmation(tx, { catalogs, linkHost: 'bw.j7l.io' }, { jobNumber: v.job, now: Temporal.Instant.from('2026-09-15T04:30:00Z') }));
    expect(held).toMatchObject({ ok: true, status: 'held' });
    const r = await call('POST', `/r/${v.token}`, { date: '2026-09-17', windowId: windowId() });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ visit: { day: '2026-09-17' }, outcome: { textSent: true } });
    const job = (await db.admin().query('SELECT date::text AS date FROM world.job WHERE job_number = $1', [v.job])).rows[0];
    expect(job!.date).toBe('2026-09-17');
    const confirmations = await textsOf(v.c.id, 'confirmation');
    expect(confirmations.filter((t) => t.status === 'canceled').map((t) => t.reason_key)).toEqual(['text_reason.visit_changed']);
    expect(confirmations.filter((t) => ['queued', 'held', 'retrying'].includes(t.status))).toHaveLength(1);
    const change = (await db.admin().query('SELECT actor_kind, actor_user_id, kind FROM world.job_change WHERE job_number = $1 AND kind = $2', [v.job, 'rescheduled'])).rows;
    expect(change).toEqual([{ actor_kind: 'customer', actor_user_id: null, kind: 'rescheduled' }]);
    // The link is used: it answers gone, and a second move changes nothing.
    expect((await call('GET', `/r/${v.token}/data`)).status).toBe(410);
    const again = await call('POST', `/r/${v.token}`, { date: '2026-09-18', windowId: windowId() });
    expect(again.status).toBe(410);
    expect((await db.admin().query('SELECT date::text AS date FROM world.job WHERE job_number = $1', [v.job])).rows[0]!.date).toBe('2026-09-17');
  });

  // why: F-970 (FR-TEXT-8) 2 moves on 1 link at once: one moves the visit, the other answers gone, never a 500
  it('answers gone, not a server error, to the second of 2 moves on 1 link made at once', async () => {
    const v = await visit();
    const answers = await Promise.all([
      call('POST', `/r/${v.token}`, { date: '2026-09-17', windowId: windowId() }),
      call('POST', `/r/${v.token}`, { date: '2026-09-18', windowId: windowId() }),
    ]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 410]);
    expect((await db.admin().query('SELECT version FROM world.job WHERE job_number = $1', [v.job])).rows[0]!.version).toBe(2);
  });

  // why: FR-TEXT-8
  it('answers gone for a link whose visit is Canceled or No one home, and for an expired one (Done has its own rule test)', async () => {
    for (const status of ['canceled', 'no_one_home']) {
      const v = await visit();
      await db.admin().query('UPDATE world.job SET status = $2 WHERE job_number = $1', [v.job, status]);
      expect((await call('GET', `/r/${v.token}/data`)).status).toBe(410);
      expect((await call('POST', `/r/${v.token}`, { date: '2026-09-17', windowId: windowId() })).status).toBe(410);
      expect((await db.admin().query('SELECT date::text AS date FROM world.job WHERE job_number = $1', [v.job])).rows[0]!.date).toBe('2026-09-16');
    }
    const v = await visit();
    await db.admin().query(`UPDATE world.link_token SET expires_at = '2026-09-15T13:00:00Z' WHERE token = $1`, [v.token]);
    expect((await call('GET', `/r/${v.token}/data`)).status).toBe(410);
  });

  // why: K-07 F-2013 a live map link is a link token of another kind, and the reschedule page must not open or move a visit on it
  it('answers not found to a live map link token on the reschedule page and on the move', async () => {
    const v = await visit();
    await db.admin().query(`UPDATE world.link_token SET kind = 'live_map' WHERE token = $1`, [v.token]);
    expect((await call('GET', `/r/${v.token}/data`)).status).toBe(404);
    expect((await call('POST', `/r/${v.token}`, { date: '2026-09-17', windowId: windowId() })).status).toBe(404);
    expect((await db.admin().query('SELECT date::text AS date FROM world.job WHERE job_number = $1', [v.job])).rows[0]!.date).toBe('2026-09-16');
  });

  // why: K-07 F-2013 the kernel's reschedule token check passes a reschedule token only; the handler's own kind filter is a second guard, so the check is tried by itself
  it('passes a reschedule link token and no other kind at the kernel token check', async () => {
    const v = await visit();
    expect(await inboxTokenChecks.reschedule(v.token, db.admin())).toBe(true);
    await db.admin().query(`UPDATE world.link_token SET kind = 'live_map' WHERE token = $1`, [v.token]);
    expect(await inboxTokenChecks.reschedule(v.token, db.admin())).toBe(false);
  });

  // why: FR-TEXT-8
  it('refuses a day the online rules do not offer (past the 5 PM cutoff, a Sunday) with booking_closed and moves nothing', async () => {
    const v = await visit({}, '2026-09-17');
    const sunday = await call('POST', `/r/${v.token}`, { date: '2026-09-20', windowId: windowId() });
    expect(sunday).toMatchObject({ status: 409, json: { code: 'booking_closed' } });
    const far = await call('POST', `/r/${v.token}`, { date: '2026-11-30', windowId: windowId() });
    expect(far.json.code).toBe('booking_closed');
    expect((await db.admin().query('SELECT date::text AS date FROM world.job WHERE job_number = $1', [v.job])).rows[0]!.date).toBe('2026-09-17');
    expect((await call('GET', `/r/${v.token}/data`)).status).toBe(200); // the link is still open
  });

  // why: FR-TEXT-8
  it('refuses a full window with window_full and shows it Full', async () => {
    const v = await visit();
    // Fill Thursday's only window (capacity 12) with other customers' live jobs.
    for (let i = 0; i < 12; i++) await addJob(db.admin(), ref, (await customer()).id, '2026-09-17');
    const days = (await call('GET', `/r/${v.token}/data`)).json.data['days'] as { date: string; state: string; windows: { state: string }[] }[];
    expect(days.find((d) => d.date === '2026-09-17')).toMatchObject({ state: 'full', windows: [{ state: 'full' }] });
    const r = await call('POST', `/r/${v.token}`, { date: '2026-09-17', windowId: windowId() });
    expect(r).toMatchObject({ status: 409, json: { code: 'window_full' } });
  });

  // why: FR-TEXT-8
  it('ends a link the office moved past (an office reschedule through API-24 ends the visit\'s open reschedule links, F-808)', async () => {
    const v = await visit();
    // The office's own move, the write API-24 makes (rescheduleJob), ends the old R-reply link in its transaction.
    const { rescheduleJob } = await import('../office-writes/service.ts');
    const version = (await db.admin().query('SELECT version FROM world.job WHERE job_number = $1', [v.job])).rows[0]!.version as number;
    await inTransaction(web, (tx) => rescheduleJob(tx, { actor: { kind: 'office', userId: ref.userId }, at: new Date(NOW) }, { jobNumber: v.job, date: '2026-09-18', windowId: windowId(), baseVersion: version }));
    expect((await call('GET', `/r/${v.token}/data`)).status).toBe(410);
    expect((await tokenOf(v.job)).ended_at).not.toBeNull();
  });
});

describe('the link-ended rule of the reschedule page (OA-62)', () => {
  const now = Temporal.Instant.from(NOW);
  const open = { token_ended: null, token_expires: new Date('2026-09-22T14:00:00Z'), status: 'scheduled' };
  // why: FR-TEXT-8
  it('ends a link that was used or expired, or whose visit is Done, No one home or Canceled, and keeps any other open', () => {
    expect(rescheduleLinkEnded(open, now)).toBe(false);
    expect(rescheduleLinkEnded({ ...open, status: 'on_the_way' }, now)).toBe(false);
    expect(rescheduleLinkEnded({ ...open, token_ended: new Date(NOW) }, now)).toBe(true);
    expect(rescheduleLinkEnded({ ...open, token_expires: new Date(NOW) }, now)).toBe(true);
    for (const status of ['done', 'no_one_home', 'canceled']) expect(rescheduleLinkEnded({ ...open, status }, now)).toBe(true);
  });
});
