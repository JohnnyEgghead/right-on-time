// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: tooling
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_ENGINE_NAMES, resolveEngines } from '../pw-engines.ts';
import { forbiddenRuns, literalRuns } from './walkers.ts';
import { countByType, currentPhase, doneCheckpoints, emptyWalkWhy, loadInventory, phaseFromMergedTasks, planTaskIds, planWalk, readMergedTasks, selectMerged, selectRows, walkClass } from './inventory.ts';
import { forbiddenEnglish } from './walkers.ts';

describe('page-walkers inventory selection', () => {
  const rows = loadInventory('acceptance/page-inventory.json');

  it('selects nothing at phase 1 (no page row targets phase 1 yet)', () => {
    expect(selectRows(rows, 1)).toEqual([]);
  });
  it('selects rows at or before the current phase', () => {
    const at2 = selectRows(rows, 2);
    expect(at2.length).toBeGreaterThan(0);
    expect(at2.every((r) => r.phase <= 2)).toBe(true);
  });
  it('selects every row of every type at or before the phase, and drops none', () => {
    // reason: F-38; the walkers cover every inventory row, not only rows typed exactly page
    expect(selectRows(rows, 9)).toHaveLength(rows.length);
    expect(rows).toHaveLength(81);
    const p = planWalk(rows, 9);
    expect(p.walked.length + p.hostOpened.length + p.handedOff.length).toBe(81);
    expect(p.handedOff.map((r) => r.type)).toEqual(['native screen']);
    expect(p.hostOpened.every((r) => ['dialog', 'sheet', 'popover', 'panel'].includes(r.type))).toBe(true);
    expect(countByType(p.walked)).toContain('page / native screen 10');
  });
  it('fails closed on an inventory type no walk covers', () => {
    // reason: F-38; a new type must be routed on purpose, not dropped
    expect(() => walkClass('widget')).toThrow(/no walk/);
    for (const r of rows) expect(() => walkClass(r.type)).not.toThrow();
  });
});

describe('spanish-fallback forbidden list', () => {
  it('allows cognates and English text that is another key Spanish value', () => {
    const bad = forbiddenEnglish({
      en: { a: 'Total', b: 'Open', c: 'Save' },
      es: { a: 'Total', b: 'Abrir', c: 'Open' },
    });
    expect(bad).toEqual(['Save']);
  });
});

describe('current phase (D-9)', () => {
  it('reads BW_PHASE, else the merged checkpoints, and has no default', () => {
    // reason: F-39; a phase that cannot be read used to default to 1, so from phase 2 the gate passed on an empty selection
    const merged = () => ['P1-REPO', 'CP1', 'CP2', 'P3-OUTBOX'];
    const none = () => {
      throw new Error('no ref');
    };
    expect(currentPhase('2', none)).toBe(2);
    expect(currentPhase(undefined, merged)).toBe(3);
    expect(() => currentPhase(undefined, none)).toThrow(/phase is unknown/);
    expect(() => currentPhase('x', merged)).toThrow(/not a whole number/);
    expect(() => currentPhase('0', merged)).toThrow(/not a whole number/);
  });
  it('derives the phase from merged tasks, so an unbumped working-state heading cannot narrow it (F-47)', () => {
    // reason: F-47; the phase used to come from a prose heading in .build/BUILD_STATE.md
    expect(phaseFromMergedTasks([])).toBe(1);
    expect(phaseFromMergedTasks(['CP1'])).toBe(2);
    expect(phaseFromMergedTasks(['CP3', 'CP1', 'CP2'])).toBe(4);
    expect(phaseFromMergedTasks(['CP8A', 'P1-REPO'])).toBe(1);
    expect(phaseFromMergedTasks(['CP9'])).toBe(9);
  });
  it('reads a done checkpoint from the plan, since a checkpoint never leaves a Task trailer (F-74)', () => {
    // reason: F-74; CP1 is Iso: none, so without this the phase stayed 1 after CP1 was certified
    const plan = '#### CP1 \u2014 Phase 1 checkpoint\nStatus: DONE\n\n#### CP2 \u2014 Phase 2 checkpoint\nStatus: NEW\n\n#### CP8A \u2014 x\nStatus: DONE\n';
    expect(doneCheckpoints(plan)).toEqual(['CP1']);
    expect(phaseFromMergedTasks(['P1-REPO', ...doneCheckpoints(plan)])).toBe(2);
    expect(doneCheckpoints('#### CP1 \u2014 x\nStatus: NEW\n')).toEqual([]);
  });
  it('reads the live merged tasks on the integration branch', () => {
    // reason: F-47; the source exists today and gives a phase from 1 to 9
    const n = currentPhase(undefined, readMergedTasks);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(9);
  });
  it('run-inventory exits 2 on an unreadable BW_PHASE and 0 on an empty selection', () => {
    // reason: F-39; fail closed
    const run = (phase: string) =>
      spawnSync('node', ['ci/page-walkers/run-inventory.ts'], { env: { ...process.env, BW_PHASE: phase }, encoding: 'utf8' });
    expect(run('abc').status).toBe(2);
    expect(run('1').status).toBe(0);
    // why: F-308; a fixed merged set (BW_MERGED_TASKS) so the case holds whatever is merged live: P2-AUTH and P2-SHELL stay unmerged here
    const at4 = spawnSync('node', ['ci/page-walkers/run-inventory.ts'], { env: { ...process.env, BW_PHASE: '4', BW_MERGED_TASKS: 'CP1' }, encoding: 'utf8' });
    expect(at4.status).toBe(2);
    expect(at4.stdout).toContain('waiting on');
  });
});

