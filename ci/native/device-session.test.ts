// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1403 F-1357 F-1380 (device-session.sh must fail closed: a missing step mark, a missing done mark, an unquoted mark, a stop with no list)
// The cases live in apps/tech-native/release/device-session.test.sh (a fake capture dir and a fake capture process; no phone). This wraps that
// script so the push unit-tests gate runs it: before this file, no gate ran it and a plant that skipped every alternative mark stayed green.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.resolve(import.meta.dirname, '../../apps/tech-native/release/device-session.test.sh');

describe('apps/tech-native/release/device-session.test.sh', () => {
  it('passes all 6 cases (missing done, missing step mark, either alternative, fail then pass, unquoted mark, stop with no list)', () => {
    // why: F-1403 a stop that ignores a missing step mark must turn this red
    const r = spawnSync('bash', [script], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).not.toContain('FAIL');
    expect(r.status).toBe(0);
    for (const n of [1, 2, 3, 4, 5, 6]) expect(r.stdout).toContain(`ok: ${n} `);
  });
});
