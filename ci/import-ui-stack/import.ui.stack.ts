// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-IMP-10, FR-IMP-11, FR-IMP-4, UC-08 (P4-ADMIN-IMPORT Acceptance: Playwright on Chromium and WebKit against the Compose stack)
// The import pages against the Compose stack at its default settings (real PostgreSQL 18, real handlers, pbs running, the worker started by
// its real start-up), after a fresh setup from the image, through its proxy, with the outside-origin guard on (the browser may reach the
// stack's own origin only). The web image is the release build: the pages are the release routes. The office session is Keisha Thompson's.
//   1. The world has setup's real run: History lists it, and Run the import is disabled with its reason on SCR-OFC-13 (FR-IMP-10).
//   2. UC-08: Run a dry run through the page; the page follows it to the report; no customer, visit, equipment, pair or merge row changes.
//   3. FR-IMP-11: M, K and S pressed with focus on the top-bar search or the page heading change no pair; with focus on the shown pair, K
//      keeps it separate, S skips it (still counted), M merges it; focus is on the next shown pair after each.
//   4. UC-08, FR-IMP-4: Undo on the merge in History (Escape keeps it merged; Undo the merge restores record B, whose row reads merged
//      until then).
//   4b. FR-LANG-1: the shown pair holds a Spanish speaker and an English speaker; the page names them Español and English, with the page
//      in English and in Spanish (F-1280).
//   5. A world with no real run (setup's real run marked failed), on each engine: Run the import is offered, and its dialog opens with
//      Cancel focused.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Browser, BrowserContextOptions, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_IMPORT_UI_URL;
const session = process.env.BW_IMPORT_UI_SESSION;
const project = process.env.BW_IMPORT_UI_PROJECT;
if (!base || !session || !project) throw new Error('BW_IMPORT_UI_URL, _SESSION and _PROJECT are not set: run ci/import-ui-stack.sh');
const origin = new URL(base).origin;
const root = path.resolve(import.meta.dirname, '../..');
/** APP_ORIGIN's default (SD-8): a browser write must carry it; the suite's proxy listens on a free port. */
const APP_ORIGIN = 'http://localhost:8080';
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };

