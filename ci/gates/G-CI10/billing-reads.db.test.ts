// SPDX-License-Identifier: AGPL-3.0-or-later
// The billing reads through the production kernel (P4-BILLING-UI; SPECIFICATIONS section 6.6 FR-BILL-2, FR-BILL-4, FR-BILL-5,
// FR-BILL-10, FR-BILL-11, FR-BILL-12, UC-20): API-60 Billing queue, API-159 Billing list export, API-65 Pretend billing invoices,
// API-66 Pretend billing invoice and API-67 Pretend billing mode, each called over the real handlers as a signed-in office user (the web
// process's login bw_web, the real session layer), on real PostgreSQL 18 with pbs over real HTTP as bw_pbs and the billing link as
// bw_worker. Run by gate G-CI10 (vitest.db.config.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../packages/config/src/index.ts';
import { createPool } from '../../../packages/db/src/client.ts';
import { createLogger } from '../../../packages/log/src/index.ts';
import { sessionCookie, SqlSessionStore, startSession } from '../../../packages/api-server/src/kernel/sessions.ts';
import { createWebKernel, type WebKernel } from '../../../packages/api-server/src/web.ts';
import { realNow, Temporal, type RealTimeUse } from '../../../packages/time/src/index.ts';
import { DEMO_START, useBillingWorld } from '../../../apps/worker/src/billing/testing.ts';

const w = useBillingWorld({ holdMs: 600, timeoutMs: 200 });
const at = (m: number) => Temporal.Instant.from(DEMO_START).add({ minutes: m }).toString();
const ORIGIN = 'http://localhost:8080';
/** The kernel reads the demo clock through a 250 ms cache (CLOCK_CACHE_MS): a test that moves the clock waits that out before it reads. */
const settle = () => new Promise((r) => setTimeout(r, 300));

let kernel: WebKernel;
let web: ReturnType<typeof createPool>;
let office: { id: string; cookie: string };

const loginUrl = (url: string, login: string) => {
  const u = new URL(url);
  u.username = login;
  return u.toString();
};

beforeAll(async () => {
  const a = w.admin();
  web = createPool({ connectionString: loginUrl(w.url(), 'bw_web'), max: 4 });
  kernel = createWebKernel({
    settings: loadConfig({ DATABASE_URL: loginUrl(w.url(), 'bw_web'), ACCESS_CODE_ON: 'off', PBS_URL: w.pbsUrl() }),
    log: createLogger({ process: 'web', write: () => undefined }),
  });
  const store = new SqlSessionStore(web);
  const clock = { realNow: (use: RealTimeUse) => realNow(use === 'session_idle' ? 'session_idle' : 'session_lifetime') };
  const id = (await a.query<{ id: string }>(
    `INSERT INTO world."user" (email, name, name_search, role, branch_id, language, status, sample, reviewer)
     VALUES ('keisha.reads@example.test', 'Keisha Thompson', 'keisha thompson', 'office', 'columbus', 'en', 'active', false, false) RETURNING id`)).rows[0]!.id;
  const cookie = sessionCookie(await startSession(store, clock, { userId: id, role: 'office' }, { client: 'web', via: 'password', keepSignedIn: false }), false, false).split(';')[0] as string;
  office = { id, cookie };
});

afterAll(async () => {
  await kernel?.close();
  await web?.end();
});

/** An answer read as loosely as the kernel's JSON: the tests assert the fields they care about. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { data: Record<string, any>; code?: string };

async function get(path: string, cookie: string | null = office.cookie) {
  await settle();
  const res = await kernel.router.handle(new Request(`http://web:3000/api/v1${path}`, {
    method: 'GET', headers: { ...(cookie ? { cookie } : {}) },
  }), { address: '203.0.113.9' });
  // A byte order mark is part of the file (SPECIFICATIONS 7.5): read the bytes, so a decoder does not drop it.
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
  return { status: res.status, text, disposition: res.headers.get('content-disposition'), json: (() => { try { return JSON.parse(text) as Reply; } catch { return { data: {} } as Reply; } })() };
}

async function post(path: string, body: unknown) {
  const res = await kernel.router.handle(new Request(`http://web:3000/api/v1${path}`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: office.cookie },
  }), { address: '203.0.113.9' });
  return { status: res.status, json: (await res.json()) as Reply };
}

const queue = async () => (await get('/billing/queue?branch=columbus')).json.data;

/** A Mark fixed reason no catalog value holds (F-591): a page or export that prints a catalog literal cannot show it by chance. */
const TYPED = 'Paid by phone, entered by hand';

