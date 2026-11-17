// SPDX-License-Identifier: AGPL-3.0-or-later
// outside-origin-guard: the fixture every Playwright test imports (BUILD_PLAN P1-PAGE-GATES).
// Opens a browser context whose network is routed through a guard: a request to an origin other than the
// allowed ones is aborted (nothing leaves the machine) and recorded. The guard asserts on its own: closing
// the context throws when anything outside was recorded (F-40), so a test cannot forget the assertion.
// Covered: ordinary requests (context.route), requests a service worker makes (context 'request' event; service
// workers are blocked unless the caller opts in with serviceWorkers: 'allow'), and WebSockets (routeWebSocket).
// Closing the context first lets its pages' route callbacks finish, so none runs on after its test (F-1421), without unrouting the pages (F-1429).
// F-1130: every guarded context also has a browser log (ci/page-walkers/browser-log.ts): its pages' console messages, page errors and failed
// requests, kept in a file only when a case fails.
// The ci/browser-test-guard.test.ts merge-set check fails a Playwright file that opens a context another way.
import type { Browser, BrowserContext, BrowserContextOptions, BrowserType, Page } from 'playwright';
import { recordContext } from './browser-log.ts';

// file: is a local page load (a mockup frame page); its origin is the string null, so it is allowed by scheme.
const LOCAL_SCHEMES = ['data:', 'blob:', 'about:', 'file:'];

export type GuardOptions = {
  /** Throw from context.close() when an outside request was recorded. Default true. Set false only in a test
   *  that plants an outside request on purpose and asserts it itself. */
  assertOnClose?: boolean;
};

export type GuardedContext = {
  context: BrowserContext;
  outside: string[];
  assertNoOutsideRequests: () => void;
};

export function isAllowed(url: string, allowedOrigins: string[]): boolean {
  if (LOCAL_SCHEMES.some((s) => url.startsWith(s))) return true;
  // A WebSocket URL is judged by the http(s) origin it upgrades from.
  const u = new URL(url.replace(/^ws(s?):/, 'http$1:'));
  return allowedOrigins.includes(u.origin);
}

export async function guardedContext(
  browser: Browser,
  allowedOrigins: string[],
  options: BrowserContextOptions = {},
  guard: GuardOptions = {},
): Promise<GuardedContext> {
  // route() does not see requests a service worker handles, so workers are blocked unless a test opts in.
  return installGuard(await browser.newContext({ serviceWorkers: 'block', ...options }), allowedOrigins, guard, browser.browserType().name());
}

/**
 * The same guard on a persistent context (a browser profile kept in userDataDir), for a test that closes the app and opens
 * it again on the same profile, its storage and service worker kept on disk (P5-TWA-OUTBOX: G-CI1's client case, FR-TECH-4).
 */
export async function guardedPersistentContext(
  type: BrowserType,
  userDataDir: string,
  allowedOrigins: string[],
  options: BrowserContextOptions = {},
  guard: GuardOptions = {},
): Promise<GuardedContext> {
  return installGuard(await type.launchPersistentContext(userDataDir, { headless: true, serviceWorkers: 'block', ...options }), allowedOrigins, guard, `${type.name()} persistent`);
}

async function installGuard(context: BrowserContext, allowedOrigins: string[], guard: GuardOptions, engine: string): Promise<GuardedContext> {
  recordContext(context, engine);
  const outside: string[] = [];
  const record = (url: string) => {
    if (!outside.includes(url)) outside.push(url);
  };
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (isAllowed(url, allowedOrigins)) return route.continue();
    record(url);
    return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', (ws) => {
    const url = ws.url();
    if (isAllowed(url, allowedOrigins)) {
      ws.connectToServer();
      return;
    }
    record(url);
    void ws.close();
  });
  // Requests a worker makes bypass route(); the request event still reports them (recorded, not blocked).
  context.on('request', (req) => {
    if (!isAllowed(req.url(), allowedOrigins)) record(req.url());
  });
  const assertNoOutsideRequests = () => {
    if (outside.length > 0) {
      throw new Error(`outside-origin-guard: request(s) to another origin: ${outside.join(', ')}`);
    }
  };
  // The assert runs only when the context is closed: a test must close the context (in finally), not only the browser.
  const pageRoutes = trackPageRoutes(context);
  const realClose = context.close.bind(context);
  context.close = async (opts) => {
    await pageRoutes.settle();
    await realClose(opts);
    if (guard.assertOnClose !== false) assertNoOutsideRequests();
  };
  return { context, outside, assertNoOutsideRequests };
}

/** F-1421: the longest a close waits for its pages' route callbacks (a callback a failed test left held would otherwise hold the close for ever). */
const SETTLE_MS = 20_000;

type RouteCallback = Parameters<Page['route']>[1];

/**
 * F-1421: a page's route callback can still be running when its test ends (a stack suite's write forwarded with route.fetch while the page reads
 * again), and closing the context under it disposes its request context: the callback then throws after its test, an unhandled rejection that
 * fails the run ("route.fetch: Request context disposed"). So every page of the context has its route() callbacks counted while they run, and a
 * close first stops new ones (a request made meanwhile is handed on with fallback() to the context's routes, this guard's among them), waits for
 * the running ones, and closes after. A callback still running after SETTLE_MS is left to the close, and its error shows. A callback that returns
 * with its route held on purpose (mapme.stack.ts, the origin that never answers) has finished, so the close does not wait for it (F-1423).
 *
 * F-1429: the close must not unroute the pages. Unrouting a page's last route makes Playwright itself continue every request that page was still
 * routing (playwright-core 1.64.1 server Route.removeHandler, called through removeRequestInterceptor), while the client still hands the same
 * request on to the context's routes; this guard's route.continue then throws "Route is already handled!" after its test.
 *
 * Routes on the context itself are left alone: the phone suites close their app with a call in flight on purpose (their callbacks catch that), and
 * waiting would hand the app its answer first.
 */
function trackPageRoutes(context: BrowserContext): { settle: () => Promise<void> } {
  const running = new Set<Promise<unknown>>();
  let closing = false;
  const counted = new WeakMap<RouteCallback, RouteCallback>();
  const count = (callback: RouteCallback): RouteCallback => {
    let wrapped = counted.get(callback);
    if (wrapped === undefined) {
      wrapped = (route, request) => {
        if (closing) return route.fallback();
        const call = (async () => callback(route, request))();
        running.add(call);
        const done = () => running.delete(call);
        call.then(done, done);
        return call; // Playwright awaits the call itself, so a callback's own error still shows
      };
      counted.set(callback, wrapped);
    }
    return wrapped;
  };
  const seen = new WeakSet<Page>();
  const watch = (page: Page) => {
    if (seen.has(page)) return;
    seen.add(page);
    const route = page.route.bind(page);
    const unroute = page.unroute.bind(page);
    page.route = (url, callback, options) => route(url, count(callback), options);
    page.unroute = (url, callback) => unroute(url, callback === undefined ? undefined : (counted.get(callback) ?? callback));
  };
  for (const page of context.pages()) watch(page);
  context.on('page', watch);
  return {
    settle: async () => {
      closing = true;
      if (running.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), SETTLE_MS);
      });
      try {
        if ((await Promise.race([Promise.allSettled([...running]), late])) === 'late') {
          console.warn(`outside-origin-guard: a page's route callback was still running ${SETTLE_MS / 1000} s after its test; closing the context anyway`);
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
