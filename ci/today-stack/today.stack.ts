// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-1, FR-TECH-2, FR-TECH-9, FR-TECH-12, FR-TEXT-4, FR-DEMO-1, FR-AUTH-11, FR-TECH-13 (P5-TWA-TODAY Acceptance: Playwright on Chromium and WebKit at 520 x 980)
// The web technician app's sign-in, Today and confirm steps against the Compose stack at its default settings (real PostgreSQL 18, real handlers,
// pbs running, the worker started by its real start-up; ACCESS_CODE_ON and DEMO_MODE on as the named settings), after a fresh setup from the image,
// through its proxy and the suites' https front (ci/auth-stack/tls-front.ts), with the outside-origin guard on. The web image is the release build:
// the pages are the release routes. On each engine, in 1 world, with a technician of its own (the day is the seed's Tue, Sep 15):
//   1. The technician enters the code, signs in on SCR-TEC-01, and Today lists the day in window order with the van and the progress, and the demo time
//      in the header (no strip above it); the page carries X-Bw-Server-State and the service worker keeps only its shell variant.
//   2. On my way: the sheet opens and nothing is sent; Cancel changes nothing; Send makes the job On the way and 1 on-the-way text (FR-TECH-2).
//   3. Arrived, then No one home: the visit ends and shows in the no-one-home report's source (FR-TECH-9, FR-REP-2).
//   4. A job On the way that the office reassigns reads Scheduled in the new technician's API-100 (FR-TEXT-4; owner ruling d0c0a033).
//   5. The reviewer sample user signs in and meets an empty day, not an error (F-252 item 7).
//   6. F-1037: the access code, SCR-TEC-01 and Forgot password typed and tapped before the page's script has run (the scripts held): the tap
//      is kept and sent once the page hydrates, and no field goes into the address; the code typed before hydration is still sent after it.
// Rate limits (SPECIFICATIONS 7.1): API-01 and API-03 allow 10 a minute per address, and every context here comes from this 1 machine. So the
// code is entered through SCR-GATE-01 by the first sign-in and the F-1037 cases, and every other context starts with that bw_access cookie, as a
// returning visitor's browser does; the office actor signs in through Sign in as (API-05), which 7.1 does not limit (F-1037: the code entry of
// the 11th context in a minute answered 429, and the set-password case failed on it).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Browser, BrowserContext, BrowserContextOptions, Cookie, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tlsFront } from '../auth-stack/tls-front.ts';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_TODAY_URL;
const code = process.env.BW_TODAY_CODE;
const tls = process.env.BW_TODAY_TLS;
const seed = process.env.BW_TODAY_SEED;
const reviewerPassword = process.env.BW_TODAY_REVIEWER;
const project = process.env.BW_TODAY_PROJECT;
if (!base || !code || !seed || !tls || !project || !reviewerPassword) throw new Error('BW_TODAY_URL, _CODE, _SEED, _TLS, _REVIEWER and _PROJECT are not set: run ci/today-stack.sh');
const front = await tlsFront(base, tls);
afterAll(() => front.close());
const origin = front.origin;
const root = path.resolve(import.meta.dirname, '../..');
/** APP_ORIGIN's default (SD-8): a browser write must carry it; the suite's front listens on a free port. */
const APP_ORIGIN = 'http://localhost:8080';
/** 520 x 980: the plan's phone size for the web technician app. */
const PHONE: BrowserContextOptions = { viewport: { width: 520, height: 980 }, ignoreHTTPSErrors: true };
const KEISHA = 'keisha.t@brightwater.example';
const MARIA = 'maria.santos@brightwater.example';

