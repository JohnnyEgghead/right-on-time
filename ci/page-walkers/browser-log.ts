// SPDX-License-Identifier: AGPL-3.0-or-later
// browser-log (F-1130): what the browser said while a case ran, kept when the case fails.
// Every context the outside-origin guard opens (ci/page-walkers/origin-guard.ts, the only way a browser test opens one) gets a recorder:
// its pages' console messages (with their type), page errors, failed requests and HTTP answers of 400 or more, main-frame navigations,
// load events, crashes and closes, each with its time. Nothing is printed and nothing is written while cases pass.
// When a case fails, 1 JSON-lines file is written for it, holding every context open during the case or closed in it:
//   $BW_JUNIT_DIR/browser-logs/<suite>--<case>--<pid>-<n>.jsonl
// BW_JUNIT_DIR is the gate's own folder (.build/junit/<gate id>, set by ci/run-gates.ts); ci/wave-run.sh copies the container's
// .build/junit to the run's out dir (record_test_times), so the file reaches $OUT/junit/<gate id>/browser-logs/. A hand run with no
// BW_JUNIT_DIR writes to .build/junit/local/browser-logs/ (git-ignored). The failing case prints 1 line naming the file.
// The hooks: this module registers a file-level beforeEach and afterEach with vitest when a test file imports it while vitest collects
// that file (a static import of origin-guard.ts does), the same way hooks in a setupFiles module apply to every test of the file.
// Outside vitest (ci/a11y-tools/run-web.ts under plain node, the smoke harness) no hook is registered and the recorders only hold entries.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, ConsoleMessage, Page, Request, Response, WebError } from 'playwright';

/** The most entries 1 context keeps (the oldest are dropped first, and counted). */
export const MAX_ENTRIES = 3000;
/** The longest text an entry keeps. */
const MAX_TEXT = 4000;

export type Entry = {
  /** Order across every recorder of this process. */
  seq: number;
  /** Wall time, ISO 8601 UTC. */
  t: string;
  ctx: number;
  /** The page's number in its context (1 = the first page), 0 when the event names no page. */
  page: number;
  kind: 'console' | 'pageerror' | 'requestfailed' | 'response' | 'navigated' | 'domcontentloaded' | 'load' | 'crash' | 'page-opened' | 'page-closed';
  /** console: the message type (log, error, warning, ...); response: the status; requestfailed: the failure text. */
  type?: string | undefined;
  text?: string | undefined;
  /** The page's URL when the event came. */
  url?: string | undefined;
  /** console: the source location; request entries: method and resource type. */
  at?: string | undefined;
};

export type Recorder = {
  id: number;
  label: string;
  openedAt: string;
  closedAt?: string;
  entries: Entry[];
  dropped: number;
};

let seq = 0;
let nextRecorder = 0;
const open = new Set<Recorder>();
let closedInCase: Recorder[] = [];
let caseStartedAt = '';
let written = 0;

