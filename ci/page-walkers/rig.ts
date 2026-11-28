// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: K-08, K-05 (F-2075, F-2080: the office walkers newest-answer, office-lists and office-board share 1 fixtures loader, 1 envelope and 1 request rig)
// The page walkers that answer every /api/v1 request themselves (the screens render live at /shell-preview/...). One router for all of them: a table of
// answers by request key (data, a Problem, or 'hold'), a queue of held requests the test answers in any order, and the event stream the page opens.
import type { Page, Route } from 'playwright';
import { expect } from 'vitest';

/**
 * The screens' own preview fixtures, loaded by a computed path so a walker file (under the root tsconfig, which has no JSX) does not compile the
 * screens' TSX: the data is what the preview routes draw, and the client parses each answer with the contract's schema.
 */
export const fixtures = async <T>(file: string): Promise<T> => (await import(`../../apps/web/src/${file}`)) as T;
export type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const DEMO_NOW = '2026-09-15T10:28:00-04:00[America/New_York]';
export const ZONE = '[America/New_York]';

/** A contract's answer as the server wraps it; the demo time defaults to DEMO_NOW. */
const envelope = (contract: string, data: unknown, demoNow: string = DEMO_NOW) => ({
  data,
  meta: { contract, worldEpoch: 1, demoNow, viewer: { kind: 'staff', userId: 'u-dana', role: 'manager' }, labels: [] },
});
const problem = (code: string, status: number, demoNow: string) => ({
  type: `https://bw.j7l.io/errors/${code}`, title: code, status, code, meta: { contract: 'API-28', worldEpoch: 1, demoNow },
});

/** One request the screen made. */
export interface Seen {
  url: URL;
  body: unknown;
}
/** What the test answers a request with: a contract's data, a problem, or 'hold' (the test answers it later, with `release`). */
export type Answer = { contract: string; data: unknown } | { problem: { code: string; status: number } } | 'hold';

/** One request held in the queue (`hold`), until the test answers it. */
export interface Held {
  url: URL;
  body: unknown;
  answer(contract: string, data: unknown): Promise<void>;
  /** The event stream: send 1 event, then the stream ends. */
  frame(name: string): Promise<void>;
}

const sse = (names: string[]) => names.map((n, i) => `event: ${n}\nid: ${i + 1}\ndata: {"ids":{}}\n\n`).join('');

/**
 * Answers every /api/v1 request of the page and keeps what each one asked. A request nobody names fails (the screen shows its own failed state for
 * it) and is listed in `unnamed`. The event stream stays open, quietly, until the test sends it events.
 */
export async function rig(page: Page, opts: { demoNow?: string } = {}) {
  const demo = { now: opts.demoNow ?? DEMO_NOW };
  const seen = new Map<string, Seen[]>();
  const table = new Map<string, (n: number, body: Rec) => Answer | Promise<Answer>>();
  const heldRoutes = new Map<string, Route[]>();
  const queues = new Map<string, Held[]>();
  const taken = new Map<string, number>();
  const stream: { events: string[] } = { events: [] };
  const unnamed: string[] = [];
  const json = (route: Route, contract: string, data: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope(contract, data, demo.now)) });
  await page.route('**/api/v1/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const key = `${req.method()} ${url.pathname.replace(/^.*\/api\/v1/, '').replace(/^\/(branches|users)\/[^/]+(?=\/(booking-settings|turn-on))/, '/$1/:id').replace(/^\/customers\/[^/]+/, '/customers/:id')}`;
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    const list = seen.get(key) ?? seen.set(key, []).get(key)!;
    list.push({ url, body });
    if (queues.has(key)) {
      const h: Held = {
        url, body,
        answer: (contract, data) => json(route, contract, data),
        frame: (name) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse([name]) }),
      };
      queues.get(key)!.push(h);
      return;
    }
    if (key === 'GET /events') {
      const text = sse(stream.events.splice(0));
      if (text === '') {
        (heldRoutes.get(key) ?? heldRoutes.set(key, []).get(key)!).push(route);
      } else {
        await route.fulfill({ status: 200, contentType: 'text/event-stream', body: text });
      }
      return;
    }
    const answer = table.get(key);
    if (!answer) {
      unnamed.push(key);
      await route.abort('failed');
      return;
    }
    const a = await answer(list.length, (body ?? {}) as Rec);
    if (a === 'hold') {
      (heldRoutes.get(key) ?? heldRoutes.set(key, []).get(key)!).push(route);
      return;
    }
    if ('problem' in a) {
      await route.fulfill({ status: a.problem.status, contentType: 'application/problem+json', body: JSON.stringify(problem(a.problem.code, a.problem.status, demo.now)) });
      return;
    }
    await json(route, a.contract, a.data);
  });
  return {
    /** These requests are answered at once, by the table (or held, when the answer is 'hold'). Setting a key again replaces its answer. */
    on(key: string, answer: (n: number, body: Rec) => Answer | Promise<Answer>) {
      table.set(key, answer);
    },
    /** These requests are answered at once with the same data each time. */
    auto(key: string, contract: string, data: unknown) {
      table.set(key, () => ({ contract, data }));
    },
    count: (key: string) => (seen.get(key) ?? []).length,
    all: (key: string) => seen.get(key) ?? [],
    unnamed,
    /** The demo time the answers' envelopes carry. */
    setDemoNow(at: string) {
      demo.now = at;
    },
    /** The requests of this key the table answered 'hold', oldest first. */
    held: (key: string) => heldRoutes.get(key) ?? [],
    /** Answers every request of this key the table held, with the data, and forgets them. */
    async release(key: string, contract: string, data: unknown) {
      for (const route of heldRoutes.get(key)?.splice(0) ?? []) await json(route, contract, data);
    },
    /** The next event stream the page opens gets these events in its first chunk (3 events arrive together). */
    events(...names: string[]) {
      stream.events.push(...names);
    },
    /** The stream the page holds open now is answered with the events queued, and ends. */
    async flush() {
      const route = heldRoutes.get('GET /events')?.shift();
      if (route) await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(stream.events.splice(0)) });
    },
    streamHeld: () => (heldRoutes.get('GET /events') ?? []).length,
    /** These requests are queued for the test to answer, one by one with `next`; others fail. */
    hold(...keys: string[]) {
      for (const k of keys) queues.set(k, queues.get(k) ?? []);
    },
    /** The next queued request of this kind the test has not taken yet. */
    async next(key: string): Promise<Held> {
      const i = taken.get(key) ?? 0;
      await expect.poll(() => (queues.get(key) ?? []).length, { message: `read ${i + 1} of ${key}`, timeout: 15_000 }).toBeGreaterThan(i);
      taken.set(key, i + 1);
      return queues.get(key)![i]!;
    },
  };
}
export type Rig = Awaited<ReturnType<typeof rig>>;
