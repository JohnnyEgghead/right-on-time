// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DEMO-5, FR-DEMO-6, FR-DEMO-4, UC-10 (P4-CLOCK Acceptance: Playwright on Chromium and WebKit against the Compose stack)
// UC-10 on the demo clock page against the Compose stack at its default settings (real PostgreSQL 18, real handlers, pbs running, the worker
// started by its real start-up; ACCESS_CODE_ON and DEMO_MODE on as the named settings), after a fresh setup from the image, through its proxy
// and the suites' https front (ci/auth-stack/tls-front.ts), with the outside-origin guard on (the browsers may reach the stack's origin only).
// The web image is the release build: the page is the release route. On each engine, in its own fresh world (ci/clock-ui-stack.sh):
//   1. The visitor enters the access code, signs in as the sample manager (Dana Ruiz) with her sample password, and opens the clock page.
//   2. FIRST ENGINE ONLY (ruling Nov 10, 2026 item 4b; BW_CLOCK_UI_RESET=0 on the later engines): reset the demo world through the page (the suite
//      first makes a clean world dirty with the 6:00 PM preset, F-732) (Keep the world closes the dialog and changes nothing; Reset the world,
//      once the cool-down is over, puts the world back to Tue, Sep 15, 7:00 AM) and the cool-down note follows, and another open page follows the
//      reset (F-646). The later engines (WebKit) do not run Reset, Keep the world, the cool-down or the F-646 follow.
//   3. Two seeded reminders are due that evening, the later job's first once the office moves its customer to Atlantic time; the manager
//      presses the 6:00 PM reminder preset; the worker replays them in due order, each stamped at its own time, each job in the world gets 1
//      reminder event and 1 text (FR-TEXT-2), and the banner on the manager's page and on an office user's page names who moved the clock
//      (FR-DEMO-3, FR-DEMO-6).
//   4. FR-DEMO-5, NFR-08: the Sat, Oct 31 and Sun, Nov 1 presets show EDT and then EST on the clock; the March presets show EST and then EDT.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tlsFront } from '../auth-stack/tls-front.ts';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_CLOCK_UI_URL;
const code = process.env.BW_CLOCK_UI_CODE;
const tls = process.env.BW_CLOCK_UI_TLS;
const seed = process.env.BW_CLOCK_UI_SEED;
const DANA = 'dana.ruiz@brightwater.example';
const KEISHA = 'keisha.t@brightwater.example';
/** A sample person's password in its shown form (SD-9), derived as the stack's seed derives it. */
async function shown(email: string): Promise<string> {
  const { samplePassword, showSamplePassword } = await import('../../packages/db/src/passwords.ts');
  return showSamplePassword(samplePassword(seed!, email));
}
const project = process.env.BW_CLOCK_UI_PROJECT;
if (!base || !code || !seed || !tls || !project) throw new Error('BW_CLOCK_UI_URL, _CODE, _SEED, _TLS and _PROJECT are not set: run ci/clock-ui-stack.sh');
const front = await tlsFront(base, tls);
afterAll(() => front.close());
const origin = front.origin;
const root = path.resolve(import.meta.dirname, '../..');
/** APP_ORIGIN's default (SD-8): a browser write must carry it; the suite's front listens on a free port. */
const APP_ORIGIN = 'http://localhost:8080';
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true };