const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}... (${s.length} chars)` : s);
const now = (): string => new Date().toISOString();

function push(r: Recorder, e: Omit<Entry, 'seq' | 't' | 'ctx'>): void {
  r.entries.push({ seq: ++seq, t: now(), ctx: r.id, ...e, ...(e.text === undefined ? {} : { text: clip(e.text) }) });
  if (r.entries.length > MAX_ENTRIES) {
    r.entries.shift();
    r.dropped += 1;
  }
}

/** The minimal event surface a recorder listens on (a Playwright BrowserContext; a fake in the unit test). */
type ContextLike = Pick<BrowserContext, 'on' | 'pages'>;

/**
 * Record what `context`'s pages say until it closes (its close event: context.close() resolves after it, and it also comes when the
 * browser is closed first). A context closed during a case stays in that case's log.
 */
export function recordContext(context: ContextLike, label: string): Recorder {
  const r: Recorder = { id: ++nextRecorder, label, openedAt: now(), entries: [], dropped: 0 };
  const pageNo = new WeakMap<Page, number>();
  let pages = 0;
  const num = (p: Page | null | undefined): number => (p ? (pageNo.get(p) ?? 0) : 0);
  const urlOf = (p: Page | null | undefined): string | undefined => {
    try {
      return p ? p.url() : undefined;
    } catch {
      return undefined;
    }
  };
  const watch = (p: Page) => {
    if (pageNo.has(p)) return;
    pageNo.set(p, ++pages);
    push(r, { page: num(p), kind: 'page-opened', url: urlOf(p) });
    p.on('framenavigated', (f) => {
      if (f === p.mainFrame()) push(r, { page: num(p), kind: 'navigated', url: f.url() });
    });
    p.on('domcontentloaded', () => push(r, { page: num(p), kind: 'domcontentloaded', url: urlOf(p) }));
    p.on('load', () => push(r, { page: num(p), kind: 'load', url: urlOf(p) }));
    p.on('crash', () => push(r, { page: num(p), kind: 'crash', url: urlOf(p) }));
    p.on('close', () => push(r, { page: num(p), kind: 'page-closed' }));
  };
  for (const p of context.pages()) watch(p);
  context.on('page', watch);
  context.on('console', (m: ConsoleMessage) => {
    const p = m.page();
    const loc = m.location();
    push(r, { page: num(p), kind: 'console', type: m.type(), text: m.text(), url: urlOf(p), at: loc.url ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : undefined });
  });
  context.on('weberror', (w: WebError) => {
    const p = w.page();
    const e = w.error();
    push(r, { page: num(p), kind: 'pageerror', text: e.stack || `${e.name}: ${e.message}`, url: urlOf(p) });
  });
  const pageOfRequest = (q: Request): Page | null => {
    try {
      return q.frame().page();
    } catch {
      return null; // a service worker's request has no frame
    }
  };
  context.on('requestfailed', (q: Request) => {
    const p = pageOfRequest(q);
    push(r, { page: num(p), kind: 'requestfailed', type: q.failure()?.errorText ?? 'failed', text: q.url(), url: urlOf(p), at: `${q.method()} ${q.resourceType()}` });
  });
  context.on('response', (s: Response) => {
    if (s.status() < 400) return;
    const q = s.request();
    const p = pageOfRequest(q);
    push(r, { page: num(p), kind: 'response', type: String(s.status()), text: s.url(), url: urlOf(p), at: `${q.method()} ${q.resourceType()}` });
  });
  context.on('close', () => {
    if (!open.delete(r)) return;
    r.closedAt = now();
    closedInCase.push(r);
  });
  open.add(r);
  return r;
}

/** Where the failed cases' files go: the gate's junit folder when the gate runner set one, else the local one. */
export function logDir(env: NodeJS.ProcessEnv = process.env): string {
  const junit = env.BW_JUNIT_DIR;
  if (junit) return path.join(junit, 'browser-logs');
  return path.join(fileURLToPath(new URL('../..', import.meta.url)), '.build', 'junit', 'local', 'browser-logs');
}

const slug = (s: string, max: number): string =>
  s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, max) || 'case';

/** The fields of a vitest test task this module reads. */
export type CaseTask = {
  name: string;
  fullTestName?: string;
  file?: { filepath?: string; name?: string };
  result?: { state?: string; errors?: { message?: string }[] };
};

/** The recorders a case saw: every one open now, and every one closed since the case began. */
export function caseRecorders(): Recorder[] {
  return [...closedInCase, ...open].sort((a, b) => a.id - b.id);
}

/** Start a case: its log holds the recorders open now and the ones that open or close from here. */
export function beginCase(): void {
  closedInCase = [];
  caseStartedAt = now();
}

/**
 * End a case: when it failed and saw a recorder, write its file and print 1 line naming it; return the file (null when nothing was
 * written). A passing case writes and prints nothing. Never throws: a write failure is 1 printed line, never a different result.
 */
export function endCase(task: CaseTask, env: NodeJS.ProcessEnv = process.env): string | null {
  const recorders = caseRecorders();
  closedInCase = [];
  if (task.result?.state !== 'fail' || recorders.length === 0) return null;
  const testName = task.fullTestName ?? task.name;
  const suite = path.basename(task.file?.filepath ?? task.file?.name ?? 'suite').replace(/\.ts$/, '');
  const dir = logDir(env);
  const file = path.join(dir, `${slug(suite, 40)}--${slug(testName, 100)}--${process.pid}-${++written}.jsonl`);
  const lines: unknown[] = [
    {
      kind: 'case',
      file: task.file?.filepath ?? task.file?.name,
      test: testName,
      state: task.result.state,
      errors: (task.result.errors ?? []).map((e) => clip(String(e.message ?? e).split('\n')[0] ?? '')),
      caseStartedAt,
      writtenAt: now(),
    },
    ...recorders.map((r) => ({ kind: 'context', ctx: r.id, label: r.label, openedAt: r.openedAt, closedAt: r.closedAt ?? null, entries: r.entries.length, dropped: r.dropped })),
    ...recorders.flatMap((r) => r.entries).sort((a, b) => a.seq - b.seq),
  ];
  const count = lines.length - 1 - recorders.length;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  } catch (e) {
    process.stdout.write(`browser-log: could not keep the browser log of this failed case (${(e as Error).message})\n`);
    return null;
  }
  process.stdout.write(`browser-log: ${count} browser entries of this failed case kept in ${file}\n`);
  return file;
}

// The file-level hooks (see the header). vitest is imported here, not at the top (F-1880): the smoke harness (ci/smoke/smoke-public-tag.sh)
// copies this module into a bare container that has only playwright, where a static import of vitest crashes the harness on load.
// Each hook is wrapped so it can never fail a case.
try {
  const { afterEach, beforeEach } = await import('vitest');
  beforeEach(() => {
    try {
      beginCase();
    } catch {
      // the log is evidence only
    }
  });
  afterEach((context) => {
    try {
      endCase(context.task as unknown as CaseTask);
    } catch {
      // the log is evidence only
    }
  });
} catch (e) {
  // Not collecting a vitest file: plain node or the bare smoke harness (no vitest installed), or a dynamic import while cases run. Under
  // vitest that last one would lose the logs silently, so it says so.
  if (process.env.VITEST) process.stdout.write(`browser-log: no case hooks registered (${(e as Error).message}); a failed case keeps no browser log\n`);
}
