// SPDX-License-Identifier: AGPL-3.0-or-later
// A tab opens even when the server never answers the router's data request (tab-open.ts; F-1232). The real browsers run it in
// ci/mapme-stack (the origin takes the request and holds it); these hold the rule on fixed inputs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTab, TAB_OPEN_MS } from './tab-open.ts';

beforeEach(() => {
  vi.stubGlobal('window', { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('opening a tab', () => {
  // why: FR-TECH-10, F-1232 a router that never opens the screen is followed by a full page load, so the tab opens within a few seconds
  it('loads the tab\'s page in full when the router has not opened it in time', () => {
    const assign = vi.fn();
    const push = vi.fn();
    openTab(push, '/tech/map', { pathname: '/tech', assign });
    expect(push).toHaveBeenCalledWith('/tech/map');
    vi.advanceTimersByTime(TAB_OPEN_MS - 1);
    expect(assign).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(assign).toHaveBeenCalledWith('/tech/map');
  });

  // why: FR-TECH-10, F-1232 a screen the router opened in time, or a tab tapped over by another, is never loaded a second time
  it('does nothing more when the screen opened, or when another tab was tapped since', () => {
    const assign = vi.fn();
    const loc = { pathname: '/tech', assign };
    openTab(vi.fn(), '/tech/map', loc);
    loc.pathname = '/tech/map';
    vi.advanceTimersByTime(TAB_OPEN_MS);
    expect(assign).not.toHaveBeenCalled();
    const away = { pathname: '/tech', assign };
    openTab(vi.fn(), '/tech/parts', away);
    openTab(vi.fn(), '/tech/me', away);
    vi.advanceTimersByTime(TAB_OPEN_MS);
    expect(assign.mock.calls).toEqual([['/tech/me']]);
  });

  // why: F-1240 a tab that opened fast and was left again (a job opened) inside the window is never pulled back by the full load
  it('does not pull the technician back when the tab opened and a job was opened inside the window', () => {
    const assign = vi.fn();
    const loc = { pathname: '/tech', assign };
    openTab(vi.fn(), '/tech/map', loc);
    loc.pathname = '/tech/map';
    vi.advanceTimersByTime(1000);
    loc.pathname = '/tech/jobs/42';
    vi.advanceTimersByTime(TAB_OPEN_MS);
    expect(assign).not.toHaveBeenCalled();
  });

  // why: F-1240 Back from the tab inside the window leaves the technician where Back put them, not on the tab
  it('does not load the tab when Back left it inside the window', () => {
    const assign = vi.fn();
    const loc = { pathname: '/tech/me', assign };
    openTab(vi.fn(), '/tech/map', loc);
    loc.pathname = '/tech/map';
    vi.advanceTimersByTime(900);
    loc.pathname = '/tech/me';
    vi.advanceTimersByTime(TAB_OPEN_MS);
    expect(assign).not.toHaveBeenCalled();
  });
});