/** The export's rows as cells (RFC 4180: a quoted cell may hold commas and doubled quotes), after the byte order mark. */
function rowsOf(csv: string): string[][] {
  const out: string[][] = [];
  for (const line of csv.replace(/^\uFEFF/, '').split('\r\n').slice(1)) {
    if (line === '') continue;
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i]!;
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (c === '"') quoted = false; else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { cells.push(cur); cur = ''; } else cur += c;
    }
    cells.push(cur);
    out.push(cells);
  }
  return out;
}

type Left = { jobNumber: number; how: string; tries: number; by: string | null; markedReason: string | null; reason: string | null; at: string };
const leftOf = (q: Reply['data'], job: number): Left | undefined => (q.leftLast7Days as Left[]).find((l) => l.jobNumber === job);
const counts = async () => { const l = (await queue()).link; return [l.finishedToday, l.inBillingToday]; };

describe('Billing queue (API-60)', () => {
  // why: FR-BILL-2
  it('lists a finished job while billing is Down, until billing is Up and the retry succeeds', async () => {
    await w.setDemo(at(10));
    await w.setMode('down');
    const job = await w.newJob();
    await w.admin().query('UPDATE world.job SET technician_id = (SELECT id FROM world.technician LIMIT 1) WHERE job_number = $1', [job]);
    await w.finish(job, { noPartsUsed: true });
    await w.link().runDue();
    const down = await queue();
    expect(down.link.mode).toBe('down');
    expect(down.items.map((i: { jobNumber: number }) => i.jobNumber)).toContain(job);
    const row = down.items.find((i: { jobNumber: number }) => i.jobNumber === job);
    expect(row).toMatchObject({ state: 'retrying', reasonKind: 'down', tries: 1, customer: 'Ann Lee', technician: 'Maria Santos' });
    expect(row.nextTry).not.toBeNull();
    // Billing comes back; the retry falls due and succeeds.
    await w.setMode('up');
    await w.setDemo(at(40));
    await w.link().runDue();
    const up = await queue();
    expect(up.link.mode).toBe('up');
    expect(up.items.map((i: { jobNumber: number }) => i.jobNumber)).not.toContain(job);
    expect(up.leftLast7Days.find((l: { jobNumber: number }) => l.jobNumber === job)).toMatchObject({ how: 'automatic_retry', tries: 2 });
    expect(up.link.lastSentAt).not.toBeNull();
  });

  // why: FR-AUTH-1, FR-BILL-2
  it('refuses a request with no session', async () => {
    expect((await get('/billing/queue?branch=columbus', null)).status).toBe(401);
  });

  // why: FR-BILL-11, FR-BILL-12, UC-20
  it('shows a job marked fixed in the 7-day table with who, when and the reason, and the export carries it', async () => {
    await w.setDemo(at(100));
    await w.setMode('reject_next_n', 1);
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    await w.link().runDue();
    const waiting = (await queue()).items.find((i: { jobNumber: number }) => i.jobNumber === job);
    expect(waiting).toMatchObject({ state: 'waiting_person', reasonKind: 'data_error' });
    expect(typeof waiting.reason).toBe('string');

    // F-591: a reason no catalog value holds, so the table and the export can only show it by reading what was typed.
    expect((await post(`/billing/queue/${job}/fixed`, { reason: TYPED })).status).toBe(200);
    const after = await queue();
    expect(after.items.map((i: { jobNumber: number }) => i.jobNumber)).not.toContain(job);
    expect(after.leftLast7Days.find((l: { jobNumber: number }) => l.jobNumber === job)).toMatchObject({
      how: 'marked_fixed', by: 'Keisha Thompson', markedReason: TYPED,
    });

    // why: FR-BILL-12
    const csv = await get('/billing/queue/export?branch=columbus&lang=en');
    expect(csv.status).toBe(200);
    expect(csv.text.startsWith('﻿Job,Customer,Technician,Done at,Status,Reason,Tries,Last try,Next try,How it reached billing,Who,When,Reason given\r\n')).toBe(true);
    // The page's words (F-591): the chip, the reason it was listed, and the typed reason with the person, then the full name and the reason.
    const row = rowsOf(csv.text).find((r) => r[0] === String(job));
    expect(row).toEqual([String(job), '', '', '', 'Marked fixed', waiting.reason, '1', '', '', `${TYPED}, Keisha T.`, 'Keisha Thompson', expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/), TYPED]);
    const es = await get('/billing/queue/export?branch=columbus&lang=es');
    expect(es.text.startsWith('﻿Trabajo,Cliente,')).toBe(true);
    // F-599: the file is named <kind>-<branch>-<yyyy-mm-dd>.csv by the server (SPECIFICATIONS 7.5), not by the page.
    expect(csv.disposition).toMatch(/^attachment; filename="billing-columbus-\d{4}-\d{2}-\d{2}\.csv"$/);
  });
});

