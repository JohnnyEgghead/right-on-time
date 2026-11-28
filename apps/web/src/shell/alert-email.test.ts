// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-2077 (Open the email opens 1 tab and sends 1 API-174 per press-run, per alert)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAlertEmail } from './alert-email.ts';
import type { Reader } from './reads.ts';

interface Tab {
  opener: unknown;
  location: { href: string };
  close: () => void;
}

/** A window that counts the tabs it opens, and a reader whose answers land when the test says so. */
function rig() {
  const tabs: Tab[] = [];
  const open = vi.fn(() => {
    const tab: Tab = { opener: 1, location: { href: '' }, close: vi.fn() };
    tabs.push(tab);
    return tab;
  });
  const assign = vi.fn();
  vi.stubGlobal('window', { open, location: { origin: 'http://x', assign } });
  const land: ((r: { ok: true; data: { link: string } } | { ok: false; reason: 'failed' }) => void)[] = [];
  const read = vi.fn(() => new Promise((r) => land.push(r as never)));
  const reader = { read } as unknown as Reader;
  return { tabs, open, assign, read, land, reader };
}

afterEach(() => vi.unstubAllGlobals());

describe('Open the email (F-2077)', () => {
  // why: F-2077 a double click opened 2 tabs and sent 2 API-174, each retiring the last link, so 1 tab could show a dead link
  it('opens 1 tab and sends 1 read for 2 clicks on 1 alert before the answer', async () => {
    const t = rig();
    const first = openAlertEmail('a-1', () => undefined, t.reader);
    const second = openAlertEmail('a-1', () => undefined, t.reader);
    await second; // the dropped press returns at once
    expect([t.open.mock.calls.length, t.read.mock.calls.length]).toEqual([1, 1]);
    t.land[0]?.({ ok: true, data: { link: 'http://x/l1' } });
    await first;
    expect(t.tabs[0]?.location.href).toBe('http://x/l1');
  });

  // why: F-2077 the guard is per alert and ends with the answer: another alert goes on, and so does a later press on the same one
  it('lets another alert go on, and the same alert again once its answer landed', async () => {
    const t = rig();
    const a = openAlertEmail('a-1', () => undefined, t.reader);
    const b = openAlertEmail('a-2', () => undefined, t.reader);
    expect(t.read.mock.calls.length).toBe(2);
    t.land[0]?.({ ok: false, reason: 'failed' });
    t.land[1]?.({ ok: true, data: { link: 'http://x/l2' } });
    await Promise.all([a, b]);
    const refused = vi.fn();
    const again = openAlertEmail('a-1', refused, t.reader);
    expect(t.read.mock.calls.length).toBe(3);
    t.land[2]?.({ ok: false, reason: 'failed' });
    await again;
    expect(refused).toHaveBeenCalledTimes(1);
    expect(t.tabs[0]?.close).toHaveBeenCalled(); // the refused tab closes
  });
});
