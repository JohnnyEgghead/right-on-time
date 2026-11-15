// SPDX-License-Identifier: AGPL-3.0-or-later
// The schema gates, end to end through their own CLI (the command ci/gates/schema-gates.sh runs) on a real migrated
// PostgreSQL 18 database: the real schema passes, and every planted known-bad in cases/ fails with exactly its stated
// findings. Runs on every gate run, so a gate that stops failing is caught the run it stops (W-38).
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pgAdminUrl } from '../../../packages/db/src/testing/provided.ts';

const here = import.meta.dirname;
const cli = path.join(here, 'cli.ts');
const casesDir = path.join(here, 'cases');

interface Case { why: string; only: 'parity' | 'tz'; expect: string[] }

function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('node', [cli, ...args], { env: { ...process.env, BW_TEST_PG_URL: pgAdminUrl() } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    p.once('error', reject);
    p.once('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

const lines = (s: string) => s.split('\n').filter(Boolean).sort();
const cases = readdirSync(casesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

describe('schema-gates on the real schema', () => {
  // why: SD-40
  it('passes the migrated schema: parity both ways and every time column zoned', async () => {
    const r = await runCli([]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^schema-doc-parity: ok \(PostgreSQL 18\.[^;]*; 62 tables, \d+ columns, \d+ foreign keys, 1 view, 5 schemas; compared both ways\)$/m);
    expect(r.stdout).toMatch(/^schema-time-zone-check: ok \(\d+ time columns, each timestamptz, date or time with a declared zone\)$/m);
  });

  // why: setup
  it('keeps the 3 acceptance known-bads among its cases', () => {
    expect(cases).toEqual(expect.arrayContaining(['parity-extra-column', 'parity-missing-column', 'tz-timestamp-no-zone']));
  });
});

describe('schema-gates must-pass controls for the F-149 plants', () => {
  const plantAndRun = async (sql: string, args: string[]) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-plant-'));
    try {
      const file = path.join(dir, 'plant.sql');
      writeFileSync(file, sql);
      return await runCli(['--plant', file, ...args]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  // why: F-149
  it('control: a day-start copy of a world table in world_snapshot passes both gates', async () => {
    const r = await plantAndRun('CREATE TABLE world_snapshot.technician AS SELECT * FROM world.technician;', []);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  // why: F-149
  it('control: a precision-modified timestamptz in a table with a declared zone passes the time-zone gate', async () => {
    const r = await plantAndRun('ALTER TABLE world.customer ADD COLUMN seen_at timestamptz(3);', ['--only', 'tz']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

describe.each(cases)('schema-gates planted case %s', (name) => {
  // why: SD-40
  it('fails with exactly its stated findings', async () => {
    const c = JSON.parse(readFileSync(path.join(casesDir, name, 'case.json'), 'utf8')) as Case;
    expect(c.why.length).toBeGreaterThan(0);
    const r = await runCli(['--plant', path.join(casesDir, name, 'plant.sql'), '--only', c.only]);
    expect(r.status).toBe(1);
    expect(lines(r.stderr)).toEqual([...c.expect].sort());
  });
});