async function shown(email: string): Promise<string> {
  const { samplePassword, showSamplePassword } = await import('../../packages/db/src/passwords.ts');
  return showSamplePassword(samplePassword(seed!, email));
}
function run(cmd: string, args: string[], input?: string): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: root, input });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 6).join(' ')} failed (${r.status}): ${(r.stderr || r.stdout).slice(0, 400)}`);
  return r.stdout;
}
const compose = (...args: string[]) => run('docker', ['compose', '-p', project!, '-f', 'infra/compose.yaml', ...args]);
const dbContainer = () => compose('ps', '-a', '-q', 'db').trim();
const psql = (sql: string) => run('docker', ['exec', '-i', dbContainer(), 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 90_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

async function writeOrigin(p: Page): Promise<void> {
  await p.route(`${origin}/api/v1/**`, async (r) => {
    if (r.request().method() === 'GET') return r.continue();
    try {
      const response = await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } });
      await r.fulfill({ response });
    } catch {
      // the page or its context closed while the write was in flight
    }
  });
}

/**
 * F-1037: holds every script of the release build (/_next/static/**.js) from hold() until release(), so the page shows its server HTML and
 * nothing hydrates, as on a slow phone: the fields can be typed and the buttons tapped, and what comes of that is the product's doing.
 * pending() counts the scripts held now.
 */
async function holdScripts(p: Page): Promise<{ hold: () => void; release: () => void; pending: () => number }> {
  let gate: Promise<void> = Promise.resolve();
  let open: () => void = () => {};
  let held = 0;
  await p.route((u) => u.origin === origin && u.pathname.startsWith('/_next/static/') && u.pathname.endsWith('.js'), async (r) => {
    held += 1;
    try {
      await gate;
    } finally {
      held -= 1;
    }
    await r.continue().catch(() => undefined); // the page went on to another address while its script was held
  });
  return {
    hold: () => {
      gate = new Promise<void>((resolve) => {
        open = () => resolve();
      });
    },
    release: () => open(),
    pending: () => held,
  };
}
/** Every address the page opens, with only the names of its query fields (a value can be a code or a password). */
function addresses(p: Page): string[] {
  const seen: string[] = [];
  p.on('framenavigated', (f) => {
    if (f !== p.mainFrame()) return;
    const u = new URL(f.url());
    seen.push(`${u.pathname}?${[...u.searchParams.keys()].join('&')}`);
  });
  return seen;
}
/** An address that carries a form field: the browser's own GET submit of a form React never got to handle. */
const carriesField = (a: string) => /[?&](code|login|password|email)(&|$)/.test(a);

interface DayJob { jobNumber: number; version: number; status: string; position: number; customer: { name: string } }
interface Day { date: string; van: { number: string } | null; jobs: DayJob[] }
const dayOf = (p: Page): Promise<Day> => p.evaluate(async () => ((await (await fetch('/api/v1/tech/day')).json()) as { data: Day }).data);
const jobStatus = (n: number) => psql(`SELECT status FROM world.job WHERE job_number = ${n}`);

/** The technicians with at least 2 scheduled jobs on the seed's day, most jobs first: 1 per engine, so each engine has a day of its own. */
function candidates(): { email: string; id: string; name: string; employee: string }[] {
  return psql(`
    SELECT u.email || '|' || t.id || '|' || t.name || '|' || coalesce(u.employee_number::text, '') FROM world.technician t JOIN world."user" u ON u.id = t.user_id
     WHERE t.branch_id = 'columbus' AND u.status = 'active'
       AND (SELECT count(*) FROM world.job j WHERE j.technician_id = t.id AND j.date = date '2026-09-15' AND j.status = 'scheduled') >= 2
     ORDER BY t.name`).split('\n').filter(Boolean).map((l) => {
    const [email, id, name, employee] = l.split('|') as [string, string, string, string];
    return { email, id, name, employee };
  });
}