function run(cmd: string, args: string[], input?: string): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: root, input });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 6).join(' ')} failed (${r.status}): ${(r.stderr || r.stdout).slice(0, 400)}`);
  return r.stdout;
}
const compose = (...args: string[]) => run('docker', ['compose', '-p', project!, '-f', 'infra/compose.yaml', ...args]);
const dbContainer = () => compose('ps', '-a', '-q', 'db').trim();
const psql = (sql: string) => run('docker', ['exec', '-i', dbContainer(), 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql).trim();
const num = (sql: string) => Number(psql(sql));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 240_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

/**
 * The rows a dry run must leave alone (FR-IMP-1; UC-08): the row count of every table in the world schema, in one query, except the
 * dry run's own run record and problem list (FR-IMP-1: "excluding the dry run's own run record and problem list", F-624).
 */
const worldCounts = () =>
  psql(`SELECT string_agg(table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text, ',' ORDER BY table_name)
        FROM information_schema.tables WHERE table_schema = 'world' AND table_type = 'BASE TABLE' AND table_name NOT IN ('import_run', 'import_problem_row')`);
/** What a customer record owns (UC-08's undo gives it back): its visits, equipment and jobs. */
const ownedRows = (id: string) =>
  psql(`SELECT (SELECT count(*) FROM world.past_visit WHERE customer_id = '${id}') || ',' || (SELECT count(*) FROM world.equipment WHERE customer_id = '${id}') || ',' ||
        (SELECT count(*) FROM world.job WHERE customer_id = '${id}')`);
const pairStatuses = () => psql(`SELECT string_agg(status || '=' || n, ',' ORDER BY status) FROM (SELECT status, count(*) AS n FROM world.duplicate_pair GROUP BY status) s`);
const dryRuns = () => num(`SELECT count(*) FROM world.import_run WHERE kind = 'dry_run' AND status = 'done'`);

async function api<T>(p: string): Promise<T> {
  const res = await fetch(`${base}/api/v1${p}`, { headers: { cookie: `bw_session=${session}` } });
  expect(res.status, p).toBe(200);
  return ((await res.json()) as { data: T }).data;
}

/** The page's writes reach the real handlers carrying the stack's default origin (a browser will not let a route rewrite Origin). */
async function writeOrigin(p: Page): Promise<void> {
  await p.route(`${origin}/api/v1/**`, async (r) => {
    if (r.request().method() === 'GET') return r.continue();
    try {
      const response = await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } });
      await r.fulfill({ response });
    } catch {
      // the page or its context closed while the write was in flight; nothing is waiting for the answer
    }
  });
}

describe.each(engines)('the import pages on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  /** `lang`: the page language the visitor chose (the bw_lang cookie); left out, the page is in its default, English. */
  async function open<T>(p: string, fn: (page: Page) => Promise<T>, screen: string, lang?: 'en' | 'es'): Promise<T> {
    const g = await guardedContext(browser, [origin], DESKTOP);
    try {
      await g.context.addCookies([{ name: 'bw_session', value: session!, url: origin, httpOnly: true }, ...(lang ? [{ name: 'bw_lang', value: lang, url: origin }] : [])]);
      const page = await g.context.newPage();
      await writeOrigin(page);
      // 'load', not network idle: an office page holds the bell's event stream open (F-690). Each case first waits on a selector only its data draws.
      const res = await page.goto(origin + p, { waitUntil: 'load' });
      expect(res?.status(), p).toBe(200);
      await page.waitForSelector(`.r1-screen[data-screen="${screen}"]`, { state: 'attached' });
      return await fn(page);
    } finally {
      await g.context.close();
    }
  }
  const disabled = (page: Page, ctl: string) => page.locator(`[data-ctl="${ctl}"]`).first().getAttribute('aria-disabled');

  // why: FR-IMP-10 on a world with setup's real run, History lists it and Run the import is disabled with its reason: it opens no dialog
  it(`${engine}: setup's real run is in the history and the office's Run the import is disabled with its reason`, async () => {
    const real = await api<{ realRun: { runId: string } | null }>('/import/runs');
    expect(real.realRun, 'a fresh setup leaves its real run').not.toBeNull();
    await open('/office/admin/import/history', async (page) => {
      await page.waitForSelector('[data-ctl="CTL-OFC-15-01"] tbody tr');
      const rows = await page.locator('[data-ctl="CTL-OFC-15-01"] tbody tr').allTextContents();
      expect(rows.some((r) => r.includes('Real run') && r.includes('Setup') && r.includes('Done')), rows.join(' | ')).toBe(true);
    }, 'SCR-OFC-15');
    await open('/office/admin/import', async (page) => {
      await page.waitForSelector('[data-ctl="CTL-OFC-13-06"] .banner');
      expect(await disabled(page, 'CTL-OFC-13-08')).toBe('true');
      expect(await page.locator('.run .r1-note').textContent()).toMatch(/already ran on this world.*by Setup/);
      await page.locator('[data-ctl="CTL-OFC-13-08"]').click({ force: true });
      expect(await page.locator('[role="dialog"]').count()).toBe(0);
      expect(await page.locator('[data-ctl="CTL-OFC-13-11"]').textContent()).toMatch(/^About \d+ minutes; the board keeps working\.$/);
    }, 'SCR-OFC-13');
  });

  // why: F-621, F-870, F-879 the shown pair draws CTL-OFC-14-06 as v0.13 states it (old customer numbers, the 10 rows, no Email row) and the merges table each address and the total (owner ruling d9901466)
  it(`${engine}: the shown pair and the merges table draw the 5 frame items from the stack's data`, async () => {
    type Rec = { oldCustomerNumber: string | null; plan: string; notes: string | null; equipment: unknown[]; visits: { count: number } };
    const dup = (await api<{ pairs: { recordA: Rec; recordB: Rec }[] }>('/import/duplicates?status=to_check&limit=50')).pairs[0]!;
    await open('/office/admin/import/duplicates', async (page) => {
      await page.waitForSelector('[data-ctl="CTL-OFC-14-06"] table.c tbody tr');
      const heads = await page.locator('[data-ctl="CTL-OFC-14-06"] table.c thead th small').allTextContents();
      expect(heads).toEqual([`old customer ${dup.recordA.oldCustomerNumber}`, `old customer ${dup.recordB.oldCustomerNumber}`]);
      for (const h of heads) expect(h).toMatch(/^old customer \d{5}$/); // the stored customer_ref as written (F-880)
      const labels = await page.locator('[data-ctl="CTL-OFC-14-06"] table.c tbody td.k').allTextContents();
      expect(labels).toEqual(['Name', 'Address', 'Phone', 'Text language', 'Customer since', 'Equipment', 'Visits', 'Branch', 'Plan', 'Notes']);
      const row = (n: number) => page.locator(`[data-ctl="CTL-OFC-14-06"] table.c tbody tr:nth-child(${n}) td.v`);
      // Address: city, state and ZIP on the second line; Equipment: 1 line per piece; Visits: the last visit on the second line.
      for (const [i, r] of [dup.recordA, dup.recordB].entries()) {
        expect(await row(2).nth(i).locator('small').textContent()).toMatch(/, OH \d{5}$/);
        expect(await row(6).nth(i).locator('small').count()).toBe(Math.max(0, r.equipment.length - 1));
        expect(await row(7).nth(i).locator('small').count()).toBe(r.visits.count > 0 ? 1 : 0);
        if (r.visits.count > 0) expect(await row(7).nth(i).locator('small').textContent()).toMatch(/^Last: .+, [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
        expect(await row(9).nth(i).textContent()).toBe(r.plan === 'comfort_club' ? 'Comfort Club member' : 'None');
        expect(await row(10).nth(i).textContent()).toBe(r.notes ?? 'None');
      }
    }, 'SCR-OFC-14');
    const m = await api<{ merges: { address: string }[]; total: number }>('/import/merges?limit=20');
    expect(m.total).toBeGreaterThan(m.merges.length);
    await open('/office/admin/import/history', async (page) => {
      await page.waitForSelector('[data-ctl="CTL-OFC-15-04"] tbody tr');
      expect(await page.locator('[data-ctl="CTL-OFC-15-04"] tbody .pair small').allTextContents()).toEqual(m.merges.map((x) => x.address));
      expect(await page.locator('.ft span').textContent()).toBe(`Showing ${m.merges.length} of ${m.total.toLocaleString('en-US')} merges`);
    }, 'SCR-OFC-15');
  });

  // why: FR-LANG-1 on the real stack the duplicates page names a Spanish-speaking customer's text language "Español" and an English speaker's "English", with the page in English and in Spanish (F-1280)
  it.each(['en', 'es'] as const)(`${engine}: the duplicates page names a Spanish speaker's text language Español and an English speaker's English, page in %s`, async (lang) => {
    type Rec = { customerId: string; textLanguage: string };
    const dup = (await api<{ pairs: { recordA: Rec; recordB: Rec }[] }>('/import/duplicates?status=to_check&limit=50')).pairs[0]!;
    psql(`UPDATE world.customer SET text_language = 'es' WHERE id = '${dup.recordA.customerId}'; UPDATE world.customer SET text_language = 'en' WHERE id = '${dup.recordB.customerId}'`);
    await open('/office/admin/import/duplicates', async (page) => {
      await page.waitForSelector('[data-ctl="CTL-OFC-14-06"] table.c tbody tr');
      expect(await page.evaluate(() => (globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement.lang)).toBe(lang);
      const row = await page.locator('[data-ctl="CTL-OFC-14-06"] table.c tbody tr:nth-child(4) td.v').allTextContents();
      expect(row).toEqual(['Español', 'English']);
    }, 'SCR-OFC-14', lang);
  });

  // why: UC-08 a dry run started from the page changes no customer, visit, equipment, job, pair or merge row, and the page shows its report
  it(`${engine}: Run a dry run through the page changes no row count and the page follows it to the report`, async () => {
    const before = worldCounts();
    const runsBefore = dryRuns();
    await open('/office/admin/import', async (page) => {
      await page.waitForSelector('[data-ctl="CTL-OFC-13-06"] .banner');
      await page.locator('[data-ctl="CTL-OFC-13-04"]').click();
      await until('the new dry run to finish', () => dryRuns() === runsBefore + 1);
      // The page follows the run on its own (EVT-08 and the poll): the report comes back with Run a dry run enabled again.
      await page.waitForSelector('[data-ctl="CTL-OFC-13-06"] .banner', { timeout: 60_000 });
      await until('Run a dry run to be enabled again', async () => (await disabled(page, 'CTL-OFC-13-04')) === null, 60_000);
      expect(await page.locator('.banner h2').textContent()).toBe('Dry run - nothing was changed.');
      const latest = (await api<{ runs: { runId: string; kind: string }[] }>('/import/runs')).runs.find((r) => r.kind === 'dry_run')!;
      const rep = await api<{ report: { customers: { total: number }; visits: { total: number }; equipment: { total: number } } }>(`/import/runs/${latest.runId}`);
      const shown = await page.locator('.cnt .v').allTextContents();
      expect(shown).toEqual([rep.report.customers.total, rep.report.visits.total, rep.report.equipment.total].map((n) => n.toLocaleString('en-US')));
      expect(await page.locator('[data-ctl="CTL-OFC-13-10"]').textContent()).toMatch(/^Ran .* on the old system's Mon, Aug 31, 5:00 AM export\. The live system was not touched\.$/);
      expect(await page.locator('table.pr tbody tr').count()).toBe(6);
    }, 'SCR-OFC-13');
    expect(worldCounts()).toBe(before);
  });

  // why: FR-IMP-11 with focus on the top-bar search or the page heading, M, K and S change no pair; with focus on the shown pair K keeps it separate, S skips it and M merges it, and focus is on the next shown pair after each
  it(`${engine}: M, K and S act only while the shown pair has focus, and focus moves to the next pair`, async () => {
    await open('/office/admin/import/duplicates', async (page) => {
      await page.waitForSelector('[data-ctl="CTL-OFC-14-06"]');
      const statuses0 = pairStatuses();
      // Focus anywhere else: the top-bar search box, then the page heading.
      await page.locator('header.topbar input').first().focus();
      for (const k of ['m', 'k', 's']) await page.keyboard.press(k);
      await page.locator('h1').click();
      for (const k of ['m', 'k', 's']) await page.keyboard.press(k);
      await sleep(1500);
      expect(pairStatuses()).toBe(statuses0);
      const shownName = () => page.locator('.qi.now b').textContent();
      const first = await shownName();
      const region = page.locator('[data-ctl="CTL-OFC-14-06"]');
      const focused = () => page.evaluate("document.activeElement?.getAttribute('data-ctl') ?? ''") as Promise<string>;
      // K on the shown pair.
      await region.focus();
      const kept0 = num(`SELECT count(*) FROM world.duplicate_pair WHERE status = 'kept_separate'`);
      await page.keyboard.press('k');
      await until('the pair to be kept separate', () => num(`SELECT count(*) FROM world.duplicate_pair WHERE status = 'kept_separate'`) === kept0 + 1, 30_000);
      await until('the next pair to show', async () => (await shownName()) !== first, 30_000);
      await until('focus on the shown pair', async () => (await focused()) === 'CTL-OFC-14-06', 30_000);
      // S on the next one: it stays counted as skipped.
      const second = await shownName();
      const skip0 = num(`SELECT count(*) FROM world.duplicate_pair WHERE status = 'skipped'`);
      await page.keyboard.press('s');
      await until('the pair to be skipped', () => num(`SELECT count(*) FROM world.duplicate_pair WHERE status = 'skipped'`) === skip0 + 1, 30_000);
      await until('the next pair to show', async () => (await shownName()) !== second, 30_000);
      await until('focus on the shown pair', async () => (await focused()) === 'CTL-OFC-14-06', 30_000);
      expect(await page.locator('.pk span').nth(2).textContent()).toContain(String(skip0 + 1));
      // M on the next one: record B is merged into record A.
      const next = (await api<{ pairs: { pairId: string; recordB: { customerId: string } }[] }>('/import/duplicates?status=to_check&limit=1')).pairs[0]!;
      const merged0 = num(`SELECT count(*) FROM world."merge" WHERE status = 'active'`);
      mergedBOwned = ownedRows(next.recordB.customerId);
      expect(mergedBOwned, 'record B owns rows for the undo to give back').not.toBe('0,0,0');
      await page.keyboard.press('m');
      await until('the pair to be merged', () => num(`SELECT count(*) FROM world."merge" WHERE status = 'active'`) === merged0 + 1, 30_000);
      expect(psql(`SELECT status FROM world.customer WHERE id = '${next.recordB.customerId}'`)).toBe('merged');
      mergedB = next.recordB.customerId;
    }, 'SCR-OFC-14');
  });

  // why: UC-08 Undo on a merge in History asks first (Escape keeps it merged), then Undo the merge restores record B and the row reads Undone
  it(`${engine}: Undo a merge from History restores the customer`, async () => {
    expect(mergedB, 'the previous case merged a pair').not.toBe('');
    await open('/office/admin/import/history', async (page) => {
      await page.waitForSelector('[data-ctl="CTL-OFC-15-04"] tbody tr');
      const undo = page.locator('[data-ctl="CTL-OFC-15-05"]').first();
      await undo.click();
      const dialog = page.locator('[role="dialog"]');
      await dialog.waitFor();
      expect(await page.evaluate("document.activeElement?.getAttribute('data-ctl')")).toBe('CTL-OFC-26-03');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      expect(psql(`SELECT status FROM world.customer WHERE id = '${mergedB}'`)).toBe('merged');
      await undo.click();
      await dialog.waitFor();
      await page.locator('[data-ctl="CTL-OFC-26-02"]').click();
      await until('record B to be restored', () => psql(`SELECT status FROM world.customer WHERE id = '${mergedB}'`) !== 'merged', 30_000);
      expect(psql(`SELECT coalesce(merged_into::text, 'none') FROM world.customer WHERE id = '${mergedB}'`)).toBe('none');
      // Record B's visits, equipment and jobs are back, not only its status (F-624).
      expect(ownedRows(mergedB)).toBe(mergedBOwned);
      await dialog.waitFor({ state: 'detached' });
      expect(await page.locator('[data-ctl="CTL-OFC-15-04"] tbody tr').first().textContent()).toContain('Undone');
    }, 'SCR-OFC-15');
    mergedB = '';
    mergedBOwned = '';
  });
});

let mergedB = '';
let mergedBOwned = '';

// The last case changes the world: setup's real run is marked failed, so no real run exists. It runs on each engine (the Acceptance names
// both), after every engine's cases on setup's world. Its UPDATE is idempotent (the second engine's sets the rows it already set) and the
// case writes nothing else (Escape closes the dialog, no run starts), so each engine meets the same world.
describe.each(engines)('a world with no real run, %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  // why: FR-IMP-10 on a world with no real run the office's Run the import is offered, and its dialog opens with Cancel focused and closes on Escape
  it(`${engine}: offers Run the import and opens its dialog with Cancel focused`, async () => {
    psql(`UPDATE world.import_run SET status = 'failed' WHERE kind = 'real'`);
    expect(num(`SELECT count(*) FROM world.import_run WHERE kind = 'real' AND status <> 'failed'`), 'no real run is left').toBe(0);
    const g = await guardedContext(browser, [origin], DESKTOP);
    try {
      await g.context.addCookies([{ name: 'bw_session', value: session!, url: origin, httpOnly: true }]);
      const page = await g.context.newPage();
      await writeOrigin(page);
      await page.goto(origin + '/office/admin/import', { waitUntil: 'load' }); // as open(): the button is drawn from the page's read
      await page.waitForSelector('[data-ctl="CTL-OFC-13-08"]');
      expect(await page.locator('[data-ctl="CTL-OFC-13-08"]').first().getAttribute('aria-disabled')).toBeNull();
      await page.locator('[data-ctl="CTL-OFC-13-08"]').click();
      await page.locator('[role="dialog"]').waitFor();
      expect(await page.evaluate("document.activeElement?.getAttribute('data-ctl')")).toBe('CTL-OFC-25-03');
      expect(await page.locator('[data-ctl="CTL-OFC-25-01"]').textContent()).toMatch(/^The real import adds .* from the dry run of .*, and merges the .* exact duplicates\./);
      await page.keyboard.press('Escape');
      await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
    } finally {
      await g.context.close();
    }
  });
});
