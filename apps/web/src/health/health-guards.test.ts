// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: K-01, F-2011 (Dismiss and the alert switches send 1 write per press-run)
// The web tests have no DOM, so the real HealthScreen renders once on the server renderer and the test presses its controls by calling the
// handlers it hands to HealthView (captured by a stand-in view). The client is a fake whose write answers when the test says so; a second press
// comes before it lands.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const view = vi.hoisted(() => ({ on: null as null | Record<string, (...a: never[]) => unknown> }));
const api = vi.hoisted(() => ({ call: null as unknown as ReturnType<typeof import('vitest').vi.fn>, land: [] as (() => void)[], holdReads: false, readsLand: [] as (() => void)[] }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('branch=columbus') }));
vi.mock('./HealthView.tsx', async (real) => {
  const m = await real<typeof import('./HealthView.tsx')>();
  return { ...m, HealthView: (p: { on: Record<string, (...a: never[]) => unknown> }) => { view.on = p.on; return null; } };
});
vi.mock('@bw/api', async (real) => {
  const m = await real<typeof import('@bw/api')>();
  const { vi: v } = await import('vitest');
  // A write waits for the test to land it; every read answers at once with nothing the screen needs.
  // With `holdReads` set, a re-read (API-70) waits too, so a test can end the write and keep the re-read out.
  api.call = v.fn((row: unknown) =>
    row === m.dismissAlert || row === m.setAlertSwitch
      ? new Promise<unknown>((r) => api.land.push(() => r({ data: {} })))
      : row === m.systemHealth && api.holdReads
        ? new Promise<unknown>((r) => api.readsLand.push(() => r({ data: {}, envelope: null })))
        : Promise.resolve({ data: {}, envelope: null }));
  return { ...m, createClient: () => ({ call: api.call }) };
});

const { HealthScreen } = await import('./HealthScreen.tsx');
const { ShellIntl } = await import('../shell/intl.tsx');
const bw = await import('@bw/api');

function press() {
  view.on = null;
  renderToStaticMarkup(createElement(ShellIntl, { lang: 'en', children: createElement(HealthScreen) }));
  return view.on as unknown as { onDismiss: (id: string) => void; onSwitch: (type: string, which: 'bell' | 'managersEmail', value: boolean) => void };
}
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const sent = (row: unknown) => api.call.mock.calls.filter((c) => c[0] === row).length;

beforeEach(() => {
  api.call.mockClear();
  api.land.length = 0;
  api.holdReads = false;
  api.readsLand.length = 0;
});

describe('the Health page sends 1 write per press-run (K-01)', () => {
  // why: K-01 Dismiss had no in-flight guard, so a second press before the answer sent a second dismiss
  it('sends 1 dismiss for 2 Dismiss presses before the answer', async () => {
    const on = press();
    on.onDismiss('a-1');
    on.onDismiss('a-1');
    await settle();
    expect(sent(bw.dismissAlert)).toBe(1);
    api.land[0]?.();
    await settle();
    await settle();
    on.onDismiss('a-1'); // the answer and the re-read landed, so the guard let go
    await settle();
    expect(sent(bw.dismissAlert)).toBe(2);
  });

  // why: K-01 the alert switches had no in-flight guard, so 2 fast toggles sent 2 writes whose answers could land in either order
  it('sends 1 switch write for 2 toggles before the answer', async () => {
    const on = press();
    on.onSwitch('late', 'bell', false);
    on.onSwitch('late', 'bell', false);
    await settle();
    expect(sent(bw.setAlertSwitch)).toBe(1);
    api.land[0]?.();
    await settle();
    await settle();
    on.onSwitch('late', 'bell', true);
    await settle();
    expect(sent(bw.setAlertSwitch)).toBe(2);
  });

  // why: F-2079 1 guard served every Dismiss row and every switch, so a press on a 2nd row while the 1st was in flight was dropped with no sign
  it('keeps a guard per row: a press on another Dismiss row or another switch goes on, a 2nd press on the same one does not', async () => {
    const on = press();
    on.onDismiss('a-1');
    on.onDismiss('a-2');
    on.onDismiss('a-1');
    on.onSwitch('late', 'bell', false);
    on.onSwitch('late', 'managersEmail', true);
    on.onSwitch('late', 'bell', false);
    await settle();
    expect(sent(bw.dismissAlert)).toBe(2);
    expect(sent(bw.setAlertSwitch)).toBe(2);
  });

  // why: F-2084 the Dismiss button stays on screen until the re-read lands, so a guard that let go when the write answered let a 2nd press send a 2nd
  // write that the server refuses (409); the guard holds across the re-read
  it('sends no 2nd Dismiss write after the write answers while the re-read is still out', async () => {
    api.holdReads = true;
    const on = press();
    on.onDismiss('a-1');
    await settle();
    api.land[0]?.();
    await settle();
    expect(api.readsLand.length).toBeGreaterThan(0); // the re-read is out and unanswered
    on.onDismiss('a-1');
    await settle();
    expect(sent(bw.dismissAlert)).toBe(1);
  });
});