describe('the billing link card counts (API-60 finishedToday, inBillingToday; F-592)', () => {
  // why: FR-BILL-2, F-592 finishedToday counts the branch's jobs Done on demo today in the branch zone and inBillingToday those of them
  // whose billing_state is in_billing or marked_fixed: a No one home visit is not finished, a job finished yesterday and sent today is not
  // one of today's, and a job marked fixed today is in billing (UI-SPECIFICATION 12.4)
  it('counts the jobs Done today and those of them that reached billing', async () => {
    // Yesterday (Wed, Sep 16, 4 PM in Columbus): a job finishes while billing is Down, so it is sent only today.
    await w.setDemo('2026-09-16T20:00:00Z');
    await w.setMode('down');
    const yesterday = await w.newJob();
    await w.finish(yesterday, { noPartsUsed: true });
    await w.link().runDue();
    // Today (Thu, Sep 17, 10 AM): billing is Up and yesterday's retry succeeds.
    await w.setDemo('2026-09-17T14:00:00Z');
    await w.setMode('up');
    await w.link().runDue();
    expect(leftOf(await queue(), yesterday)).toMatchObject({ how: 'automatic_retry' });
    expect(await counts(), 'a job finished yesterday and sent today').toEqual([0, 0]);

    const sent = await w.newJob();
    await w.finish(sent, { noPartsUsed: true });
    await w.link().runDue();
    expect(await counts(), 'a job finished and sent today').toEqual([1, 1]);

    const nobody = await w.newJob();
    await w.finish(nobody, { status: 'no_one_home' });
    await w.link().runDue();
    expect(await counts(), 'a No one home visit today').toEqual([1, 1]);

    await w.setMode('reject_next_n', 1);
    const fixed = await w.newJob();
    await w.finish(fixed, { noPartsUsed: true });
    await w.link().runDue();
    expect(await counts(), 'a job held for a person').toEqual([2, 1]);
    expect((await post(`/billing/queue/${fixed}/fixed`, { reason: TYPED })).status).toBe(200);
    expect(await counts(), 'a job marked fixed today').toEqual([2, 2]);

    await w.setMode('down');
    const retrying = await w.newJob();
    await w.finish(retrying, { noPartsUsed: true });
    await w.link().runDue();
    expect(await counts(), 'a job retrying').toEqual([3, 2]);
    await w.setMode('up');
  });
});

