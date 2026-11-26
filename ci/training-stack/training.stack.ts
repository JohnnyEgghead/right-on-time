// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DIST-10, SC-04 (BUILD_PLAN P7-TRAINING Acceptance: Playwright runs the 10 tasks of the dispatcher walkthrough from their written steps)
// The dispatcher walkthrough, run from the script file itself. The steps are read from docs/public/walkthrough.md (ci/training-stack/walkthrough-steps.ts):
// this file holds no copy of a step, only what each verb does on a page. A step that names a control the app does not show fails the task (the
// control is waited for, then reported with the words that were asked for). Driven only through the copy's own address, as ci/e2e-stack/e2e.stack.ts:
// no docker and no SQL. Settings:
//   BW_TRAINING_BASE_URL   the copy's address (required)
//   BW_TRAINING_SEED       the copy's SAMPLE_PASSWORD_SEED: the sample people's passwords derive from it (or give BW_TRAINING_PASSWORD_KEISHA, _DANA)
// The 10 tasks run in order on each engine, in a fresh world (the clock page's Reset when the world is not at Tue, Sep 15, 7:00 AM). The dispatcher is
// Keisha T. (office role); Dana Ruiz (manager) only resets the world for a second engine.
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext, type GuardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { readWalkthrough, type Step, type Task } from './walkthrough-steps.ts';

const base = process.env.BW_TRAINING_BASE_URL;
if (!base) throw new Error("BW_TRAINING_BASE_URL is not set: run ci/training-stack.sh, or set it to the copy's address");
const origin = new URL(base).origin;

const PEOPLE = {
  dana: 'dana.ruiz@brightwater.example',
  keisha: 'keisha.t@brightwater.example',
} as const;
type Who = keyof typeof PEOPLE;
async function passwordOf(who: Who): Promise<string> {
  const given = process.env[`BW_TRAINING_PASSWORD_${who.toUpperCase()}`];
  if (given) return given;
  const seed = process.env.BW_TRAINING_SEED;
  if (!seed) throw new Error(`no password for ${who}: set BW_TRAINING_SEED or BW_TRAINING_PASSWORD_${who.toUpperCase()}`);
  const { samplePassword, showSamplePassword } = await import('../../packages/db/src/passwords.ts');
  return showSamplePassword(samplePassword(seed, PEOPLE[who]));
}

