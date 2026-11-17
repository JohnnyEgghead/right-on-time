// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1130
// The browser log every guarded context keeps (ci/page-walkers/browser-log.ts), browser-free: fake contexts and pages stand in for
// Playwright's, so the unit-tests gate runs it. The cases run in order: the hook cases at the end read what the cases before them left.
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beginCase, caseRecorders, endCase, logDir, MAX_ENTRIES, recordContext, type CaseTask } from './browser-log.ts';

class FakePage extends EventEmitter {
  href: string;
  readonly frame = { url: () => this.href };
  constructor(href: string) {
    super();
    this.href = href;
  }
  url() {
    return this.href;
  }
  mainFrame() {
    return this.frame;
  }
  /** A main-frame navigation, as Playwright reports it (framenavigated, then domcontentloaded and load). */
  go(href: string) {
    this.href = href;
    this.emit('framenavigated', this.frame);
    this.emit('domcontentloaded', this);
    this.emit('load', this);
  }
}

class FakeContext extends EventEmitter {
  readonly list: FakePage[] = [];
  pages() {
    return this.list as unknown[];
  }
  newPage(href: string) {
    const p = new FakePage(href);
    this.list.push(p);
    this.emit('page', p);
    return p;
  }
  console(p: FakePage, type: string, text: string) {
    this.emit('console', { page: () => p, type: () => type, text: () => text, location: () => ({ url: `${p.href}/app.js`, lineNumber: 7, columnNumber: 3 }) });
  }
  pageError(p: FakePage, message: string) {
    const e = new Error(message);
    this.emit('weberror', { page: () => p, error: () => e });
  }
  request(p: FakePage, url: string) {
    return { url: () => url, method: () => 'GET', resourceType: () => 'fetch', frame: () => ({ page: () => p }), failure: () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' }) };
  }
  failRequest(p: FakePage, url: string) {
    this.emit('requestfailed', this.request(p, url));
  }
  answer(p: FakePage, url: string, status: number) {
    this.emit('response', { status: () => status, url: () => url, request: () => this.request(p, url) });
  }
}

const record = (c: FakeContext, label = 'webkit') => recordContext(c as unknown as Parameters<typeof recordContext>[0], label);
const task = (state: string, name = 'a case'): CaseTask => ({ name, fullTestName: `suite > ${name}`, file: { filepath: '/w/ci/x-stack/x.stack.ts' }, result: { state, errors: [{ message: 'TimeoutError: page.waitForURL: Timeout 30000ms exceeded.\nmore' }] } });
const readLines = (f: string) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

let junit = '';
const savedJunit = process.env.BW_JUNIT_DIR;
const savedWrite = process.stdout.write.bind(process.stdout);
beforeAll(() => {
  junit = mkdtempSync(path.join(tmpdir(), 'bw-browser-log-'));
  process.env.BW_JUNIT_DIR = junit; // the hook cases below write here, never into the gate's own junit folder
});
afterAll(() => {
  process.stdout.write = savedWrite;
  if (savedJunit === undefined) delete process.env.BW_JUNIT_DIR;
  else process.env.BW_JUNIT_DIR = savedJunit;
  rmSync(junit, { recursive: true, force: true });
});
const files = () => (existsSync(path.join(junit, 'browser-logs')) ? readdirSync(path.join(junit, 'browser-logs')) : []);

describe('the browser log of a guarded context', () => {
  it('records console messages with their type, page errors, failed requests, answers of 400 or more and navigations, each timed', () => {
    beginCase();
    const c = new FakeContext();
    const r = record(c);
    const p = c.newPage('about:blank');
    p.go('http://127.0.0.1:1/tech/jobs/24830');
    c.console(p, 'error', 'planted line');
    c.console(p, 'warning', 'a warning');
    c.pageError(p, 'boom');
    c.failRequest(p, 'http://127.0.0.1:1/api/v1/x');
    c.answer(p, 'http://127.0.0.1:1/api/v1/ok', 200);
    c.answer(p, 'http://127.0.0.1:1/api/v1/gone', 404);
    p.emit('crash', p);
    p.emit('close', p);
    const kinds = r.entries.map((e) => `${e.kind}${e.type ? `:${e.type}` : ''}`);
    expect(kinds).toEqual(['page-opened', 'navigated', 'domcontentloaded', 'load', 'console:error', 'console:warning', 'pageerror', 'requestfailed:net::ERR_CONNECTION_REFUSED', 'response:404', 'crash', 'page-closed']);
    expect(r.entries.find((e) => e.kind === 'console')).toMatchObject({ page: 1, text: 'planted line', url: 'http://127.0.0.1:1/tech/jobs/24830', at: 'http://127.0.0.1:1/tech/jobs/24830/app.js:7:3' });
    expect(r.entries.find((e) => e.kind === 'pageerror')!.text).toContain('Error: boom');
    expect(r.entries.find((e) => e.kind === 'requestfailed')).toMatchObject({ text: 'http://127.0.0.1:1/api/v1/x', at: 'GET fetch' });
    for (const e of r.entries) expect(Number.isNaN(Date.parse(e.t))).toBe(false);
    expect(r.entries.map((e) => e.seq)).toEqual([...r.entries.map((e) => e.seq)].sort((a, b) => a - b));
    c.emit('close');
    expect(r.closedAt).toBeDefined();
    expect(endCase(task('pass'))).toBeNull();
  });

  it('keeps at most MAX_ENTRIES entries a context, dropping the oldest and counting them', () => {
    beginCase();
    const c = new FakeContext();
    const r = record(c);
    const p = c.newPage('about:blank');
    for (let i = 0; i < MAX_ENTRIES + 4; i++) c.console(p, 'log', `line ${i}`);
    expect(r.entries).toHaveLength(MAX_ENTRIES);
    expect(r.dropped).toBe(5); // the page-opened entry and the first 4 lines
    expect(r.entries.at(-1)!.text).toBe(`line ${MAX_ENTRIES + 3}`);
    c.emit('close');
    endCase(task('pass'));
  });

  it('writes nothing for a passing case, and for a failing one 1 file under BW_JUNIT_DIR/browser-logs with the case and every context it saw', () => {
    expect(logDir({ BW_JUNIT_DIR: '/work/.build/junit/page-walkers-nightly' })).toBe('/work/.build/junit/page-walkers-nightly/browser-logs');
    expect(logDir({})).toMatch(/\/\.build\/junit\/local\/browser-logs$/);
    const before = files().length;
    beginCase();
    const shared = new FakeContext(); // opened before the case (a beforeAll context) and still open
    record(shared, 'chromium');
    const own = new FakeContext();
    const r = record(own, 'webkit persistent');
    const p = own.newPage('http://127.0.0.1:1/tech/jobs/24830');
    own.console(p, 'error', 'planted line');
    own.emit('close'); // closed in the case: still in its log
    expect(caseRecorders()).toHaveLength(2);
    let printed = '';
    process.stdout.write = ((s: string) => ((printed += s), true)) as typeof process.stdout.write;
    const f = endCase(task('fail', 'adds a photo'));
    process.stdout.write = savedWrite;
    expect(f).not.toBeNull();
    expect(path.dirname(f!)).toBe(path.join(junit, 'browser-logs'));
    expect(path.basename(f!)).toMatch(/^x\.stack--suite-adds-a-photo--\d+-\d+\.jsonl$/);
    expect(printed).toBe(`browser-log: 2 browser entries of this failed case kept in ${f}\n`);
    const lines = readLines(f!);
    expect(lines[0]).toMatchObject({ kind: 'case', test: 'suite > adds a photo', state: 'fail', errors: ['TimeoutError: page.waitForURL: Timeout 30000ms exceeded.'] });
    expect(lines.filter((l) => l.kind === 'context').map((l) => [l.label, l.closedAt === null])).toEqual([['chromium', true], ['webkit persistent', false]]);
    expect(lines.slice(3).map((l) => [l.ctx, l.kind, l.type, l.text])).toEqual([[r.id, 'page-opened', undefined, undefined], [r.id, 'console', 'error', 'planted line']]);
    expect(files().length).toBe(before + 1);
    // The next case no longer holds the context that closed in this one.
    beginCase();
    expect(caseRecorders().map((x) => x.label)).toEqual(['chromium']);
    shared.emit('close');
    expect(endCase(task('pass'))).toBeNull();
    expect(files().length).toBe(before + 1);
  });
});

// The file-level hooks themselves: vitest runs them around these cases because this file imports browser-log.ts.
describe('the case hooks under vitest', () => {
  let printed = '';
  let planted: FakeContext | null = null;
  it('a passing case that drove a page leaves no file', () => {
    const c = new FakeContext();
    record(c);
    c.console(c.newPage('about:blank'), 'error', 'not kept');
    c.emit('close');
  });
  // it.fails: vitest turns this case's planted failure into a pass only after its afterEach ran, so the hook sees a failed case.
  it.fails('a failing case leaves its file (planted failure)', () => {
    planted = new FakeContext();
    record(planted);
    planted.console(planted.newPage('http://127.0.0.1:1/tech/jobs/24830/photo'), 'error', 'planted by the hook case');
    process.stdout.write = ((s: string) => ((printed += s), true)) as typeof process.stdout.write; // restored in the next case
    expect('the planted failure').toBe('a pass');
  });
  it('the hook wrote exactly 1 file, for the failing case, holding its planted line, and printed only its name', () => {
    process.stdout.write = savedWrite;
    planted?.emit('close');
    const mine = files().filter((f) => f.includes('the-case-hooks-under-vitest'));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatch(/^browser-log\.test--the-case-hooks-under-vitest-a-failing-case-leaves-its-file-planted-failure--\d+-\d+\.jsonl$/);
    const lines = readLines(path.join(junit, 'browser-logs', mine[0]!));
    expect(lines[0]).toMatchObject({ kind: 'case', state: 'fail' });
    expect(lines.some((l) => l.kind === 'console' && l.type === 'error' && l.text === 'planted by the hook case')).toBe(true);
    expect(lines.some((l) => l.text === 'not kept')).toBe(false);
    expect(printed).toMatch(/^browser-log: 2 browser entries of this failed case kept in .+\.jsonl\n$/);
  });
});
