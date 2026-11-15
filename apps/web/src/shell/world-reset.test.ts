// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ClockAnswer } from './clock.ts';
import { readWorld } from './world-reset.tsx';

const Z = '[America/New_York]';
const answer = (over: Partial<ClockAnswer>): ClockAnswer => ({ demoNow: `2026-09-15T10:28:00-04:00${Z}`, rate: 1, paused: false, worldEpoch: 1, ...over });
const RESET = { by: 'Dana Ruiz', kind: 'reset', toDemo: `2026-09-15T07:00:00-04:00${Z}` } as const;

describe('the world reset fact (F-646)', () => {
  // why: FR-DEMO-7 the reset is API-10's rising worldEpoch, on every surface: the first read is the baseline
  it('takes no reset from the first read or the same epoch', () => {
    expect(readWorld(null, null, answer({ worldEpoch: 5 }))).toEqual({ reset: null, ended: false });
    expect(readWorld(5, null, answer({ worldEpoch: 5 }))).toEqual({ reset: null, ended: false });
  });

  // why: UI-SPECIFICATION CTL-CMP-02-03 the notice names the demo time the world was reset to
  it('names the time of the reset move', () => {
    const r = readWorld(1, null, answer({ worldEpoch: 2, demoNow: `2026-09-15T07:03:00-04:00${Z}`, lastMove: RESET }));
    expect(r.reset?.to).toBe(RESET.toDemo);
  });

  // why: UI-SPECIFICATION CTL-CMP-02-03 with no reset move on record the clock's own time is the best word
  it('falls back to demo now', () => {
    expect(readWorld(1, null, answer({ worldEpoch: 2 })).reset?.to).toBe(`2026-09-15T10:28:00-04:00${Z}`);
  });

  // why: FR-DEMO-7 a slow read of the old world lands after the reset: it is no second reset
  it('ignores a late read of an older epoch', () => {
    expect(readWorld(3, null, answer({ worldEpoch: 2 })).reset).toBeNull();
  });

  // why: UI-SPECIFICATION CTL-CMP-02-03 gives way to CTL-CMP-02-01 at the next clock move
  it('ends the notice at the next move and not before', () => {
    const notice = readWorld(1, null, answer({ worldEpoch: 2, lastMove: RESET })).reset;
    expect(readWorld(2, notice, answer({ worldEpoch: 2, lastMove: RESET })).ended).toBe(false);
    expect(readWorld(2, notice, answer({ worldEpoch: 2, lastMove: { by: 'Dana Ruiz', kind: 'jump', toDemo: `2026-09-15T08:00:00-04:00${Z}` } })).ended).toBe(true);
  });
});
