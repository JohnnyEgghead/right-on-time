// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-28
// The local wave run (ci/wave-run.sh) must outlast install time, the 2 h full-CI budget and the largest
// per-gate limit, or a per-gate cap could never fire (F-28 class). Also: the push job runs the merge set
// only and no workflow runs the full set or can be dispatched by hand (F-26, F-37; owner rulings 7b7a6a90, f3b1a4af).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { run?: string };
type Job = { 'timeout-minutes'?: number; steps?: Step[] };
// F-1852: .github/workflows/ is a private path (scripts/private-paths.txt), so in a public copy the tests that read ci.yml skip
// with a note naming it; the private checkout has it and they run.
const noWf = existsSync('.github/workflows/ci.yml') ? '' : '.github/workflows/ci.yml is not in this copy (a private path the public export leaves out)';
const wf = (noWf ? { on: null, jobs: {} } : parse(readFileSync('.github/workflows/ci.yml', 'utf8'))) as { on: unknown; jobs: Record<string, Job> };
// The trigger names of a workflow's on: key, whatever its shape: a string, a list or a map (F-42).
const triggers = (on: unknown): string[] =>
  typeof on === 'string' ? [on] : Array.isArray(on) ? on.map(String) : on && typeof on === 'object' ? Object.keys(on) : [];
const gates = JSON.parse(readFileSync('ci/gates.json', 'utf8')) as {
  defaultTimeoutS: number;
  gates: { id: string; when: string; timeoutS?: number }[];
};
const INSTALL_ALLOWANCE_S = 600; // apt, pnpm install, browser download (the script allows more)
const FULL_CI_BUDGET_S = 2 * 60 * 60; // docs/BUILD_PLAN.md header: full CI <= 2 h (plan v0.24, F-1036)

const runs = (job: Job) => (job.steps ?? []).map((s) => s.run ?? '').join('\n');

describe('CI job timeouts and what each job runs', () => {
  it('the wave run cap is above install time plus the 2 h budget plus the largest gate limit', () => {
    const largest = Math.max(gates.defaultTimeoutS, ...gates.gates.map((g) => g.timeoutS ?? 0));
    const r = spawnSync('bash', ['ci/wave-run.sh', '--print-cap'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(Number(r.stdout.trim())).toBeGreaterThan(INSTALL_ALLOWANCE_S + FULL_CI_BUDGET_S + largest);
  });
  // F-976: a timeoutS no run could reach never fires, so each is bounded by the run that carries it
  it('every gate timeoutS fits the nightly limit (the wave run budget), and a merge gate fits the push job timeout', (ctx) => {
    if (noWf) ctx.skip(noWf);
    const budget = Number(/^FULL_CI_BUDGET_S=(\d+)/m.exec(readFileSync('ci/wave-run.sh', 'utf8'))?.[1]);
    expect(budget).toBeGreaterThan(0);
    const pushJobS = (wf.jobs.checks?.['timeout-minutes'] ?? 0) * 60;
    expect(pushJobS).toBeGreaterThan(0);
    expect(gates.defaultTimeoutS).toBeLessThanOrEqual(pushJobS);
    const over = gates.gates.filter((g) => (g.timeoutS ?? gates.defaultTimeoutS) > budget).map((g) => g.id);
    expect(over, 'timeoutS above the nightly limit').toEqual([]);
    const overPush = gates.gates.filter((g) => g.when === 'merge' && (g.timeoutS ?? gates.defaultTimeoutS) > pushJobS).map((g) => g.id);
    expect(overPush, 'merge gates with timeoutS above the push job timeout').toEqual([]);
  });
  it('the push job runs the merge set and not ci.sh --all', (ctx) => {
    if (noWf) ctx.skip(noWf);
    expect(runs(wf.jobs.checks ?? {})).toContain('pnpm run ci');
    expect(runs(wf.jobs.checks ?? {})).not.toContain('--all');
  });
  it('no workflow job runs ci.sh --all and the workflow has no manual trigger', (ctx) => {
    if (noWf) ctx.skip(noWf);
    expect(Object.values(wf.jobs).filter((j) => runs(j).includes('--all'))).toHaveLength(0);
    expect(triggers(wf.on)).not.toContain('workflow_dispatch');
  });
  it('the trigger reader sees workflow_dispatch in the string, list and map forms of on:', (ctx) => {
    if (noWf) ctx.skip(noWf);
    // reason: F-42; Object.keys of a list or string gave indices, so the no-manual-trigger arm stayed green
    expect(triggers('workflow_dispatch')).toContain('workflow_dispatch');
    expect(triggers(['push', 'workflow_dispatch'])).toContain('workflow_dispatch');
    expect(triggers({ push: null, workflow_dispatch: null })).toContain('workflow_dispatch');
    expect(triggers({ push: { branches: ['main'] } })).toEqual(['push']);
    expect(triggers(wf.on).length).toBeGreaterThan(0);
  });
});