describe('the Fixed in the last 7 days table (API-60 leftLast7Days, API-159)', () => {
  // why: FR-BILL-12, F-596 after an automatic retry success, a Send again, a correction and a Mark fixed, the table has 1 row each that
  // names the try number or the person, the export's rows say the same words, and a row older than 7 days by the demo clock is gone
  it('shows each way a job left the list with the try number or the person, and drops a row 7 demo days old', async () => {
    const t0 = Temporal.Instant.from('2026-09-20T14:00:00Z');
    await w.setDemo(t0.toString());
    // An automatic retry: Down, then Up 15 minutes later, and the retry succeeds on try 2.
    await w.setMode('down');
    const retried = await w.newJob();
    await w.finish(retried, { noPartsUsed: true });
    await w.link().runDue();
    await w.setMode('up');
    await w.setDemo(t0.add({ minutes: 20 }).toString());
    await w.link().runDue();
    // Send again (API-61) and a correction (API-62): each first held for a person by a refused invoice.
    const held = async () => {
      await w.setMode('reject_next_n', 1);
      const job = await w.newJob();
      await w.finish(job, { noPartsUsed: true });
      await w.link().runDue();
      await w.setMode('up');
      return job;
    };
    const resent = await held();
    expect((await post(`/billing/queue/${resent}/resend`, {})).status).toBe(202);
    await w.link().runDue();
    const corrected = await held();
    const { version } = (await w.rows<{ version: number }>('SELECT version FROM world.job WHERE job_number = $1', [corrected]))[0]!;
    expect((await post(`/billing/queue/${corrected}/correction`, { parts: [], noPartsUsed: true, laborMinutes: 45, baseVersion: version })).status).toBe(202);
    await w.link().runDue();
    const marked = await held();
    expect((await post(`/billing/queue/${marked}/fixed`, { reason: TYPED })).status).toBe(200);

    const q = await queue();
    expect(leftOf(q, retried)).toMatchObject({ how: 'automatic_retry', tries: 2, by: null });
    expect(leftOf(q, resent)).toMatchObject({ how: 'sent_again', tries: 2, by: 'Keisha Thompson' });
    expect(leftOf(q, corrected)).toMatchObject({ how: 'corrected', tries: 2, by: 'Keisha Thompson' });
    expect(leftOf(q, marked)).toMatchObject({ how: 'marked_fixed', tries: 1, by: 'Keisha Thompson', markedReason: TYPED });

    // The export says each row in the page's words: the chip, the reason, and how it reached billing with the try number or the person.
    const csv = rowsOf((await get('/billing/queue/export?branch=columbus&lang=en')).text);
    const cells = (job: number) => { const r = csv.find((c) => c[0] === String(job)); return r && [r[4], r[5], r[9], r[10]]; };
    expect(cells(retried)).toEqual(['Sent', 'Was down', 'Automatic retry, try 2', '']);
    expect(cells(resent)).toEqual(['Sent', leftOf(q, resent)!.reason, 'Sent again by Keisha T.', 'Keisha Thompson']);
    expect(cells(corrected)).toEqual(['Sent', leftOf(q, corrected)!.reason, 'Corrected and sent again by Keisha T.', 'Keisha Thompson']);
    expect(cells(marked)).toEqual(['Marked fixed', leftOf(q, marked)!.reason, `${TYPED}, Keisha T.`, 'Keisha Thompson']);
    const es = rowsOf((await get('/billing/queue/export?branch=columbus&lang=es')).text);
    expect(es.find((c) => c[0] === String(resent))?.[9]).toBe('Enviado de nuevo por Keisha T.');
    expect(es.find((c) => c[0] === String(marked))?.[9]).toBe(`${TYPED}, marcado por Keisha T.`);

    // 7 demo days: a minute before the 7th day ends the automatic retry's row is there; a minute after, it is gone, from the table and the export.
    const leftAt = Temporal.Instant.from(Temporal.ZonedDateTime.from(leftOf(q, retried)!.at).toInstant());
    await w.setDemo(leftAt.add({ hours: 7 * 24 }).subtract({ minutes: 1 }).toString());
    expect(leftOf(await queue(), retried)).toBeDefined();
    await w.setDemo(leftAt.add({ hours: 7 * 24 }).add({ minutes: 1 }).toString());
    expect(leftOf(await queue(), retried)).toBeUndefined();
    expect(rowsOf((await get('/billing/queue/export?branch=columbus&lang=en')).text).some((c) => c[0] === String(retried))).toBe(false);
  });
});

describe('Pretend billing reads (API-65, API-66, API-67)', () => {
  // why: FR-BILL-4, F-593
  it('lists the invoices billing received, newest first, and opens one with its lines and total', async () => {
    await w.setDemo(at(200));
    await w.setMode('up');
    const job = await w.newJob({ member: true });
    await w.admin().query('UPDATE world.job SET technician_id = (SELECT id FROM world.technician LIMIT 1) WHERE job_number = $1', [job]);
    await w.finish(job, { noPartsUsed: true });
    await w.link().runDue();
    const list = (await get('/pretend-billing/invoices')).json.data;
    expect(list.total).toBeGreaterThanOrEqual(1);
    const mine = list.invoices.find((i: { jobNumber: number }) => i.jobNumber === job);
    expect(mine).toMatchObject({ how: 'received', customer: 'Whitaker' });
    const one = (await get(`/pretend-billing/invoices/${job}`)).json.data;
    expect(one.totalCents).toBe(mine.totalCents);
    // 1 name per part (D5a-4) and the SD-20 total: the lines add up to the total, the discount is minus 15% of the service line.
    const sum = one.lines.reduce((n: number, l: { amountCents: number | null }) => n + (l.amountCents ?? 0), 0);
    expect(sum).toBe(one.totalCents);
    expect(one.lines.find((l: { kind: string }) => l.kind === 'discount').amountCents).toBeLessThan(0);
    expect(one.enteredByHand).toBeNull();
    // F-598: the technician ticked No parts used and the composed invoice has no part line, so the page can draw the line.
    expect(one.noPartsUsed).toBe(true);
    expect(one.lines.some((l: { kind: string }) => l.kind === 'part')).toBe(false);
    expect(one.technician).toBe('Maria Santos');
    // F-593: the service, labor and discount lines carry the facts their labels were composed from, so the page says them in its language.
    const words = Object.fromEntries(one.lines.map((l: { kind: string; words: unknown }) => [l.kind, l.words]));
    expect(words).toMatchObject({ service: { service: 'furnace_tune_up' }, labor: { laborMinutes: 60 }, discount: { ratePercent: 15 } });
    expect((await get('/pretend-billing/invoices/2000000')).status).toBe(404);
  });

  // why: FR-BILL-5
  it('reads the mode in force and the person who set it', async () => {
    const set = await kernel.router.handle(new Request('http://web:3000/api/v1/pretend-billing/mode', {
      method: 'PUT', body: JSON.stringify({ mode: 'reject_next_n', n: 3 }),
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: office.cookie },
    }), { address: '203.0.113.9' });
    expect(set.status).toBe(200);
    const mode = (await get('/pretend-billing/mode')).json.data;
    expect(mode).toEqual({ mode: 'reject_next_n', nLeft: 3, setBy: 'Keisha Thompson' });
    expect(office.id).toBeTruthy();
  });
});

