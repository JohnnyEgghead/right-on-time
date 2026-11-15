// SPDX-License-Identifier: AGPL-3.0-or-later
// The pages the service worker keeps for the day (offline-pages.ts; F-1083) against the app itself: every route under app/tech and every
// /tech address the technician screens link to is a page the worker keeps, a page opened only with signal (ONLINE_ONLY), or a worker file.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY_PAGES, JOB_PAGES, noSignalWords, offlinePages, ONLINE_ONLY, WORKER_FILES } from './offline-pages.ts';
import type { ClientT } from '../shell/intl.tsx';

const APP = path.resolve(import.meta.dirname, '../../app/tech');
const SRC = import.meta.dirname;

function files(dir: string, keep: (f: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p, keep) : keep(p) ? [p] : [];
  });
}

/** Each page route of app/tech, a [param] as the job number 1. */
const routes = () => files(APP, (f) => f.endsWith(`${path.sep}page.tsx`)).map((f) => {
  const rel = path.relative(APP, path.dirname(f)).split(path.sep).filter(Boolean).map((s) => (/^\[.+\]$/.test(s) ? '1' : s));
  return ['/tech', ...rel].join('/');
});

/** Each /tech address written in the technician screens (previews and tests left out), a ${...} as 1, with its query and hash dropped. */
function links(): { file: string; href: string }[] {
  const out: { file: string; href: string }[] = [];
  for (const f of files(SRC, (p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !/[Pp]review/.test(path.basename(p)))) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/[`'"](\/tech(?:[/?#][^`'"\s]*)?)[`'"]/g)) out.push({ file: path.basename(f), href: m[1]!.replace(/(\$\{[^}]*\})+/g, '1') });
    // jobHref(n, '<sub>') (job/nav.ts): /tech/jobs/{n} with the sub-page or query after it
    for (const m of text.matchAll(/jobHref\([^,()]+,\s*'([^']*)'\)/g)) out.push({ file: path.basename(f), href: `/tech/jobs/1${m[1]}` });
  }
  return out.map((l) => ({ ...l, href: l.href.replace(/[?#].*$/, '') }));
}

const kept = new Set(offlinePages([1]));
const known = (p: string) => kept.has(p) || p in ONLINE_ONLY || (WORKER_FILES as readonly string[]).includes(p);

describe('the pages kept for the day with no signal (F-1083)', () => {
  // why: F-1083 (W-52) every technician route is kept for the day or named as opened only with signal, so a new screen cannot be left out
  it('names every route under app/tech: kept for the day, or opened only with signal', () => {
    const all = routes();
    expect(all.length).toBeGreaterThanOrEqual(12);
    expect(all.filter((r) => !known(r))).toEqual([]);
    // every page the list keeps, and every page it says opens only with signal, is a route of the app
    expect([...kept].filter((p) => !all.includes(p))).toEqual([]);
    expect(Object.keys(ONLINE_ONLY).filter((p) => !all.includes(p))).toEqual([]);
  });
  // why: F-1083 (W-52) every /tech address a technician screen links to (a link, a move, the tab bar, Today's sheets) opens with no signal
  it('covers every /tech address the technician screens link to', () => {
    const all = links();
    expect(all.length).toBeGreaterThan(30);
    expect(all.filter((l) => l.href.startsWith('/tech/jobs/1/')).map((l) => l.href)).toEqual(expect.arrayContaining(['/tech/jobs/1/note', '/tech/jobs/1/photo', '/tech/jobs/1/finish', '/tech/jobs/1/directions']));
    expect(all.filter((l) => !known(l.href))).toEqual([]);
  });
  // why: F-1083 the list is the day's own pages, then each job of the day's pages, each once, with no address that is not a job
  it('lists the day\'s pages, then each job\'s 5 pages once, and leaves out what is no job number', () => {
    expect(offlinePages([])).toEqual([...DAY_PAGES]);
    const list = offlinePages([24830, 24831, 24830, 0, -3, 1.5, Number.NaN, 2_147_483_648]);
    expect(list).toEqual([...DAY_PAGES, ...JOB_PAGES.map((p) => `/tech/jobs/24830${p}`), ...JOB_PAGES.map((p) => `/tech/jobs/24831${p}`)]);
    expect(offlinePages(Array.from({ length: 60 }, (_, i) => i + 1))).toHaveLength(DAY_PAGES.length + 40 * JOB_PAGES.length);
  });
  // why: F-1083 the worker's no-signal page has the catalog's words in the person's language (UI-SPECIFICATION SCR-TEC-04 Offline, not saved)
  it('gives the no-signal page its words from the catalog in the person\'s language', () => {
    const t = ((k: string) => `<${k}>`) as unknown as ClientT;
    t.lang = 'es';
    expect(noSignalWords(t)).toEqual({ lang: 'es', noSignal: '<tech.sync.noSignal>', notOnPhone: '<tech.job.notOnPhone>', screenNotOnPhone: '<tech.job.screenNotOnPhone>', back: '<tech.job.backToToday>' });
  });
});
