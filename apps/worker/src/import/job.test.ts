// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createPool } from '@bw/db';
import { createLogger } from '@bw/log';
import { Temporal } from '@bw/time';
import type { WorkerDeps } from '../jobs.ts';
import { executeOwed, startImportJob, type PassSteps } from './job.ts';

/** Stand-in steps: `owed` stays true for `owedFor` checks, `run` answers per call, and every log line is recorded. */
function steps(o: { owedFor: number; run: (n: number) => Promise<{ kind: string } | null>; analyze?: () => Promise<void> }) {
  const lines: string[] = [];
  const calls = { owed: 0, run: 0, analyze: 0 };
  const log = (level: string) => (f: { status?: unknown; errorCode?: string }) => { lines.push(`${level} ${String(f.status)}${f.errorCode ? ` ${f.errorCode}` : ''}`); };
  const s: PassSteps = {
    owed: async () => ++calls.owed <= o.owedFor,
    run: async () => o.run(++calls.run),
    analyze: async () => { calls.analyze++; await o.analyze?.(); },
    log: { info: log('info'), warn: log('warn'), error: log('error') } as PassSteps['log'],
    stopped: () => false,
  };
  return { s, lines, calls };
}

describe('the import job pass: each end path writes its own line (F-531)', () => {
  // why: F-531 (a) an ANALYZE that throws after a real run that ended done is its own warn line, not "import run failed"
  it('logs a failed ANALYZE after a done real run as a warn, not as a failed run', async () => {
    const t = steps({ owedFor: 1, run: async () => ({ kind: 'real' }), analyze: async () => { throw new Error('permission denied'); } });
    await executeOwed(t.s);
    expect(t.lines).toEqual(['info import run done', 'warn import run done Error']);
    expect(t.lines.some((l) => l.includes('failed'))).toBe(false);
  });

  // why: F-531 (b) a throw before the attempt is counted ends the pass, so a persistent error logs once per poll, not in a loop
  it('ends the pass after a failed run, so a persistent error does not spin', async () => {
    const t = steps({ owedFor: 1_000, run: async () => { throw Object.assign(new Error('clock read'), { code: 'import_failed' }); } });
    await executeOwed(t.s);
    expect(t.calls.run).toBe(1);
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]).toMatch(/^error import run failed /);
  });

  // why: F-531 each pass runs every owed run in turn and analyzes only after a real one
  it('runs every owed run in turn and analyzes only after a real one', async () => {
    const t = steps({ owedFor: 2, run: async (n) => ({ kind: n === 1 ? 'dry_run' : 'real' }) });
    await executeOwed(t.s);
    expect(t.calls).toEqual({ owed: 3, run: 2, analyze: 1 });
    expect(t.lines).toEqual(['info import run done', 'info import run done']);
  });
});

describe('the import job names the cause of each failure it catches (F-2036)', () => {
  // why: F-2036 the ANALYZE catch logged the fixed word analyze_failed, so the warn line never said why ANALYZE failed
  it('logs a failed ANALYZE with its cause code', async () => {
    const t = steps({ owedFor: 1, run: async () => ({ kind: 'real' }), analyze: async () => { throw Object.assign(new Error('permission denied for table customer'), { code: '42501' }); } });
    await executeOwed(t.s);
    expect(t.lines).toEqual(['info import run done', 'warn import run done 42501']);
  });

  // why: F-2036 the job's tick catch logged the fixed word import_job_failed every poll while the owed read failed, never its cause
  it('logs a failed owed read through the real pool with the connection error\'s code, then stops cleanly', async () => {
    const lines: Record<string, unknown>[] = [];
    const log = createLogger({ process: 'worker', clock: { realNow: () => Temporal.Instant.from('2026-11-01T12:00:00Z') }, write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) });
    // Nothing listens on port 1, so the job's own pool (a copy of these options) refuses every query.
    const main = createPool({ connectionString: 'postgres://bw_worker@127.0.0.1:1/none', connectionTimeoutMillis: 2_000 });
    const job = startImportJob({ pool: main, log } as unknown as WorkerDeps, { pollMs: 60_000, source: () => { throw new Error('never read'); } });
    await job.stop(); // waits for the first pass, whose owed() read failed
    await main.end();
    const errors = lines.filter((l) => l.level === 'error');
    expect(errors).toEqual([expect.objectContaining({ status: 'unhandled error', errorCode: 'ECONNREFUSED' })]);
    expect(JSON.stringify(lines)).not.toMatch(/import_job_failed|127\.0\.0\.1/);
  });
});
