// SPDX-License-Identifier: AGPL-3.0-or-later
// The technician pages the service worker keeps for an open with no signal (F-1083; SPECIFICATIONS SD-47; FR-TECH-4, FR-TECH-10): every
// page the app links to during the day, so a page never opened before (Add note, Add photo, a tab) opens with no signal from what the phone
// holds. Every technician screen sends this list once the day is on the phone ({type: 'fill'}, src/tech/TechAppFrame.tsx), and the worker
// keeps each page it has not kept under this build, with its files (src/tech/sw.js fill). A /tech page opened only with signal is listed in
// ONLINE_ONLY with why; with no signal and no kept copy, the worker answers it with the app's no-signal page. offline-pages.test.ts holds
// every route of app/tech and every /tech link in src/tech to these lists, so a new screen or link cannot be left out.
import type { ClientT } from '../shell/intl.tsx';

/** The pages of the day that hold no job: Today (with its confirm sheets, /tech?sheet=...), the Map, Parts and Me tabs, Waiting to send. */
export const DAY_PAGES = ['/tech', '/tech/map', '/tech/parts', '/tech/me', '/tech/waiting'] as const;

/** A job's pages after /tech/jobs/{n}: the job (SCR-TEC-04), Add note, Add photo, Finish, Directions (its ?from= shares the page). */
export const JOB_PAGES = ['', '/note', '/photo', '/finish', '/directions'] as const;

/** The /tech pages opened only with signal, and why. */
export const ONLINE_ONLY: Readonly<Record<string, string>> = {
  '/tech/sign-in': 'signing in needs the server; the app opens it after the server ends the session or answers a sign-out',
  '/tech/install': 'the install guide, opened in the browser before the app is on the home screen',
};

/** The worker's own files under /tech (src/tech/shell-assets.ts): not pages. */
export const WORKER_FILES = ['/tech/sw.js', '/tech/manifest.webmanifest', '/tech/icons/icon-180.png', '/tech/icons/icon-192.png', '/tech/icons/icon-512.png'] as const;

/** More jobs than a day holds are left out, so a message to the worker stays small. */
const MAX_JOBS = 40;
const JOB_MAX = 2_147_483_647;

/** The pages the phone keeps for the day: the day's own pages, then each job's pages, each once. The caller lists the day's jobs, then every job with an item waiting (F-1099). */
export function offlinePages(jobNumbers: readonly number[]): string[] {
  const jobs = [...new Set(jobNumbers.filter((n) => Number.isInteger(n) && n > 0 && n <= JOB_MAX))].slice(0, MAX_JOBS);
  return [...DAY_PAGES, ...jobs.flatMap((n) => JOB_PAGES.map((p) => `/tech/jobs/${n}${p}`))];
}

/** The no-signal page's words in the person's language (the worker draws the page; the catalog holds the words). */
export function noSignalWords(t: ClientT): { lang: string; noSignal: string; notOnPhone: string; screenNotOnPhone: string; back: string } {
  return { lang: t.lang, noSignal: t('tech.sync.noSignal'), notOnPhone: t('tech.job.notOnPhone'), screenNotOnPhone: t('tech.job.screenNotOnPhone'), back: t('tech.job.backToToday') };
}