describe('select a row once its task is merged (F-154)', () => {
  const row = { screen: 'SCR-X-01', name: 'x', type: 'page', route: '/x', phase: 2, task: 'P2-AUTH' } as const;
  const known = new Set(['P2-AUTH', 'P2-SHELL']);
  const run = (env: Record<string, string>) =>
    spawnSync('node', ['ci/page-walkers/run-inventory.ts'], { env: { ...process.env, BW_PHASE: '2', ...env }, encoding: 'utf8' });

  it('selects the same row only when its task is merged; an unmerged one is listed as waiting', () => {
    // why: F-154; a page is checked from the moment its task merges, so a wave run does not fail on pages nobody built yet
    const before = selectMerged([row], 2, new Set(), known);
    expect(before.selected).toEqual([]);
    expect(before.waiting.map((r) => r.screen)).toEqual(['SCR-X-01']);
    expect(before.problems).toEqual([]);
    const after = selectMerged([row], 2, new Set(['P2-AUTH']), known);
    expect(after.selected.map((r) => r.screen)).toEqual(['SCR-X-01']);
    expect(after.waiting).toEqual([]);
  });
  it('says why a named walk reaches 0 screens: the task holds no row, or the set gives too early a phase', () => {
    // why: F-834; BW_MERGED_TASKS=P4-BOARD-MAP walked 0 screens and the only word was "No test found", because a row names the task that built its page
    const late = { ...row, phase: 4, task: 'P4-BOARD' };
    const noRow = emptyWalkWhy([late], 1, new Set(['P4-BOARD-MAP']));
    expect(noRow).toContain('phase 1');
    expect(noRow).toContain('P4-BOARD-MAP holds no inventory row');
    expect(noRow).toContain('BW_MERGED_TASKS=CP3,P4-BOARD');
    expect(emptyWalkWhy([late], 1, new Set(['P4-BOARD']))).toContain("P4-BOARD's 1 row(s) start at phase 4");
    expect(emptyWalkWhy([late], 1, new Set(['CP1']))).toContain('the merged set names no task');
    const lane = run({ BW_PHASE: '', BW_MERGED_TASKS: 'P4-BOARD-MAP' });
    expect(lane.status).toBe(0);
    expect(lane.stdout).toContain('P4-BOARD-MAP holds no inventory row');
  });
  it('is red for an earlier-phase row whose task is still not merged', () => {
    // why: F-154; safeguard a: a phase should not have closed without the task that builds its page
    const early = { ...row, phase: 1 };
    expect(selectMerged([early], 2, new Set(), known).problems.join()).toContain('not merged');
    expect(selectMerged([early], 2, new Set(['P2-AUTH']), known).problems).toEqual([]);
    expect(selectMerged([row], 2, new Set(), known).problems).toEqual([]);
  });
  it('is red for a task id the plan does not declare, whatever the phase', () => {
    // why: F-154; safeguard b: a typo in the task field must not hide a row forever
    const typo = { ...row, task: 'P2-AUHT' };
    expect(selectMerged([typo], 2, new Set(), known).problems.join()).toContain('not a task heading');
    expect(selectMerged([{ ...typo, phase: 5 }], 2, new Set(), known).problems.join()).toContain('not a task heading');
    expect(selectMerged([row], 2, new Set(), known).problems).toEqual([]);
    expect(planTaskIds('#### P2-AUTH — Sign-in\n#### CP1 - x\ntext #### P9-NO — y\n')).toEqual(new Set(['P2-AUTH', 'CP1']));
  });
  it('keeps a merged task with no app wiring red (exit 2), and the real repo state green with the 6 rows named', () => {
    // why: F-154; safeguard c: merging the task without wiring the page must not pass
    // F-645: the unwired task is synthetic (a fixture plan and inventory), never a real plan task, so this case does not
    // change when a real task merges and wires its pages.
    const dir = mkdtempSync(join(tmpdir(), 'bw-f645-'));
    const planFile = join(dir, 'plan.md');
    const invFile = join(dir, 'inventory.json');
    writeFileSync(planFile, '#### CP1 - x\n#### PX-SYNTHETIC-UNWIRED - never a plan task\n');
    writeFileSync(invFile, JSON.stringify({ screens: [{ screen: 'SCR-ZZ-99', name: 'synthetic unwired', type: 'page', route: '/zz', phase: 4, task: 'PX-SYNTHETIC-UNWIRED' }] }));
    const merged = run({ BW_PHASE: '4', BW_MERGED_TASKS: 'CP1,PX-SYNTHETIC-UNWIRED', BW_PLAN_FILE: planFile, BW_INVENTORY_FILE: invFile });
    rmSync(dir, { recursive: true, force: true });
    expect(merged.status).toBe(2);
    expect(merged.stderr).toContain('no app wiring yet: SCR-ZZ-99');
    expect(run({ BW_MERGED_TASKS: 'CP1,P2-AUTH,P2-SHELL' }).status).toBe(0);
    const waiting = run({ BW_MERGED_TASKS: 'CP1' });
    expect(waiting.status).toBe(0);
    expect(waiting.stdout).toContain('waiting on P2-AUTH: SCR-GATE-01, SCR-GATE-02, SCR-OFC-01');
    expect(waiting.stdout).toContain('waiting on P2-SHELL: SCR-SHR-01, SCR-SHR-02, SCR-SHR-03');
    expect(run({ BW_PHASE: '3', BW_MERGED_TASKS: 'CP1' }).status).toBe(2);
  });
});

