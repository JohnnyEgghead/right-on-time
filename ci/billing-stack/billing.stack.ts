// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-BILL-2, FR-BILL-4, FR-BILL-5, FR-BILL-10, FR-BILL-11, FR-BILL-12, UC-20 (P4-BILLING-UI Acceptance: Playwright on Chromium and WebKit against the Compose stack)
// The billing list, Mark fixed and the pretend billing screens against the Compose stack at its default settings (real PostgreSQL 18, real
// handlers, pbs and the worker running), through its proxy, with the outside-origin guard on. The jobs are finished jobs written into the
// database the way the finish writes them (a done job, its billing_item in `sending`, one due billing.send event); the worker sends them to
// pbs, and the pretend billing mode (API-68) decides what pbs answers. The rows the suite stands on are ci/shell-stack/fixture.sql's and
// ci/billing-stack/fixture.sql's.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { Browser, BrowserContextOptions, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_BILLING_STACK_URL;
const session = process.env.BW_BILLING_STACK_SESSION;
const daytonSession = process.env.BW_BILLING_STACK_DAYTON_SESSION;
const dbContainer = process.env.BW_BILLING_DB_CONTAINER;
if (!base || !session || !daytonSession || !dbContainer) throw new Error('BW_BILLING_STACK_URL, _SESSION, _DAYTON_SESSION and _DB_CONTAINER are not set: run ci/billing-stack.sh');
const origin = new URL(base).origin;
// APP_ORIGIN's default (SPECIFICATIONS 11.1): a write carries it, as a browser on the default stack's own origin would.
const APP_ORIGIN = 'http://localhost:8080';
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };

const WHITAKER = '0192f000-0000-7000-8000-00000000c003';
const ANN = '0192f000-0000-7000-8000-00000000c001';
/** Branch Dayton's customer and window (ci/billing-stack/fixture.sql, F-594). */
const DAYTON = { customer: '0192f000-0000-7000-8000-00000000c004', window: '0192f000-0000-7000-8000-00000000b002' };
/** A Mark fixed reason no catalog value holds (F-591): the page can show it only by reading what was typed. */
const TYPED = 'Paid by phone, entered by hand';

function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', dbContainer!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout;
}

/** A finished job as the finish leaves it: done, its billing_item in `sending`, and 1 due billing.send event (FR-BILL-1). */
function seedJob(n: number, o: { customer?: string; parts?: boolean; branch?: 'columbus' | 'dayton' } = {}): void {
  const parts = o.parts === true;
  const dayton = o.branch === 'dayton';
  psql(`
    INSERT INTO world.job (job_number, customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, status, version,
                           expected_minutes, booked_via, booked_at, billing_state, autopilot, touched_by_person, pilot, technician_id, ended_at,
                           labor_minutes, no_parts_used)
    VALUES (${n}, '${o.customer ?? (dayton ? DAYTON.customer : ANN)}', '${dayton ? 'dayton' : 'columbus'}', 'ac_tune_up', '2026-09-15', 'America/New_York', '${dayton ? DAYTON.window : '0192f000-0000-7000-8000-00000000b001'}',
            '2026-09-15T08:00:00-04:00', '2026-09-15T10:00:00-04:00', 'done', 2, 60, 'office', '2026-09-14T12:00:00Z', 'sending', false, false,
            false, '0192f000-0000-7000-8000-00000000f001', '2026-09-15T14:20:00Z', 65, ${parts ? 'false' : 'true'});
    ${parts ? `INSERT INTO world.job_part (job_number, part_id, quantity) VALUES (${n}, '0192f000-0000-7000-8000-00000000e001', 1), (${n}, '0192f000-0000-7000-8000-00000000e002', 2);
    INSERT INTO world.work_done_line (job_number, seq, text) VALUES (${n}, 1, 'AC tune-up, all readings normal'), (${n}, 2, 'Replaced a weak run capacitor');` : ''}
    INSERT INTO world.billing_item (job_number, state, tries) VALUES (${n}, 'sending', 0);
    INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ('2026-09-15T14:30:00Z', 'billing.send', '${n}', '{"jobNumber":${n}}', 'due');`);
}

