// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

describe('the setup program\'s output', () => {
  // why: F-327 (owner ruling a35e8595 "JSON lines") a setup run that stops on a missing setting writes only JSON lines, no console text
  it('writes only JSON lines when a setting is missing', () => {
    const r = spawnSync(process.execPath, ['packages/setup/src/cli.ts'], { cwd: root, encoding: 'utf8', timeout: 30_000, env: { PATH: process.env['PATH'] ?? '' } });
    expect(r.status).toBe(2);
    expect(r.stderr).toBe('');
    const lines = r.stdout.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ process: 'setup', level: 'error', status: 'setup refused', errorCode: 'settings_missing' });
  });
});
