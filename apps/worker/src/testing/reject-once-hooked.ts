// SPDX-License-Identifier: AGPL-3.0-or-later
// A preload (node --import) for process-rejection.test.ts (F-1845): as soon as the real entry point adds its
// unhandledRejection listener, 1 promise is rejected with a TypeError whose message holds private words, and nothing
// handles it. The process under test then shows what a real unhandled rejection does in it.
// BW_TEST_CALL_LISTENER=1 (the web entry: a checkout with no Next.js build exits 1 in the very tick it starts, inside
// the promise jobs, so Node never gets to a pending rejection): the listener the entry added is called at once with
// that TypeError, as Node would call it, which still proves the real entry installed the hook and what it writes.
// BW_TEST_EVENT=exception (F-1870): the TypeError is instead thrown from the next tick, once the entry's top-level code has
// added its hooks, and nothing catches it, so Node reaches its own fatal-exception path (or the entry's uncaughtException hook).
const thrown = process.env.BW_TEST_EVENT === 'exception';
const on = process.on.bind(process);
let fired = false;
process.on = ((name: string, listener: (...args: unknown[]) => void) => {
  on(name as 'unhandledRejection', listener);
  if (name === 'unhandledRejection' && !fired) {
    fired = true;
    const reason = new TypeError('private words 6145550100 at 1 Main St');
    if (process.env.BW_TEST_CALL_LISTENER === '1') listener(reason, Promise.resolve());
    else if (thrown) process.nextTick(() => { throw reason; });
    else void Promise.reject(reason);
  }
  return process;
}) as typeof process.on;