const DESKTOP = { viewport: { width: 1440, height: 900 }, timezoneId: 'America/New_York' };
const WAIT_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, read: () => Promise<T> | T, cond: (v: T) => boolean, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (cond(last)) return last;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last read: ${JSON.stringify(last).slice(0, 400)}`);
    await sleep(500);
  }
}
const clockOf = async (ctx: BrowserContext) => {
  const r = await ctx.request.fetch(`${origin}/api/v1/clock`);
  return ((await r.json()) as { data: { demoNow: string; paused: boolean; replay: { running: boolean }; resetAvailableInSeconds: number } }).data;
};

/** The world must start at Tue, Sep 15, 7:00 AM: a fresh copy does; a second engine's run resets it first through the clock page. */
let worldUsed = process.env.BW_TRAINING_DIRTY === '1'; // BW_TRAINING_DIRTY=1: the copy was used before this run, so reset it first
async function freshWorld(browser: Browser): Promise<void> {
  // The first run takes a fresh copy as it is when the clock reads 7:0x. Every later run resets: the clock still reads 7:0x minutes after a run, but the world is no longer the sample world.
  const mustReset = worldUsed;
  worldUsed = true;
  const signIn = async () => {
    const g = await guardedContext(browser, [origin], DESKTOP);
    const page = await g.context.newPage();
    await page.goto(`${origin}/sign-in`, { waitUntil: 'load' });
    await page.fill('#si-email', PEOPLE.dana);
    await page.fill('#si-password', await passwordOf('dana'));
    await page.click('[data-ctl="CTL-OFC-01-04"]');
    await page.waitForURL('**/office/board', { timeout: 60_000 });
    return { g, page };
  };
  const dana = await signIn();
  try {
    const c0 = await clockOf(dana.g.context);
    if (!mustReset && c0.demoNow.startsWith('2026-09-15T07:0') && !c0.paused && !c0.replay.running) return;
    await dana.page.goto(`${origin}/office/admin/clock`, { waitUntil: 'load' });
    await dana.page.waitForSelector('[data-ctl="CTL-OFC-17-01"]');
    // The reset has a cool-down (FR-DEMO-6): wait it out rather than fail on it.
    await until('the reset cool-down to end', () => clockOf(dana.g.context), (c) => c.resetAvailableInSeconds === 0 && !c.replay.running, 600_000);
    await dana.page.locator('[data-ctl="CTL-OFC-17-06"]').click();
    await dana.page.locator('button[data-ctl="CTL-OFC-27-02"]').click();
  } finally {
    await dana.g.context.close();
  }
  const again = await signIn();
  try {
    await until('the world to be back at Tue, Sep 15, 7:00 AM and running', () => clockOf(again.g.context), (c) => c.demoNow.startsWith('2026-09-15T07:0') && !c.paused && !c.replay.running, 240_000);
  } finally {
    await again.g.context.close();
  }
}

/** Where a step looks: the open dialog when there is one (its buttons shadow the page's), else the page. */
async function scopeOf(page: Page): Promise<Page | Locator> {
  const dialogs = page.locator('[role="dialog"]:visible');
  return (await dialogs.count()) > 0 ? dialogs.last() : page;
}
const KINDS = ['button', 'link', 'tab', 'radio'] as const;
/** The control the written words name: the exact name first, then a name that holds the words (a board block reads "Harold Jenkins Furnace tune-up"). null when none shows now. */
async function findControl(page: Page, name: string, kinds: readonly (typeof KINDS)[number][] = KINDS): Promise<Locator | null> {
  const root = await scopeOf(page);
  for (const exact of [true, false]) {
    for (const kind of kinds) {
      const l = root.getByRole(kind, { name, exact });
      if ((await l.count()) > 0) return l.first();
    }
  }
  return null;
}
async function control(page: Page, name: string, kinds?: readonly (typeof KINDS)[number][]): Promise<Locator> {
  let found: Locator | null = null;
  const end = Date.now() + WAIT_MS;
  while (!(found = await findControl(page, name, kinds)) && Date.now() < end) await sleep(300);
  if (!found) throw new Error(`the walkthrough names a control that is not on the screen: "${name}" (looked for a ${(kinds ?? KINDS).join(', ')} with that name)`);
  return found;
}

const HOUR_X = 8;
/** Typing before React has hydrated the box fills it without the page hearing it (WebKit is quick enough to do this): wait until the box is wired. */
async function hydrated(field: Locator): Promise<void> {
  await field.evaluate((el) => new Promise<void>((done) => {
    const wired = () => Object.keys(el).some((k) => k.startsWith('__reactProps'));
    const t = setInterval(() => { if (wired()) { clearInterval(t); done(); } }, 50);
    setTimeout(() => { clearInterval(t); done(); }, 10_000);
  }));
}
/** What a time box reads back for the text a person types: "01:00:P" and "1:00:P" are 1:00 PM, which reads 13:00; "13:00" reads 13:00. */
function timeValue(text: string): string {
  const m = /^(\d{1,2}):(\d\d)(?::([AaPp]))?/.exec(text);
  if (!m) throw new Error(`the step types "${text}" in a time box, and that is not a time`);
  const pm = m[3]?.toUpperCase() === 'P';
  const h = (Number(m[1]) % 12) + (pm ? 12 : 0);
  return `${String(m[3] ? h : Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

async function run(page: Page, step: Step, who: Who): Promise<void> {
  switch (step.verb) {
    case 'go':
      await page.goto(`${origin}${step.path}`, { waitUntil: 'load' });
      return;
    case 'click': {
      if (step.beside) {
        const root = await scopeOf(page);
        const row = root.locator('*').filter({ hasText: step.beside }).filter({ has: page.getByRole('button', { name: step.name, exact: true }) }).last();
        await row.getByRole('button', { name: step.name, exact: true }).waitFor({ timeout: WAIT_MS }).catch(() => {
          throw new Error(`the walkthrough names a control that is not on the screen: "${step.name}" beside "${step.beside}"`);
        });
        await row.getByRole('button', { name: step.name, exact: true }).click();
        return;
      }
      const button = await control(page, step.name);
      // A gray button does nothing when clicked and says no reason: a person sees it, so the run fails on it here, not 1 step later.
      if ((await button.getAttribute('aria-disabled')) === 'true') throw new Error(`the button "${step.name}" is gray (not ready) when the step clicks it`);
      await button.click();
      return;
    }
    case 'clickhour': {
      // The hour is the first number of a time box. A click on the left end of the box lands on it in Chromium and in WebKit; a click on the minute leaves the box empty (F-1966, F-1995).
      const root = await scopeOf(page);
      const field = root.getByLabel(step.field, { exact: true });
      await field.first().waitFor({ timeout: WAIT_MS }).catch(() => {
        throw new Error(`the walkthrough names a box that is not on the screen: "${step.field}"`);
      });
      await hydrated(field.first());
      const box = await field.first().boundingBox();
      if (!box) throw new Error(`the box "${step.field}" has no place on the screen`);
      await field.first().click({ position: { x: HOUR_X, y: box.height / 2 } });
      return;
    }
    case 'pick':
      await (await control(page, step.name, ['radio', 'button'])).click();
      return;
    case 'see':
      await until(`the screen to show "${step.text}"`, () => page.locator('body').innerText(), (t) => t.replace(/\s+/g, ' ').includes(step.text), WAIT_MS).catch(() => {
        throw new Error(`the screen does not show "${step.text}"`);
      });
      return;
    case 'type': {
      const text = step.value.kind === 'email' ? PEOPLE[who] : step.value.kind === 'password' ? await passwordOf(who) : step.value.text;
      const root = await scopeOf(page);
      const field = root.getByLabel(step.field, { exact: true });
      await field.first().waitFor({ timeout: WAIT_MS }).catch(() => {
        throw new Error(`the walkthrough names a box that is not on the screen: "${step.field}"`);
      });
      await hydrated(field.first());
      // A time box is typed with the keys a person presses, after the step before it clicked the hour; every other box is filled.
      if ((await field.first().getAttribute('type')) === 'time') {
        await page.keyboard.type(text);
        const want = timeValue(text);
        const got = await field.first().inputValue();
        if (got !== want) throw new Error(`the box "${step.field}" reads "${got}" after typing "${text}", not "${want}"`);
        return;
      }
      await field.first().fill(text);
      return;
    }
    case 'choose': {
      const root = await scopeOf(page);
      const field = root.getByLabel(step.field, { exact: true });
      await field.first().waitFor({ timeout: WAIT_MS }).catch(() => {
        throw new Error(`the walkthrough names a list that is not on the screen: "${step.field}"`);
      });
      await field.first().selectOption({ label: step.name });
      return;
    }
  }
}

// The tasks are read when the file loads, so the test names come from the script too.
const tasks: Task[] = readWalkthrough();

describe.each(engines)('the dispatcher walkthrough on %s', (engine, type) => {
  let browser: Browser;
  let g: GuardedContext;
  let page: Page;

  beforeAll(async () => {
    browser = await type.launch({ headless: true });
    await freshWorld(browser);
    g = await guardedContext(browser, [origin], DESKTOP);
    page = await g.context.newPage();
  }, 900_000);
  afterAll(async () => {
    await g?.context.close();
    await browser?.close();
  });

  // why: FR-DIST-10, SC-04 the run takes its 10 tasks from the written script, not from a copy
  it('reads 10 tasks from the script file', () => {
    expect(tasks.map((t) => t.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  for (const t of tasks) {
    // why: FR-DIST-10, SC-04 each task of the written walkthrough runs step by step on the Compose stack: every screen, control and box it names is on the screen, with the words the app shows
    it(`Task ${t.n}. ${t.title}`, async () => {
      for (const s of t.steps) {
        try {
          await run(page, s.step, 'keisha');
        } catch (e) {
          throw new Error(`Task ${t.n} step ${s.n} (${s.line}): ${(e as Error).message}`);
        }
      }
    });
  }
});