/**
 * One API call with the stack's session cookie and the default origin. Node's fetch drops a script's Origin header (it is a forbidden
 * header there, as in a browser), and the kernel refuses a write without the right one (SD-8), so this sends the request with node:http.
 */
function api<T = unknown>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<{ status: number; data: T }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(`${origin}/api/v1${path}`, {
      method,
      headers: { cookie: `bw_session=${session}`, origin: APP_ORIGIN, ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.concat(chunks));
        try {
          resolve({ status: res.statusCode ?? 0, data: (JSON.parse(text) as { data?: T }).data as T });
        } catch {
          resolve({ status: res.statusCode ?? 0, data: text as unknown as T });
        }
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

interface QueueView {
  link: { mode: string | null };
  items: { jobNumber: number; state: string; tries: number; reasonKind: string | null }[];
  leftLast7Days: { jobNumber: number; how: string }[];
}
interface InvoicesView { invoices: { jobNumber: number }[] }

const setMode = async (mode: string, n?: number) => {
  const r = await api('PUT', '/pretend-billing/mode', n === undefined ? { mode } : { mode, n });
  if (r.status !== 200) throw new Error(`setting the mode ${mode} answered ${r.status}`);
  return r;
};
const queue = async (branch = 'columbus') => (await api<QueueView>('GET', `/billing/queue?branch=${branch}`)).data;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `cond` holds; the worker sends within its own poll, so a test waits for its result rather than for a time. */
async function until<T>(what: string, read: () => Promise<T>, cond: (v: T) => boolean, tries = 240): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i += 1) {
    last = await read();
    if (cond(last)) return last;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}; last read: ${JSON.stringify(last).slice(0, 700)}; the job rows: ${psql("SELECT bi.job_number, bi.state, bi.tries, bi.reason_key FROM world.billing_item bi ORDER BY 1").replace(/\n/g, ' ')}; events: ${psql("SELECT kind, subject, state, result FROM world.scheduled_event ORDER BY due_at").replace(/\n/g, ' ')}`);
}
const listed = (q: QueueView, job: number) => q.items.find((i) => i.jobNumber === job);
const left = (q: QueueView, job: number) => q.leftLast7Days.find((i) => i.jobNumber === job);
const norm = (t: string | null) => (t ?? '').replace(/\s+/g, ' ').trim();
/** "2026-09-15 14:20" (the export's 24-hour clock) as the page writes the time: "2:20 PM" (UD-15). */
const clock12 = (sheet: string) => {
  const [h, m] = sheet.slice(11).split(':').map(Number) as [number, number];
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/** The export's rows as cells (RFC 4180: a quoted cell may hold commas and doubled quotes), after the header. */
function rowsOf(csv: string): string[][] {
  const out: string[][] = [];
  for (const line of csv.split('\r\n').slice(1)) {
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

/** The page's API writes reach the real handlers carrying the default stack's origin (the way shell.stack.ts does it). */
async function writeOrigin(p: Page): Promise<void> {
  await p.route(`${origin}/api/v1/**`, async (r) => {
    if (r.request().method() === 'GET') return r.continue();
    const response = await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } });
    return r.fulfill({ response });
  });
}

describe.each(engines.map((e, i) => [...e, i] as const))('billing on the stack, %s', (_engine, type, k) => {
  let browser: Browser;
  // Each engine seeds its own job numbers: the first engine's jobs stay in the database.
  const J = (n: number) => 24850 + k * 20 + n;

  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function open(path: string, opts: BrowserContextOptions = DESKTOP, as: string = session!, before?: (p: Page) => void) {
    const g = await guardedContext(browser, [origin], opts);
    await g.context.addCookies([{ name: 'bw_session', value: as, url: origin }]);
    const p = await g.context.newPage();
    await writeOrigin(p);
    before?.(p);
    await p.goto(origin + path, { waitUntil: 'load' });
    return { g, p };
  }

  // why: FR-BILL-4, FR-BILL-5 the sample invoice totals $132.65 (SD-20) on the pretend billing screens, labeled pretend (OA-77), and the mode is set from the page
  it('opens the sample invoice at $132.65 with 1 name per part, and sets the mode from the pretend billing page', async () => {
    expect((await setMode('up')).status).toBe(200);
    const job = J(1);
    seedJob(job, { customer: WHITAKER, parts: true });
    await until(`job ${job} at billing`, async () => (await api<InvoicesView>('GET', '/pretend-billing/invoices')).data, (d) => d.invoices.some((i) => i.jobNumber === job));
    const { g, p } = await open(`/billing-system/invoices/${job}`);
    await p.waitForSelector('table.lines');
    expect(await p.locator('table.lines tr.tot td.r').innerText()).toBe('$132.65');
    expect(await p.locator('table.lines tr.disc td.r').last().innerText()).toBe('-$13.35');
    // 1 name per part (D5a-4): each part on its own line, named once.
    const names = await p.locator('table.lines tbody tr:not(.grp):not(.disc):not(.tot) td:first-child').allInnerTexts();
    expect(names).toContain('Run capacitor 45/5 MFD');
    expect(names).toContain('Furnace filter 16x25x1 MERV 8');
    expect(names.filter((x) => x.includes('capacitor'))).toHaveLength(1);
    expect(await p.locator('.pbtag').innerText()).toBe('Pretend billing system: not a real product');
    expect(await p.locator('.r1-demobar a[data-ctl="CTL-CMP-01-02"]').count()).toBe(0);
    await p.goto(`${origin}/billing-system`, { waitUntil: 'load' });
    await p.waitForSelector('table[data-ctl="CTL-PBS-01-06"] tbody tr');
    expect(await p.locator(`a.jl:text-is("${job}")`).count()).toBe(1);
    // Down, from the page: pick it, Apply, and the card says what is in force.
    await p.locator('label.radio', { hasText: 'Down' }).first().click();
    await p.locator('[data-ctl="CTL-PBS-01-03"]').click();
    await p.waitForSelector('.cur .chip.bad');
    expect(await p.locator('.cur .chip').innerText()).toBe('Down');
    expect((await api('GET', '/pretend-billing/mode')).data).toMatchObject({ mode: 'down', setBy: 'Keisha Thompson' });
    await setMode('up');
    await g.context.close(); // the outside-origin guard throws on any request to another origin
  }, 240_000);

  // why: FR-BILL-2 through API-60 itself: with billing Down, a finished job shows on the billing list until billing is Up and the retry succeeds
  it('lists a finished job on API-60 while billing is Down, until billing is Up and the retry succeeds', async () => {
    const job = J(2);
    await setMode('down');
    seedJob(job);
    const q = await until(`job ${job} on the list`, queue, (v) => (listed(v, job)?.tries ?? 0) >= 1);
    expect(listed(q, job)).toMatchObject({ state: 'retrying', reasonKind: 'down' });
    expect(q.link.mode).toBe('down');
    // F-600: the page the clause names, opened while billing is Down: the row and its reason are drawn.
    const down = await open('/office/billing');
    await down.p.waitForSelector('table[data-ctl="CTL-OFC-10-03"] tbody tr');
    const downRow = down.p.locator('table[data-ctl="CTL-OFC-10-03"] tbody tr').filter({ hasText: String(job) });
    expect(await downRow.count(), `the billing page lists job ${job} while billing is Down`).toBe(1);
    expect(await downRow.innerText()).toContain('Billing system was down');
    await down.g.context.close();
    await setMode('up');
    expect((await api('POST', '/billing/queue/retries', { branch: 'columbus' })).data).toMatchObject({ retried: expect.any(Number) });
    const after = await until(`job ${job} sent`, queue, (v) => !listed(v, job) && left(v, job) !== undefined);
    expect(left(after, job)).toMatchObject({ how: 'automatic_retry' });
  }, 240_000);

  // why: FR-BILL-10, FR-BILL-11, FR-BILL-12, UC-20 the office clears the list with Retry all and Mark fixed, and the fixed table names who and when
  it('clears the list with Retry all and Mark fixed, and the fixed table names who and when', async () => {
    const [retrying, held] = [J(3), J(4)];
    await setMode('reject_next_n', 1);
    seedJob(held);
    await until(`job ${held} held`, queue, (v) => listed(v, held)?.state === 'waiting_person');
    await setMode('down');
    seedJob(retrying);
    await until(`job ${retrying} retrying`, queue, (v) => listed(v, retrying)?.state === 'retrying');
    await setMode('up');

    const { g, p } = await open('/office/billing');
    await p.waitForSelector('table[data-ctl="CTL-OFC-10-03"] tbody tr');
    const row = (n: number) => p.locator('table[data-ctl="CTL-OFC-10-03"] tbody tr').filter({ hasText: String(n) });
    expect(await p.locator('table[data-ctl="CTL-OFC-10-03"] tbody').innerText(), `rows for ${retrying} and ${held}`).toContain(String(retrying));
    const trs = await p.locator('table[data-ctl="CTL-OFC-10-03"] tbody tr').allTextContents();
    expect(trs.filter((t) => t.includes(String(retrying))), `trs ${JSON.stringify(trs).slice(0, 600)}`).toHaveLength(1);
    expect(await row(retrying).count()).toBe(1);
    expect(await row(held).locator('.chip.bill').innerText()).toBe('Waiting for a person');
    expect(await row(retrying).locator('.chip.retry').innerText()).toBe('Retrying every 15 minutes');

    // Retry all: the retrying job leaves the list; the one waiting for a person is skipped.
    await p.locator('[data-ctl="CTL-OFC-10-08"]').click();
    await row(retrying).waitFor({ state: 'detached', timeout: 60_000 });
    expect(await row(held).count()).toBe(1);

    // Mark fixed: Cancel has the first focus; Mark fixed is off until a reason is typed.
    await row(held).locator('[data-ctl="CTL-OFC-10-09"]').click();
    const dlg = p.locator('[data-screen="SCR-OFC-47"]');
    await dlg.waitFor();
    expect(await p.evaluate(() => (globalThis as unknown as { document: { activeElement: { getAttribute(n: string): string | null } | null } }).document.activeElement?.getAttribute('data-ctl'))).toBe('CTL-OFC-47-04');
    expect(await dlg.locator('[data-ctl="CTL-OFC-47-03"]').getAttribute('aria-disabled')).toBe('true');
    await dlg.locator('#bw-fix-reason').fill(TYPED);
    await dlg.locator('[data-ctl="CTL-OFC-47-03"]').click();
    await row(held).waitFor({ state: 'detached', timeout: 30_000 });
    await p.waitForSelector('[data-ctl="CTL-OFC-10-10"] tbody tr');
    const fixedRow = p.locator('[data-ctl="CTL-OFC-10-10"] tbody tr').filter({ hasText: String(held) });
    expect(await fixedRow.locator('.chip.done').innerText()).toBe('Marked fixed');
    // FR-BILL-11: the reason typed in Mark fixed, with her name (F-591: never a catalog literal in its place).
    expect(await fixedRow.innerText()).toContain(`${TYPED}, Keisha T.`);
    expect(await fixedRow.locator('td.num').innerText()).toMatch(/^[A-Z][a-z]{2}, \d{1,2}:\d{2} (AM|PM)$/);
    expect(await p.locator('[data-ctl="CTL-OFC-10-03"] tbody tr', { has: p.locator('a.jl') }).filter({ hasText: /\b(?:24[0-9]{3})\b/ }).count()).toBe(0);
    // The pretend billing system holds the job as entered by hand, with the reason (FR-BILL-11).
    const invoice = (await api('GET', `/pretend-billing/invoices/${held}`)).data;
    expect(invoice).toMatchObject({ how: 'entered_by_hand', enteredByHand: { reason: TYPED, by: 'Keisha Thompson' } });
    await g.context.close();
  }, 300_000);

  // why: FR-BILL-12, F-596, F-591 Send again from the page names the person, and the export equals the on-screen rows: a byte order
  // mark, its header row, then each waiting row and each Fixed row in the page's order with the page's words, in the page's language
  it('names the person on a Send again, and exports the rows the page shows', async () => {
    const [resent, held] = [J(7), J(8)];
    await setMode('reject_next_n', 2);
    seedJob(resent);
    seedJob(held);
    await until(`jobs ${resent} and ${held} held`, queue, (v) => listed(v, resent)?.state === 'waiting_person' && listed(v, held)?.state === 'waiting_person');
    await setMode('up');
    const { g, p } = await open('/office/billing');
    await p.waitForSelector('table[data-ctl="CTL-OFC-10-03"] tbody tr');
    const waitingRow = (n: number) => p.locator('table[data-ctl="CTL-OFC-10-03"] tbody tr').filter({ hasText: String(n) });
    await waitingRow(resent).locator('[data-ctl="CTL-OFC-10-05"]').click();
    await waitingRow(resent).waitFor({ state: 'detached', timeout: 60_000 });
    const fixedRow = p.locator('[data-ctl="CTL-OFC-10-10"] tbody tr').filter({ hasText: String(resent) });
    await fixedRow.waitFor();
    expect(norm(await fixedRow.locator('td').nth(2).textContent())).toBe('Sent Sent again by Keisha T.');

    // The rows on the page, as a person reads them.
    const page = await p.evaluate(() => {
      const doc = (globalThis as unknown as { document: { querySelectorAll(q: string): ArrayLike<{ querySelector(q: string): { textContent: string | null } | null; querySelectorAll(q: string): ArrayLike<{ textContent: string | null }> }> } }).document;
      const text = (e: { textContent: string | null } | null | undefined) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const waiting = Array.from(doc.querySelectorAll('table[data-ctl="CTL-OFC-10-03"] tbody tr')).map((tr) => {
        const td = tr.querySelectorAll('td');
        return { job: text(td[0]), customer: text(tr.querySelector('td:nth-child(2) b')), technician: text(td[2]), done: /^\d{1,2}:\d{2} (AM|PM)/.exec(text(td[3]))?.[0] ?? text(td[3]),
          status: text(tr.querySelector('td.rs .chip')), reason: text(tr.querySelector('td.rs .two b')), tries: text(td[5]) };
      });
      const fixed = Array.from(doc.querySelectorAll('[data-ctl="CTL-OFC-10-10"] tbody tr')).map((tr) => {
        const td = tr.querySelectorAll('td');
        return { job: text(td[0]), reason: text(td[1]), chip: text(tr.querySelector('td:nth-child(3) .chip')), how: text(td[2]), when: text(td[3]) };
      });
      return { waiting, fixed };
    });
    expect(page.waiting.length).toBeGreaterThan(0);
    expect(page.fixed.length).toBeGreaterThan(0);

    const [download] = await Promise.all([p.waitForEvent('download'), p.locator('[data-ctl="CTL-OFC-10-11"]').click()]);
    expect(download.suggestedFilename()).toMatch(/^billing-columbus-\d{4}-\d{2}-\d{2}\.csv$/);
    const bytes = readFileSync((await download.path())!);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes.subarray(3));
    expect(text.split('\r\n')[0]).toBe('Job,Customer,Technician,Done at,Status,Reason,Tries,Last try,Next try,How it reached billing,Who,When,Reason given');
    const csv = rowsOf(text);
    // The export equals the on-screen rows: the same rows in the same order, each cell the page's words (a time as the spreadsheet's 24-hour clock).
    expect(csv.slice(0, page.waiting.length).map((r) => ({ job: r[0], customer: r[1], technician: r[2], done: clock12(r[3]!), status: r[4], reason: r[5], tries: r[6] })))
      .toEqual(page.waiting);
    expect(csv.slice(page.waiting.length).map((r) => ({ job: r[0], reason: r[5], chip: r[4], how: `${r[4]} ${r[9]}`, when: clock12(r[11]!) })))
      .toEqual(page.fixed.map((f) => ({ ...f, when: f.when.replace(/^[^,]+, /, '') })));
    await g.context.close();
    // The next engine's Retry all test expects an empty list: the held job leaves it.
    expect((await api('POST', `/billing/queue/${held}/fixed`, { reason: TYPED })).status).toBe(200);
  }, 240_000);

  // why: F-594 the billing list, its live stream and its export follow the top bar's branch (CTL-CMP-07-04: the URL, then the browser,
  // then the user's own branch): ?branch=dayton shows Dayton's jobs, choosing Columbus moves the list without a reload, and a Dayton user
  // with nothing stored sees Dayton
  it('follows the branch the top bar keeps', async () => {
    const [inDayton, inColumbus] = [J(5), J(6)];
    await setMode('down');
    seedJob(inDayton, { branch: 'dayton' });
    seedJob(inColumbus);
    await until(`job ${inDayton} on Dayton's list`, () => queue('dayton'), (v) => (listed(v, inDayton)?.tries ?? 0) >= 1);
    await until(`job ${inColumbus} on Columbus's list`, () => queue('columbus'), (v) => (listed(v, inColumbus)?.tries ?? 0) >= 1);
    await setMode('up');
    const rowOf = (pg: Page, n: number) => pg.locator('table[data-ctl="CTL-OFC-10-03"] tbody tr').filter({ hasText: String(n) });
    // The event connections each page opens and the branches its bell reads, watched from before the page loads.
    const watch = (seen: string[]) => (pg: Page) => {
      pg.on('request', (r) => {
        const u = new URL(r.url());
        if (u.pathname === '/api/v1/events') streams.push(u.search);
        // The bell's read names the top bar's branch: it follows the branch and never reads one the bar then leaves (F-712).
        if (u.pathname === '/api/v1/alerts') seen.push(u.searchParams.get('branch') ?? '');
      });
    };

    // The tab's 1 event connection names no branch and outlives a branch change (F-710): the notices are filtered on the page's side.
    const streams: string[] = [];
    const seen: string[] = [];
    const { g, p } = await open('/office/billing?branch=dayton', DESKTOP, session!, watch(seen));
    await expect.poll(() => seen.includes('dayton'), { timeout: 15_000 }).toBe(true);
    expect(seen).not.toContain('columbus');
    await rowOf(p, inDayton).waitFor();
    expect(await rowOf(p, inColumbus).count()).toBe(0);
    expect(await p.locator('.pgh h1 + p').innerText()).toContain('Dayton');
    // The top bar: Columbus. The list follows in place (the page is not reloaded: its marker survives).
    await p.evaluate(() => { (globalThis as unknown as { bwMark: number }).bwMark = 1; });
    await p.locator('[data-ctl="CTL-CMP-07-04"] select').selectOption('columbus');
    await rowOf(p, inColumbus).waitFor({ timeout: 30_000 });
    expect(await rowOf(p, inDayton).count()).toBe(0);
    expect(await p.evaluate(() => (globalThis as unknown as { bwMark?: number }).bwMark)).toBe(1);
    expect(new URL(p.url()).searchParams.get('branch')).toBe('columbus');
    await expect.poll(() => seen.includes('columbus'), { timeout: 15_000 }).toBe(true);
    expect(streams).toEqual(['']);
    const [download] = await Promise.all([p.waitForEvent('download'), p.locator('[data-ctl="CTL-OFC-10-11"]').click()]);
    expect(download.suggestedFilename()).toMatch(/^billing-columbus-/);
    const rows = rowsOf(new TextDecoder().decode(readFileSync((await download.path())!).subarray(3))).map((r) => r[0]);
    expect(rows).toContain(String(inColumbus));
    expect(rows).not.toContain(String(inDayton));
    await g.context.close();

    // A Dayton user, nothing stored, no ?branch: her own branch, from API-07.
    const dSeen: string[] = [];
    const d = await open('/office/billing', DESKTOP, daytonSession!, watch(dSeen));
    await rowOf(d.p, inDayton).waitFor();
    expect(await rowOf(d.p, inColumbus).count()).toBe(0);
    expect(await d.p.locator('[data-ctl="CTL-CMP-07-04"] select').inputValue()).toBe('dayton');
    await expect.poll(() => dSeen.includes('dayton'), { timeout: 15_000 }).toBe(true);
    expect(dSeen).not.toContain('columbus');
    await d.g.context.close();
    // The next engine's Retry all test expects an empty list: both jobs reach billing.
    for (const branch of ['columbus', 'dayton']) await api('POST', '/billing/queue/retries', { branch });
    await until('both branch jobs sent', async () => [await queue('columbus'), await queue('dayton')] as const,
      ([c, dd]) => !listed(c, inColumbus) && !listed(dd, inDayton));
  }, 240_000);
});
