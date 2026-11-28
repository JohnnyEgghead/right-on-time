// SPDX-License-Identifier: AGPL-3.0-or-later
// P10-JOB-SCREENS (K-10.6a): the page's item engine is created with its triggers; a refresh that rejects (the store cannot be read) is caught where
// the trigger calls it, never an unhandled rejection that ends a Node process or fills a browser console.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({ refresh: (() => Promise.reject(new Error('store unreadable'))) as () => Promise<void> }));
vi.mock('./engine.ts', async (orig) => {
  const m = await orig<typeof import('./engine.ts')>();
  class FakeOutbox {
    snapshot = {};
    refresh = () => engine.refresh();
    sync = () => Promise.resolve();
    setVersion = () => undefined;
    enter = () => Promise.resolve();
  }
  return { ...m, TechOutbox: FakeOutbox };
});
vi.mock('@bw/outbox/src/items/index.ts', () => ({ DexieItemStore: class {} }));
vi.mock('./transport.ts', () => ({ webTransport: () => ({}) }));
vi.mock('@bw/api', async (orig) => {
  const m = await orig<typeof import('@bw/api')>();
  return { ...m, createClient: () => ({ call: () => new Promise(() => undefined) }) };
});

const listeners = new Map<string, () => void>();
const rejections: unknown[] = [];
const onRejection = (reason: unknown) => void rejections.push(reason);

beforeEach(() => {
  listeners.clear();
  rejections.length = 0;
  process.on('unhandledRejection', onRejection);
  vi.stubGlobal('window', {
    location: { origin: 'http://phone.test' },
    addEventListener: (name: string, fn: () => void) => void listeners.set(name, fn),
    setInterval: () => 0,
  });
  vi.stubGlobal('navigator', { userAgent: 'test', onLine: true });
  vi.stubGlobal('document', { addEventListener: () => undefined, visibilityState: 'hidden' });
  vi.resetModules();
});
afterEach(() => {
  process.off('unhandledRejection', onRejection);
  vi.unstubAllGlobals();
});

describe('the item engine\'s triggers', () => {
  // why: FR-TECH-4 K-10 (row K-10.6a) a refresh that rejects, on open and when the browser goes offline, is caught: no unhandled rejection
  it('raises no unhandled rejection when the engine\'s refresh rejects', async () => {
    const { techOutbox } = await import('./useOutbox.ts');
    techOutbox();
    const offline = listeners.get('offline');
    expect(offline, 'techOutbox() registered no offline listener, so the case below would prove nothing').toBeTypeOf('function');
    offline!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rejections).toEqual([]);
  });
});