describe('a send that never reaches a try is listed after 60 demo minutes (API-60, F-1844)', () => {
  // why: F-1844, FR-BILL-2: an item whose send kept throwing stayed sending with 0 tries, off the list, and no person saw it.
  it('lists an item still sending with 0 tries once its send has been due 60 demo minutes, and not at 59', async () => {
    const t0 = Temporal.Instant.from('2026-09-28T14:00:00Z');
    await w.setDemo(t0.toString());
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    // The link never runs the send (a send that keeps throwing writes no try): the item and its due event are as it leaves them.
    const item = await w.admin().query<{ state: string; tries: number }>('SELECT state, tries FROM world.billing_item WHERE job_number = $1', [job]);
    expect(item.rows).toEqual([{ state: 'sending', tries: 0 }]);
    const listed = async () => (await queue()).items.find((i: { jobNumber: number }) => i.jobNumber === job);
    await w.setDemo(t0.add({ minutes: 59 }).toString());
    expect(await listed()).toBeUndefined();
    await w.setDemo(t0.add({ minutes: 60 }).toString());
    expect(await listed()).toMatchObject({ jobNumber: job, state: 'sending', tries: 0, lastTry: null });
    // The export carries the same row (FR-BILL-12: the export equals the on-screen rows).
    const csv = await get('/billing/queue/export?branch=columbus&lang=en');
    expect(csv.status).toBe(200);
    expect(rowsOf(csv.text).some((r) => r[0] === String(job))).toBe(true);
  });

  // why: F-1865, FR-BILL-11: that row was listed but Mark fixed refused it (not_on_billing_list), so the office could not clear it.
  it('marks fixed the 60-minute sending row with 0 tries through API-158, and its due billing.send is superseded', async () => {
    const t0 = Temporal.Instant.from('2026-09-29T14:00:00Z');
    await w.setDemo(t0.toString());
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    const events = () => w.rows<{ kind: string; state: string; result: string | null }>(
      `SELECT kind, state, result FROM world.scheduled_event WHERE subject = $1 AND kind LIKE 'billing.%' ORDER BY kind`, [String(job)]);
    expect(await events()).toEqual([{ kind: 'billing.send', state: 'due', result: null }]);
    await w.setDemo(t0.add({ minutes: 60 }).toString());
    expect((await queue()).items.find((i: { jobNumber: number }) => i.jobNumber === job)).toMatchObject({ state: 'sending', tries: 0 });

    expect((await post(`/billing/queue/${job}/fixed`, { reason: TYPED })).status).toBe(200);
    const item = await w.rows<{ state: string; left_how: string | null; left_reason: string | null }>(
      'SELECT state, left_how, left_reason FROM world.billing_item WHERE job_number = $1', [job]);
    expect(item).toEqual([{ state: 'marked_fixed', left_how: 'marked_fixed', left_reason: TYPED }]);
    expect(await events()).toEqual([{ kind: 'billing.send', state: 'skipped', result: 'marked_fixed' }]);
    const after = await queue();
    expect(after.items.map((i: { jobNumber: number }) => i.jobNumber)).not.toContain(job);
    expect(after.leftLast7Days.find((l: { jobNumber: number }) => l.jobNumber === job)).toMatchObject({ how: 'marked_fixed', tries: 0, markedReason: TYPED });
    // The superseded send never runs: no try, and pbs holds the 1 entered-by-hand record.
    await w.link().runDue();
    expect(await w.rows('SELECT 1 FROM world.billing_attempt WHERE job_number = $1', [job])).toEqual([]);
    expect(await w.rows('SELECT how FROM pbs.invoice WHERE job_number = $1', [job])).toEqual([{ how: 'entered_by_hand' }]);
  });
});
