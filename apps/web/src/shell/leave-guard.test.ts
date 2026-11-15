// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { armLeaveGuard, confirmLeave } from './leave-guard.ts';

const asked: string[] = [];
const win = { confirm: vi.fn((m: string) => (asked.push(m), false)), addEventListener: vi.fn(), removeEventListener: vi.fn() };
vi.stubGlobal('window', win);

afterEach(() => {
  asked.length = 0;
  win.confirm.mockClear();
});

describe('the shared leave guard', () => {
  // why: F-752 the top-bar branch choice and the page's tabs leave through 1 guard: armed with typing it asks, the answer decides, disarmed it asks nothing
  it('asks once armed, lets a leave go when answered yes, and asks nothing after it is disarmed', () => {
    expect(confirmLeave()).toBe(true);
    expect(win.confirm).not.toHaveBeenCalled();
    const off = armLeaveGuard('Leave without saving?');
    expect(confirmLeave()).toBe(false);
    expect(asked).toEqual(['Leave without saving?']);
    win.confirm.mockReturnValueOnce(true);
    expect(confirmLeave()).toBe(true);
    off();
    expect(confirmLeave()).toBe(true);
    expect(win.confirm).toHaveBeenCalledTimes(2);
  });
});