describe.each(engines)('the web technician app on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    for (const c of contexts) await c.close();
    await browser?.close();
  });

  /** The bw_access cookie the first code entry on this engine set; a context made with entered() starts with it (see Rate limits above). */
  let access: Cookie[] = [];
  const entered = (): BrowserContextOptions => (access.length > 0 ? { storageState: { cookies: access, origins: [] } } : {});

  /** The access code (the first time on this engine; then its cookie), then the sign-in form (SCR-TEC-01; CTL-TEC-01-01 to -04). */
  async function signIn(login: string, password: string, options: BrowserContextOptions = {}): Promise<Page> {
    const g = await guardedContext(browser, [origin], { ...PHONE, ...options, ...entered() });
    contexts.push(g.context);
    const p = await g.context.newPage();
    await writeOrigin(p);
    if (access.length === 0) {
      await p.goto(origin + '/', { waitUntil: 'networkidle' });
      await p.fill('#code', code!);
      await p.click('button[data-ctl="CTL-GATE-01-02"]');
      await p.waitForSelector('[data-screen="SCR-GATE-02"]');
      access = (await g.context.cookies()).filter((c) => c.name === 'bw_access');
      expect(access.length, 'the code entry set bw_access').toBe(1);
    }
    await p.goto(origin + '/tech/sign-in', { waitUntil: 'load' });
    expect(await p.locator('.r1-screen').first().getAttribute('data-screen')).toBe('SCR-TEC-01');
    await p.fill('#ts-login', login);
    await p.fill('#ts-password', password);
    await p.click('[data-ctl="CTL-TEC-01-04"]');
    await p.waitForURL('**/tech');
    await p.waitForSelector('[data-screen="SCR-TEC-02"]');
    return p;
  }

  const index = engines.findIndex(([name]) => name === engine);
  let tech = { email: '', id: '', name: '', employee: '' };
  let page: Page;
  let day: Day;

  // why: FR-TECH-1 (F-1020 a) Maria Santos's day on the seed lists in window order, and Harold Jenkins's 10 AM-12 PM job comes after every earlier window (read only)
  it('lists Maria Santos\'s day in window order, Harold Jenkins\'s job after the earlier windows', async () => {
    const p = await signIn(MARIA, await shown(MARIA));
    const d = await dayOf(p);
    const rows = psql(`SELECT j.job_number || '|' || extract(epoch FROM j.window_start)::bigint FROM world.job j JOIN world.technician t ON t.id = j.technician_id
       WHERE t.name = 'Maria Santos' AND j.date = date '2026-09-15' AND j.status <> 'canceled' ORDER BY j.window_start, j.planned_arrival NULLS LAST, j.job_number`)
      .split('\n').filter(Boolean).map((l) => l.split('|').map(Number) as [number, number]);
    expect(d.jobs.map((j) => j.jobNumber)).toEqual(rows.map(([n]) => n));
    const harold = d.jobs.findIndex((j) => j.customer.name === 'Harold Jenkins');
    expect(harold, 'Harold Jenkins is on Maria\'s day').toBeGreaterThan(0);
    const starts = new Map(rows);
    const his = starts.get(d.jobs[harold]!.jobNumber)!;
    for (const j of d.jobs.slice(0, harold)) expect(starts.get(j.jobNumber)!, `job ${j.jobNumber} starts no later than Harold's`).toBeLessThanOrEqual(his);
    const shownJobs = await p.locator('.list [data-job]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-job'))));
    expect(shownJobs).toEqual(rows.map(([n]) => n));
  }, 120_000);

  // why: FR-TECH-1, FR-TECH-12, FR-DEMO-1, FR-AUTH-11 the technician signs in on SCR-TEC-01 and Today lists the day in window order with the van and the progress, the demo time in the header and no strip above it
  it('signs in and lists the day in order with the van, the progress and the demo time in the header', async () => {
    const all = candidates();
    expect(all.length, 'technicians with 2 scheduled jobs on Sep 15').toBeGreaterThan(index);
    tech = all[index]!;
    // FR-AUTH-11 (F-1020 e): the first engine signs in by employee number, the others by email
    page = await signIn(index === 0 && tech.employee !== '' ? tech.employee : tech.email, await shown(tech.email));
    day = await dayOf(page);
    expect(day.date).toBe('2026-09-15');
    expect(day.jobs.length).toBeGreaterThanOrEqual(2);
    // The rows on the screen are the day's jobs in the API's order (window, then planned arrival).
    const shownJobs = await page.locator('.list [data-job]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-job'))));
    expect(shownJobs).toEqual(day.jobs.map((j) => j.jobNumber));
    const head = (await page.locator('[data-ctl="CTL-TEC-02-10"]').textContent()) ?? '';
    expect(head).toContain(`Van ${day.van?.number}`);
    expect(head).toMatch(new RegExp(`0 of ${day.jobs.length} done`));
    // FR-DEMO-1, F-938: the header shows the demo time, and no demo strip sits above it.
    await expect.poll(() => page.locator('.apphead [data-ctl="CTL-CMP-01-01"] b').textContent()).toMatch(/^Tue, Sep 15, \d{1,2}:\d{2} (AM|PM) EDT$/);
    // the header label reads Demo clock (F-1020 f)
    expect(await page.locator('.apphead [data-ctl="CTL-CMP-01-01"]').textContent()).toMatch(/^\s*Demo clock\s/);
    expect(await page.locator('.r1-demobar').count()).toBe(0);
  });

  // why: FR-TECH-1 (F-980) the Today page embeds API-100 and carries X-Bw-Server-State, so the service worker (src/tech/sw.js, proven in sw.test.ts) never keeps it; its shell variant (?bw-shell=1) holds no read and no mark
  it('marks the Today page as holding an API read, and serves its shell variant with none', async () => {
    const full = await page.request.get(origin + '/tech');
    expect(full.status()).toBe(200);
    expect(full.headers()['x-bw-server-state']).toBe('1');
    const surname = day.jobs[0]!.customer.name.split(' ').pop()!;
    expect(await full.text()).toContain(surname);
    const shell = await page.request.get(origin + '/tech?bw-shell=1');
    expect(shell.status()).toBe(200);
    expect(shell.headers()['x-bw-server-state']).toBeUndefined();
    const html = await shell.text();
    for (const j of day.jobs) expect(html, 'the shell holds no customer').not.toContain(j.customer.name);
    // The sign-in page embeds no read and carries no mark.
    expect((await page.request.get(origin + '/tech/sign-in')).headers()['x-bw-server-state']).toBeUndefined();
  }, 120_000);

  // why: FR-TECH-2 On my way sends the on-the-way text only after the confirm step: the sheet sends nothing, Cancel changes nothing, Send makes the job On the way and 1 text
  it('sends the on-the-way text only after the confirm step', async () => {
    const next = day.jobs[0]!;
    // The customer takes texts, so the server has a text to send.
    psql(`UPDATE world.customer SET texts_on = true, mobile = '(614) 555-0143' WHERE id = (SELECT customer_id FROM world.job WHERE job_number = ${next.jobNumber})`);
    const texts = () => Number(psql(`SELECT count(*) FROM world.outbox_text WHERE job_number = ${next.jobNumber} AND kind = 'on_the_way'`));
    expect(texts()).toBe(0);
    await page.locator('[data-ctl="CTL-TEC-02-04"]').click();
    await page.waitForSelector('[data-dialog="SCR-TEC-03"]');
    expect(await page.evaluate('document.activeElement?.getAttribute("data-ctl")')).toBe('CTL-TEC-03-03'); // Cancel holds the first focus
    // The sheet shows the text as it will go out.
    await expect.poll(() => page.locator('[data-ctl="CTL-TEC-03-04"] .bubble').textContent()).toContain('is on the way!');
    await sleep(2000);
    expect(texts(), 'the sheet alone sends nothing').toBe(0);
    expect(jobStatus(next.jobNumber)).toBe('scheduled');
    await page.locator('[data-ctl="CTL-TEC-03-03"]').click();
    await page.waitForSelector('[data-dialog="SCR-TEC-03"]', { state: 'detached' });
    await sleep(1500);
    expect(texts(), 'Cancel sends nothing').toBe(0);
    await page.locator('[data-ctl="CTL-TEC-02-04"]').click();
    await page.locator('[data-ctl="CTL-TEC-03-02"]').click();
    await page.waitForSelector('[data-dialog="SCR-TEC-03"]', { state: 'detached' });
    await until('the job to be On the way', () => jobStatus(next.jobNumber) === 'on_the_way');
    await until('the text', () => texts() === 1);
    expect(psql(`SELECT body FROM world.outbox_text WHERE job_number = ${next.jobNumber} AND kind = 'on_the_way'`)).toContain('is on the way!');
    await expect.poll(() => page.locator('.next .chip').textContent()).toContain('On the way');
  }, 180_000);

  // why: FR-TECH-12, FR-TECH-9 Arrived then No one home ends the visit and it shows in the no-one-home report's source (FR-REP-2)
  it('records Arrived and then No one home: the visit ends and the report counts it', async () => {
    const next = day.jobs[0]!;
    // FR-TECH-9 (F-1020 c): the manager's reads before the visit, through the API: API-50's no-one-home count and API-23's job detail.
    // A manager session is a row of its own (no sign-in: the API-01 and API-03 limits are spent by the sign-ins above), read in a context that shares the code's cookie.
    const dana = randomBytes(32).toString('base64url');
    psql(`INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
          SELECT sha256(convert_to('${dana}', 'UTF8')), u.id, 'web', 'password', false, now(), now(), now() + interval '8 hours'
          FROM world."user" u WHERE u.email = 'dana.ruiz@brightwater.example'`);
    const g = await guardedContext(browser, [origin], { ...PHONE, ...entered() });
    contexts.push(g.context);
    await g.context.addCookies([{ name: 'bw_session', value: dana, url: origin }]);
    interface ManagerRead { noOneHome: { count: number }[]; job: { status: string; noOneHome: { by: string | null; at: string } | null } }
    const manager = async (path: string) => {
      const r = await g.context.request.get(`${origin}/api/v1${path}`);
      expect(r.status(), path).toBe(200);
      return ((await r.json()) as { data: ManagerRead }).data;
    };
    // The report's default range ends at the last whole week (F-1157), so the live visit's week, the demo week of Sep 14, is asked for.
    const nohCount = async () => ((await manager('/reports?toWeek=2026-09-14')).noOneHome as { count: number }[]).reduce((n, w) => n + w.count, 0);
    const nohBefore = await nohCount();
    expect((await manager(`/jobs/${next.jobNumber}`)).job.noOneHome, 'the office job detail shows no outcome yet').toBeNull();
    await page.locator('[data-ctl="CTL-TEC-02-05"]').click();
    await page.waitForSelector('[data-dialog="SCR-TEC-13"]');
    await page.locator('[data-ctl="CTL-TEC-13-02"]').click();
    await until('the job to be On site', () => jobStatus(next.jobNumber) === 'on_site');
    await page.locator('[data-ctl="CTL-TEC-02-09"]').click();
    await page.waitForSelector('[data-dialog="SCR-TEC-14"]');
    expect(await page.locator('[data-ctl="CTL-TEC-14-01"]').first().textContent()).toContain('no one was home');
    await page.locator('[data-ctl="CTL-TEC-14-02"]').click();
    await until('the visit to end', () => jobStatus(next.jobNumber) === 'no_one_home');
    expect(psql(`SELECT count(*) FROM world.report_visit WHERE job_number = ${next.jobNumber} AND outcome = 'no_one_home'`)).toBe('1');
    expect(psql(`SELECT ended_at IS NOT NULL FROM world.job WHERE job_number = ${next.jobNumber}`)).toBe('t');
    expect(await nohCount(), 'API-50 counts the visit').toBe(nohBefore + 1);
    const shownByOffice = (await manager(`/jobs/${next.jobNumber}`)).job;
    expect(shownByOffice.status).toBe('no_one_home');
    expect(shownByOffice.noOneHome, 'the office job detail shows who recorded it and when').toMatchObject({ by: expect.any(String), at: expect.any(String) });
    await expect.poll(() => page.locator('.done[data-job="' + next.jobNumber + '"] .t').textContent(), { timeout: 60_000 }).toContain('No one home');
    expect(Number(psql(`SELECT count(*) FROM world.outbox_text WHERE job_number = ${next.jobNumber} AND kind = 'on_the_way' AND status <> 'canceled'`)), 'no further text after No one home').toBeLessThanOrEqual(1);
    // FR-TECH-12 (F-1020 b): the header's first number rose to 1, and stays 1 with no signal
    const progressText = () => page.locator('[data-ctl="CTL-TEC-02-10"]').textContent();
    await expect.poll(progressText, { timeout: 60_000 }).toMatch(new RegExp(`1 of ${day.jobs.length} done`));
    await page.context().setOffline(true);
    try {
      await expect.poll(progressText, { timeout: 30_000 }).toMatch(new RegExp(`1 of ${day.jobs.length} done`));
    } finally {
      await page.context().setOffline(false);
    }
  }, 180_000);

  // why: FR-TEXT-4 a job On the way that the office reassigns reads Scheduled in the new technician's API-100 (owner ruling d0c0a033, "Back to Scheduled"; F-566)
  it('reads a reassigned On the way job as Scheduled in the new technician\'s API-100', async () => {
    const moving = day.jobs[1]!;
    psql(`UPDATE world.job SET status = 'on_the_way', on_the_way_at = now() WHERE job_number = ${moving.jobNumber}`);
    // The office actor: Keisha T. through Sign in as (API-05; see Rate limits above), with the code's cookie.
    const keisha = await (async () => {
      const g = await guardedContext(browser, [origin], { ...PHONE, ...entered() });
      contexts.push(g.context);
      const k = await g.context.newPage();
      await writeOrigin(k);
      await k.goto(origin + '/sign-in', { waitUntil: 'load' });
      const personId = psql(`SELECT id FROM world."user" WHERE email = '${KEISHA}'`);
      const status = await k.evaluate(async (id) => (await fetch('/api/v1/demo/sessions', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ personId: id, keepSignedIn: false }),
      })).status, personId);
      expect(status, 'Keisha T. signed in through Sign in as').toBe(200);
      return k;
    })();
    const version = Number(psql(`SELECT version FROM world.job WHERE job_number = ${moving.jobNumber}`));
    // Try each other Columbus technician until the office's own rules accept the move.
    const others = psql(`SELECT u.email || '|' || t.id FROM world.technician t JOIN world."user" u ON u.id = t.user_id WHERE t.branch_id = 'columbus' AND u.status = 'active' AND t.id <> '${tech.id}' ORDER BY t.name`).split('\n').filter(Boolean);
    let target: string | null = null;
    for (const line of others) {
      const [email, id] = line.split('|') as [string, string];
      const status = await keisha.evaluate(async ([n, tid, v]) => (await fetch(`/api/v1/jobs/${n}/assignment`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ technicianId: tid, baseVersion: v }),
      })).status, [moving.jobNumber, id, version] as const);
      if (status === 200) {
        target = email;
        break;
      }
    }
    expect(target, 'a technician the office can move the job to').not.toBeNull();
    expect(jobStatus(moving.jobNumber)).toBe('scheduled');
    const newTech = await signIn(target!, await shown(target!));
    const theirs = await dayOf(newTech);
    expect(theirs.jobs.find((j) => j.jobNumber === moving.jobNumber)?.status).toBe('scheduled');
    expect((await dayOf(page)).jobs.find((j) => j.jobNumber === moving.jobNumber)).toBeUndefined();
  }, 240_000);

  // why: FR-AUTH-9 (F-616) SCR-EML-02's landing /tech/sign-in?set=1 says the password is set, and Forgot password opens the technician flow
  it('lands a saved password on SCR-TEC-01 and links Forgot password to the technician flow', async () => {
    const g = await guardedContext(browser, [origin], { ...PHONE, ...entered() });
    contexts.push(g.context);
    const p = await g.context.newPage();
    const res = await p.goto(origin + '/tech/sign-in?set=1', { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    expect(await p.locator('.msg.info').textContent()).toContain('Your password is set. Sign in.');
    expect(await p.locator('[data-ctl="CTL-TEC-01-07"]').getAttribute('href')).toBe('/forgot-password?app=tech');
    // Stay signed in is off by default (CTL-TEC-01-08).
    expect(await p.locator('[data-ctl="CTL-TEC-01-08"]').isChecked()).toBe(false);
  }, 120_000);

  // why: FR-TECH-1 (F-252 item 7, F-278) the reviewer sample user, a technician with no technician row, signs in and meets an empty day, not an error
  it('shows the reviewer sample user an empty day, not an error', async () => {
    const p = await signIn('reviewer@brightwater.example', reviewerPassword!);
    await p.waitForSelector('.r1p-empty');
    expect(await p.locator('.r1p-empty').textContent()).toContain('You have no jobs today.');
    expect(await p.locator('.r1-errpanel').count()).toBe(0);
    expect((await dayOf(p)).jobs).toEqual([]);
  }, 120_000);

  /** A context and page of its own (no cookie unless `options` gives one), the page's scripts held from the first address it opens. */
  async function held(options: BrowserContextOptions = {}) {
    const g = await guardedContext(browser, [origin], { ...PHONE, ...options });
    contexts.push(g.context);
    const p = await g.context.newPage();
    await writeOrigin(p);
    const opened = addresses(p);
    const scripts = await holdScripts(p);
    scripts.hold();
    return { p, opened, scripts };
  }

  // why: FR-AUTH-6 (F-1037) the access code typed and Enter tapped before the gate's script has run opens the page on that 1st tap: React holds the tap and sends it once the page hydrates, and the code never goes into the address
  it('enters the access code on a tap made before the gate has hydrated', async () => {
    const { p, opened, scripts } = await held();
    await p.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    await p.fill('#code', code!);
    await p.click('button[data-ctl="CTL-GATE-01-02"]');
    expect(scripts.pending(), 'the page scripts are still held at the tap').toBeGreaterThan(0);
    scripts.release();
    await p.waitForSelector('[data-screen="SCR-GATE-02"]');
    expect(opened.filter(carriesField), 'no address carried a form field').toEqual([]);
  }, 120_000);

  // why: FR-AUTH-6 (F-1037) the access code typed before the gate's script has run is still in the field after the page hydrates, and Enter then sends it
  it('keeps the access code typed before the gate hydrated, and Enter sends it', async () => {
    const { p, opened, scripts } = await held();
    await p.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    await p.fill('#code', code!);
    expect(scripts.pending(), 'the page scripts are still held while the code is typed').toBeGreaterThan(0);
    // The footer asks API-02 from an effect, which runs only once the gate has hydrated.
    const hydrated = p.waitForRequest((r) => new URL(r.url()).pathname === '/api/v1/app-info');
    scripts.release();
    await hydrated;
    expect((await p.inputValue('#code')).length, 'the typed code is still in the field').toBe(code!.length);
    await p.click('button[data-ctl="CTL-GATE-01-02"]');
    await p.waitForSelector('[data-screen="SCR-GATE-02"]');
    expect(opened.filter(carriesField), 'no address carried a form field').toEqual([]);
  }, 120_000);

  // why: FR-AUTH-11 (F-1037) a technician who types the sign-in fields and taps Sign in before SCR-TEC-01's script has run is signed in on that 1st tap and lands on Today: React holds the tap and sends it once the page hydrates, and neither field goes into the address
  it('signs a technician in on a tap made before SCR-TEC-01 has hydrated', async () => {
    const { p, opened, scripts } = await held();
    await p.goto(origin + '/tech/sign-in', { waitUntil: 'domcontentloaded' });
    await p.fill('#ts-login', MARIA);
    await p.fill('#ts-password', await shown(MARIA));
    await p.click('[data-ctl="CTL-TEC-01-04"]');
    expect(scripts.pending(), 'the page scripts are still held at the tap').toBeGreaterThan(0);
    scripts.release();
    await p.waitForURL('**/tech');
    await p.waitForSelector('[data-screen="SCR-TEC-02"]');
    expect(opened.filter(carriesField), 'no address carried a form field').toEqual([]);
  }, 120_000);

  // why: FR-AUTH-9 (F-1037) the technician flow's Forgot password (CTL-TEC-01-07), typed and sent before SCR-EML-03's script has run, answers on that 1st tap, and the email never goes into the address
  it('answers Forgot password sent before SCR-EML-03 has hydrated', async () => {
    const { p, opened, scripts } = await held(entered());
    await p.goto(origin + '/forgot-password?app=tech', { waitUntil: 'domcontentloaded' });
    await p.fill('#fp-email', 'nobody@brightwater.example');
    await p.click('[data-ctl="CTL-EML-03-02"]');
    expect(scripts.pending(), 'the page scripts are still held at the tap').toBeGreaterThan(0);
    scripts.release();
    await p.waitForSelector('[data-ctl="CTL-EML-03-03"] > *');
    expect(opened.filter(carriesField), 'no address carried a form field').toEqual([]);
  }, 120_000);
});
