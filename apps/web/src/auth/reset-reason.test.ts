// SPDX-License-Identifier: AGPL-3.0-or-later
// The reason shown after a world reset ended a session: only when this tab held a session and the epoch rose since.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reader } from '../shell/reads.ts';
import { forgetSessionEpoch, rememberSessionEpoch, resetEndedSession } from './reset-reason.ts';

const store = new Map<string, string>();
const reader = (epoch: number | null): Reader => ({
  async read<T>() {
    return epoch === null ? { ok: false, reason: 'failed' } : { ok: true, data: {} as T, epoch };
  },
});

beforeEach(() => {
  store.clear();
  vi.stubGlobal('window', {
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('the reset reason', () => {
  // why: FR-DEMO-4 a first visit, with no session kept in the tab, shows no reset reason
  it('is false when the tab never held a session', async () => {
    expect(await resetEndedSession(reader(5))).toBe(false);
  });

  // why: FR-DEMO-4 a session ended by a reset (the epoch rose) gets the reset reason
  it('is true when the world epoch rose since the session was last read', async () => {
    rememberSessionEpoch(3);
    expect(await resetEndedSession(reader(4))).toBe(true);
  });

  // why: FR-DEMO-4 a session that ended with no reset (same epoch) gets no reset reason
  it('is false when the epoch has not risen', async () => {
    rememberSessionEpoch(3);
    expect(await resetEndedSession(reader(3))).toBe(false);
  });

  // why: FR-DEMO-4 a failed read never claims a reason, and a chosen sign-out clears the kept epoch
  it('is false when the read fails or the person signed out', async () => {
    rememberSessionEpoch(3);
    expect(await resetEndedSession(reader(null))).toBe(false);
    forgetSessionEpoch();
    expect(await resetEndedSession(reader(9))).toBe(false);
  });
});