function run(cmd: string, args: string[], input?: string): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: root, input });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 6).join(' ')} failed (${r.status}): ${(r.stderr || r.stdout).slice(0, 400)}`);
  return r.stdout;
}
const compose = (...args: string[]) => run('docker', ['compose', '-p', project!, '-f', 'infra/compose.yaml', ...args]);
const dbContainer = () => compose('ps', '-a', '-q', 'db').trim();
const psql = (sql: string) => run('docker', ['exec', '-i', dbContainer(), 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 120_000): Promise<void> {
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
      // the page or its context closed while the write was in flight; nothing is waiting for the answer
    }
  });
}

interface ClockBody {
  demoNow: string;
  paused: boolean;
  worldEpoch: number;
  lastMove: { by: string; kind: string; toDemo: string } | null;
  replay: { running: boolean; done: number; total: number };
  resetAvailableInSeconds: number;
}
const clockOf = (p: Page): Promise<ClockBody> =>
  p.evaluate(async () => ((await (await fetch('/api/v1/clock')).json()) as { data: ClockBody }).data);

const bigText = (p: Page) => p.locator('[data-ctl="CTL-OFC-17-01"]');
const resetButton = (p: Page) => p.locator('[data-ctl="CTL-OFC-17-06"]');
const preset = (p: Page, id: string) => p.locator(`button[data-preset="${id}"]`);
// Ruling Nov 10, 2026 item 4b: the Reset flow and its cool-down (which a fresh world also starts at setup, 5 minutes) are tested on the first
// engine's world only; ci/clock-ui-stack.sh sets BW_CLOCK_UI_RESET=0 for the later engines, whose world is fresh and clean at Tue, Sep 15, 7:00 AM.
const resetFlow = process.env.BW_CLOCK_UI_RESET !== '0';
const banner = (p: Page) => p.locator('.r1-demobar [data-ctl="CTL-CMP-02-01"]');

describe.each(engines)('the demo clock page on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    for (const c of contexts) await c.close();
    await browser?.close();
  });

  /** UC-10 step 1 and 2: the access code, then a person from the Sign in as list. */
  async function visitor(who: string, landing: string): Promise<Page> {
    const g = await guardedContext(browser, [origin], DESKTOP);
    contexts.push(g.context);
    const p = await g.context.newPage();
    await writeOrigin(p);
    await p.goto(origin + '/', { waitUntil: 'networkidle' });
    await p.fill('#code', code!);
    await p.click('button[data-ctl="CTL-GATE-01-02"]');
    await p.waitForSelector('[data-screen="SCR-GATE-02"]');
    await p.goto(origin + '/sign-in', { waitUntil: 'networkidle' });
    await p.fill('#si-email', who);
    await p.fill('#si-password', await shown(who));
    await p.click('[data-ctl="CTL-OFC-01-04"]');
    await p.waitForURL('**/office/board');
    // 'load', not networkidle: the page holds the event stream open (EVT-05).
    const res = await p.goto(origin + landing, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    return p;
  }

  // why: UC-10, FR-DEMO-5, FR-DEMO-6 the visitor enters the code, signs in as the sample manager, jumps to 6:00 PM, the due reminders arrive in order, and the banner names who moved the clock
  it('jumps to the 6:00 PM reminder: the due reminders arrive in order and every open banner names the manager', async () => {
    const dana = await visitor(DANA, '/office/admin/clock');
    expect(await dana.locator('.r1-screen').first().getAttribute('data-screen')).toBe('SCR-OFC-17');
    await dana.waitForSelector('[data-ctl="CTL-OFC-17-01"]');
    const keisha = await visitor(KEISHA, '/office/board');

    // Reset the demo world (UC-10, FR-DEMO-4, FR-DEMO-6), first engine only (resetFlow). Every engine's world is fresh, so `dirty` is false here; it
    // is kept as a guard: a world that is not at the day start (an engine run on a reused world) skips the make-dirty step instead of failing.
    const before = await clockOf(dana);
    const dirty = before.demoNow.slice(0, 13) > '2026-09-15T12';
    await resetButton(dana).waitFor();
    // F-732: the reset branch below must run on a clean world too, so a clean world is first made dirty with the 6:00 PM preset (a
    // forward move); then the branch's own assertions (the epoch rose, the notice names 7:00 AM) can only pass if the reset ran.
    if (resetFlow && !dirty) {
      await preset(dana, 'reminder_6pm').waitFor();
      await preset(dana, 'reminder_6pm').click();
      await until('the clock to move off the day start', async () => (await clockOf(dana)).demoNow.slice(0, 13) > '2026-09-15T12');
    }
    // Keep the world: the dialog opens with Keep the world focused, Escape closes it, and nothing changes (CTL-OFC-27-03).
    if (resetFlow && (await resetButton(dana).getAttribute('aria-disabled')) !== 'true') {
      await resetButton(dana).click();
      await dana.waitForSelector('[data-screen="SCR-OFC-27"]');
      expect(await dana.evaluate('document.activeElement?.getAttribute("data-ctl")')).toBe('CTL-OFC-27-03');
      await dana.keyboard.press('Escape');
      await dana.waitForSelector('[data-screen="SCR-OFC-27"]', { state: 'detached' });
      expect((await clockOf(dana)).worldEpoch).toBe(before.worldEpoch);
    }
    if (resetFlow) {
      // The cool-down note counts down; Reset is on again when it is over (a timer in the page, the server's seconds from API-10).
      await until('the Reset button to be on', async () => (await resetButton(dana).getAttribute('aria-disabled')) !== 'true', 420_000);
      // An invited manager signs in by password without the access code and opens the office. The reset erases that account.
      const email = `rita.cole.${engine}@example.test`;
      const invite = await dana.evaluate(async (addr) => {
        const r = await fetch('/api/v1/users/invitations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Rita Cole', email: addr, role: 'manager', branch: 'columbus' }) });
        return { status: r.status, link: ((await r.json()) as { data?: { emailLink?: string } }).data?.emailLink ?? '' };
      }, email);
      expect(invite.status, 'the invite was sent').toBe(201);
      const mg = await guardedContext(browser, [origin], DESKTOP);
      contexts.push(mg.context);
      const mail = await mg.context.newPage();
      await writeOrigin(mail);
      // This browser has not entered the access code: the invite email page is behind it.
      await mail.goto(origin + '/', { waitUntil: 'networkidle' });
      await mail.fill('#code', code!);
      await mail.click('button[data-ctl="CTL-GATE-01-02"]');
      await mail.waitForSelector('[data-screen="SCR-GATE-02"]');
      await mail.goto(new URL(invite.link, origin).toString(), { waitUntil: 'load' });
      await mail.click('[data-ctl="CTL-EML-01-03"]');
      await mail.fill('#sp-password', 'a long made-up password 1');
      await mail.click('[data-ctl="CTL-EML-02-04"]');
      await mail.waitForURL('**/sign-in?set=1');
      await mg.context.close();
      const rg = await guardedContext(browser, [origin], DESKTOP);
      contexts.push(rg.context);
      const rita = await rg.context.newPage();
      await writeOrigin(rita);
      await rita.goto(origin + '/sign-in', { waitUntil: 'networkidle' });
      await rita.fill('#si-email', email);
      await rita.fill('#si-password', 'a long made-up password 1');
      await rita.click('[data-ctl="CTL-OFC-01-04"]');
      await rita.waitForURL('**/office/board');
      await rita.waitForSelector('.r1-demobar');
      // Another visitor with no session and no code: the first visit, which shows no reason.
      const fg = await guardedContext(browser, [origin], DESKTOP);
      contexts.push(fg.context);
      const first = await fg.context.newPage();
      await first.goto(origin + '/', { waitUntil: 'networkidle' });
      await first.waitForSelector('[data-screen="SCR-GATE-01"]');
      expect(await first.locator('[data-reason="world-reset"]').count(), 'a first visit shows no reset reason').toBe(0);
      // F-646: another open page, with a dialog open, follows the reset with no help from its own screen.
      await keisha.locator('button[data-ctl="CTL-CMP-07-06"]').click();
      await keisha.waitForSelector('.r1-alerts[role="dialog"]');
      await keisha.evaluate(() => { (globalThis as unknown as { bwMark: number }).bwMark = 1; });
      await resetButton(dana).click();
      await dana.waitForSelector('[data-screen="SCR-OFC-27"]');
      await dana.click('button[data-ctl="CTL-OFC-27-02"]');
      await dana.waitForSelector('[data-screen="SCR-OFC-27"]', { state: 'detached' });
      await until('the world to be reset', async () => (await clockOf(dana)).worldEpoch > before.worldEpoch);
      expect((await clockOf(dana)).worldEpoch, 'F-732: the reset branch ran').toBeGreaterThan(before.worldEpoch);
      await expect.poll(() => keisha.locator('.bw-toast-host .r1-toast').textContent(), { timeout: 30_000 }).toContain('Nothing was saved.');
      await expect.poll(() => keisha.locator('.r1-demobar [data-ctl="CTL-CMP-02-03"]').textContent(), { timeout: 30_000 }).toContain('Tue, Sep 15, 7:00 AM');
      expect(await keisha.locator('.r1-alerts[role="dialog"]').count()).toBe(0);
      expect(await keisha.evaluate(() => (globalThis as unknown as { bwMark?: number }).bwMark)).toBe(1); // re-mounted, not reloaded
      await expect.poll(async () => (await clockOf(dana)).demoNow.slice(0, 16), { timeout: 60_000 }).toBe('2026-09-15T07:00');
      // The cool-down: Reset is off and the note says so (CTL-OFC-17-06, CTL-OFC-17-08).
      await expect.poll(() => resetButton(dana).getAttribute('aria-disabled'), { timeout: 30_000 }).toBe('true');
      expect(await dana.locator('[data-ctl="CTL-OFC-17-08"]').textContent()).toMatch(/^Next reset allowed in [45] minutes?$/);
      // The world reset notice names the time it was reset to (CTL-CMP-02-03).
      await expect.poll(() => dana.locator('.r1-demobar [data-ctl="CTL-CMP-02-03"]').textContent(), { timeout: 30_000 }).toContain('Tue, Sep 15, 7:00 AM');
      await keisha.reload({ waitUntil: 'load' });
      // The erased account's page lands on the access code screen with the reset's reason; the first visit still shows none.
      await rita.reload({ waitUntil: 'load' });
      await rita.waitForSelector('[data-screen="SCR-GATE-01"]');
      await expect.poll(() => rita.locator('[data-reason="world-reset"]').textContent(), { timeout: 30_000 }).toBe('The demo world was reset to its starting state.');
      await first.reload({ waitUntil: 'networkidle' });
      expect(await first.locator('[data-reason="world-reset"]').count(), 'a first visit still shows no reset reason').toBe(0);
    }
    const start = await clockOf(dana);
    expect(start.demoNow.slice(0, 10)).toBe('2026-09-15');

    // 2 reminders for the evening, the later job due first: the seed planned 1 for each Sep 16 visit at 6:00 PM in the customer's zone (F-652), so
    // the suite writes none. The office moves the later job's customer to Atlantic time on the real zone edit (API-36, FR-TEXT-17), and the planner
    // moves that reminder to 6:00 PM ADT = 5:00 PM EDT.
    const picked = psql(`
      SELECT string_agg(job_number || ' ' || customer_id, ',' ORDER BY job_number) FROM (
        SELECT j.job_number, c.id AS customer_id
          FROM world.job j JOIN world.customer c ON c.id = j.customer_id
         WHERE j.date = date '2026-09-16' AND j.status = 'scheduled' AND c.texts_on AND c.mobile IS NOT NULL AND c.zone = 'America/New_York'
         ORDER BY j.job_number LIMIT 2) p`);
    const [eastern, atlantic] = picked.split(',').map((x) => Number(x.split(' ')[0]));
    expect(eastern && atlantic, `2 scheduled visits on Sep 16 with texting customers: ${picked}`).toBeTruthy();
    const moved = await dana.evaluate(async (id) => (await fetch(`/api/v1/customers/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timeZone: 'America/Halifax' }),
    })).status, picked.split(',')[1]!.split(' ')[1]!);
    expect(moved).toBe(200);
    const planned = psql(`SELECT string_agg(subject || ':' || state || ':' || to_char(due_at AT TIME ZONE 'UTC', 'HH24:MI'), ',' ORDER BY due_at)
                            FROM world.scheduled_event WHERE kind = 'text.reminder' AND subject IN ('${eastern}', '${atlantic}')`);
    expect(planned).toBe(`${atlantic}:due:21:00,${eastern}:due:22:00`);

    // F-917: the moves wait while the reset is unconfirmed by the billing service (SD-12: API-12 answers replay_running until pbs_epoch
    // reaches world_epoch; the worker confirms every 5 s and then lets the clock run). API-10 now says so (F-919: replay.running holds in that window and the
    // presets show off); this wait stays as the regression. Before, the preset showed on and a press in that window was refused ("The clock is still catching up.", measured) and the jump never came.
    await until('the reset to be confirmed and the clock running', async () =>
      psql('SELECT pbs_epoch = world_epoch FROM system.demo_clock WHERE id = 1') === 't' && !(await clockOf(dana)).paused, 60_000);
    // The manager presses the 6:00 PM reminder preset.
    await preset(dana, 'reminder_6pm').waitFor();
    expect(await preset(dana, 'reminder_6pm').getAttribute('aria-disabled')).toBeNull();
    await preset(dana, 'reminder_6pm').click();
    await until('the replay to end with the manager as the last mover', async () => {
      const c = await clockOf(dana);
      return !c.replay.running && c.lastMove?.by === 'Dana Ruiz' && c.lastMove.kind === 'jump';
    });

    // The reminders arrived in due order, each stamped at its own time, not the jump's 6:05 PM.
    const events = psql(`SELECT string_agg(subject || ':' || state || ':' || coalesce(result, '') || ':' || to_char(run_at AT TIME ZONE 'UTC', 'HH24:MI'), ',' ORDER BY due_at)
                           FROM world.scheduled_event WHERE kind = 'text.reminder' AND subject IN ('${eastern}', '${atlantic}')`);
    expect(events).toBe(`${atlantic}:done:sent:21:00,${eastern}:done:sent:22:00`);
    const texts = psql(`SELECT string_agg(job_number || ':' || to_char(created_at AT TIME ZONE 'UTC', 'HH24:MI'), ',' ORDER BY id)
                          FROM world.outbox_text WHERE kind = 'reminder' AND job_number IN (${eastern}, ${atlantic})`);
    expect(texts).toBe(`${atlantic}:21:00,${eastern}:22:00`);
    // FR-TEXT-2, exactly 1 reminder per visit, over every job in the world: the jump left no second event and no second text.
    expect(psql(`SELECT count(*) FROM (SELECT subject FROM world.scheduled_event WHERE kind = 'text.reminder' GROUP BY subject HAVING count(*) > 1) d`)).toBe('0');
    expect(psql(`SELECT count(*) FROM (SELECT job_number FROM world.outbox_text WHERE kind = 'reminder' GROUP BY job_number HAVING count(*) > 1) d`)).toBe('0');

    // The banner names who moved the clock, on the manager's page (the strip and the Last move line) and on the office user's page.
    const want = 'Dana Ruiz moved the clock to Tue, Sep 15, 6:05 PM';
    for (const p of [dana, keisha]) {
      await expect
        .poll(
          async () => {
            await p.evaluate('window.dispatchEvent(new Event("focus"))');
            return (await banner(p).count()) > 0 ? banner(p).textContent() : null;
          },
          { timeout: 30_000, interval: 500 },
        )
        .toBe(want);
      expect(await banner(p).locator('b').textContent()).toBe('Dana Ruiz');
    }
    await expect.poll(() => dana.locator('[data-ctl="CTL-OFC-17-02"]').textContent()).toBe('Last move: Dana Ruiz moved the clock to Tue, Sep 15, 6:05 PM.');
    expect(await bigText(dana).textContent()).toMatch(/^Tue, Sep 15, 2026, 6:\d\d PM EDT\s*Running$/);
    // The preset that was pressed is behind the clock now: it is off with its words (CTL-OFC-17-04).
    await expect.poll(() => preset(dana, 'reminder_6pm').getAttribute('aria-disabled')).toBe('true');
    expect(await preset(dana, 'reminder_6pm').textContent()).toContain('Earlier than the clock. Reset first.');
  });

  // why: FR-DEMO-5 each daylight-saving preset moves the clock to its time and the zone on the clock changes with it (NFR-08)
  it('moves the clock through the daylight-saving presets: EDT on Oct 31, EST on Nov 1, EST on Mar 13 2027, EDT on Mar 14 2027', async () => {
    const dana = await visitor(DANA, '/office/admin/clock');
    const steps: [string, RegExp, string][] = [
      ['sat_oct_31', /^Sat, Oct 31, 2026, 7:00 AM EDT/, '2026-10-31T07:00'],
      ['sun_nov_1', /^Sun, Nov 1, 2026, 5:\d\d PM EST/, '2026-11-01T17:55'],
      ['sat_mar_13_2027', /^Sat, Mar 13, 2027, 7:\d\d AM EST/, '2027-03-13T07:00'],
      ['sun_mar_14_2027', /^Sun, Mar 14, 2027, 7:\d\d AM EDT/, '2027-03-14T07:00'],
    ];
    for (const [id, shown, target] of steps) {
      await until(`the ${id} preset to be on`, async () => (await preset(dana, id).count()) > 0 && (await preset(dana, id).getAttribute('aria-disabled')) === null);
      await preset(dana, id).click();
      await until(`the replay to ${id} to end`, async () => {
        const c = await clockOf(dana);
        return !c.replay.running && c.lastMove?.kind === 'jump' && c.lastMove.toDemo.startsWith(target);
      });
      await expect.poll(() => bigText(dana).textContent(), { timeout: 30_000 }).toMatch(shown);
    }
    // A typed time in the past is refused on the page with no call: the clock only moves forward (CTL-OFC-17-03, FR-DEMO-4).
    await dana.fill('#bw-clock-date', '2027-03-14');
    await dana.fill('#bw-clock-time', '06:00');
    await dana.click('.row3 .btn.primary');
    await dana.waitForSelector('.pp .r1-fmsg');
    expect(await dana.locator('.pp .r1-fmsg').textContent()).toContain('The clock only moves forward. To go back, reset the world.');
    // Pause and Resume stop and restart the clock for everyone (CTL-OFC-17-05).
    await dana.click('[data-ctl="CTL-OFC-17-05"]');
    await expect.poll(async () => (await clockOf(dana)).paused).toBe(true);
    await expect.poll(() => dana.locator('[data-ctl="CTL-OFC-17-05"]').textContent()).toBe('Resume');
    await dana.click('[data-ctl="CTL-OFC-17-05"]');
    await expect.poll(async () => (await clockOf(dana)).paused).toBe(false);
  });
});
