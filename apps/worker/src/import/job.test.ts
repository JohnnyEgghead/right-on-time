// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { executeOwed, type PassSteps } from './job.ts';

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
    expect(t.lines).toEqual(['info import run done', 'warn import run done analyze_failed']);
    expect(t.lines.some((l) => l.includes('failed') && !l.includes('analyze_failed'))).toBe(false);
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