describe('proof set (F-39)', () => {
  it('is Chromium and WebKit, and a narrowed run must say why', () => {
    // reason: F-39; BW_PW_ENGINES=chromium used to pass with 12 tests and no notice that WebKit was dropped
    expect([...ALL_ENGINE_NAMES]).toEqual(['chromium', 'webkit']);
    expect(resolveEngines(undefined, undefined)).toEqual({ names: ['chromium', 'webkit'], notice: null });
    expect(() => resolveEngines('chromium', undefined)).toThrow(/without a reason/);
    expect(() => resolveEngines('chromium', '  ')).toThrow(/without a reason/);
    expect(resolveEngines('chromium', 'no WebKit build on this Mac').notice).toContain('DROPPED ENGINE webkit: no WebKit build');
    expect(() => resolveEngines('firefox', 'x')).toThrow(/unknown/);
    expect(resolveEngines('webkit,chromium', undefined).notice).toBeNull();
  });
  it('walkers.pw.test.ts holds a known-bad proof and a clean proof for each of the 5 walkers', () => {
    // reason: F-39; a proof dropped from the file must turn the merge set red, not the wave gate quietly smaller
    const src = readFileSync('ci/page-walkers/walkers.pw.test.ts', 'utf8');
    const titles = [...src.matchAll(/^\s*it\('([^']+)'/gm)].map((m) => m[1]!);
    for (const w of ['axe-scan', 'tap-target-44', 'outside-origin-guard', 'spanish-fallback-pass', 'overflow-pass']) {
      expect(titles.filter((t) => t.startsWith(`${w} flags`) || t.startsWith(`${w} fails`)).length, `${w} known-bad`).toBeGreaterThan(0);
      expect(titles.filter((t) => t.startsWith(`${w} passes`)).length, `${w} clean`).toBeGreaterThan(0);
    }
  });
});

describe('spanish-fallback literal runs (ICU values)', () => {
  it('takes the text between arguments, inside plural branches too, and keeps runs of 2 or more words', () => {
    // reason: F-41; the catalog holds ICU messages, so the forbidden set is built from literal runs, not raw source
    expect(literalRuns('{count} jobs today')).toEqual(['jobs today']);
    expect(literalRuns('{n, plural, one {# job left} other {# jobs left}} on route')).toEqual(['job left', 'jobs left', 'on route']);
    expect(literalRuns('Open')).toEqual([]);
    expect(literalRuns('Save changes')).toEqual(['Save changes']);
  });
  it('keeps no run of 1 letter word and punctuation, so technicians.det.waitNote does not match an office note', () => {
    // reason: F-849; "{name}, {van}. The {n, plural, ...}" left the run ". The", which a note ("... side door. The front steps") contains
    expect(literalRuns('{name}, {van}. The {n, plural, one {# item sends} other {# items send}} when the phone has signal again.')).not.toContain('. The');
    expect(literalRuns('{a}. The {b}')).toEqual([]);
  });
  it('drops a run the Spanish catalog shares, and a key whose Spanish value is the same', () => {
    // reason: F-41; a cognate phrase is not a fallback
    expect(
      forbiddenRuns({
        en: { a: '{count} jobs today', b: 'Total due', c: 'Route list' },
        es: { a: '{count} trabajos hoy', b: 'Total due', c: 'Lista de ruta' },
      }),
    ).toEqual(['jobs today', 'Route list']);
  });
});
