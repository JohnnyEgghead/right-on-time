// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1650: the F-1592 rig (infra/tests/f1592-window.ts) runs Docker, so the suite checks its pure parts only: the bad arm is the
// committed http.conf less exactly the resolver_timeout line, and the verdict reads the windows as the evidence note says.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { badArm, RESOLVER_TIMEOUT_LINE, verdict, type ArmRun } from './f1592-window.ts';

const conf = readFileSync(path.resolve(import.meta.dirname, '../nginx/http.conf'), 'utf8');

describe('the F-1592 window rig (F-1650)', () => {
  // why: F-1650 (the measured window had no runnable rig: its known-bad arm must still apply to the committed http.conf)
  it('builds the bad arm from the committed http.conf by removing the 1 resolver_timeout line, and refuses any other count', () => {
    const bad = badArm(conf);
    expect(conf.length - bad.length).toBe(RESOLVER_TIMEOUT_LINE.length);
    expect(bad).not.toMatch(/^\s*resolver_timeout/m); // the comments above it still name it
    expect(bad).toContain('resolver 127.0.0.11 valid=2s ipv6=off;');
    expect(() => badArm(bad)).toThrow('0 times, not once');
    expect(() => badArm(conf + RESOLVER_TIMEOUT_LINE)).toThrow('2 times, not once');
  });

  // why: F-1650 (the rig's exit code is the measurement's pass line: fixed under 10 s, bad 20 s or more)
  it('passes only when every fixed window is under 10 s and every bad one is 20 s or more, on runs where web moved', () => {
    const run = (arm: 'fixed' | 'bad', w: number | null, moved = true): ArmRun => ({ arm, run: 1, moved, window_s: w, non200: 0 });
    expect(verdict([run('fixed', 2.38), run('bad', 30.36)])).toBe(true);
    expect(verdict([run('bad', null)])).toBe(true);
    expect(verdict([run('fixed', 10)])).toBe(false);
    expect(verdict([run('fixed', null)])).toBe(false);
    expect(verdict([run('bad', 19.9)])).toBe(false);
    expect(verdict([run('fixed', 1, false)])).toBe(false);
    expect(verdict([])).toBe(false);
  });
});
