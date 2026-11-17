// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain .mjs script with no types
import { capMiB, closeBlock, passes } from '../infra/load/routing-memory-close.mjs';

// The committed summary is the oracle: its macClose block is what the closing step must remake from the summarizer's part of it.
// F-1852: docs/build/ is a private path (scripts/private-paths.txt), so in a public copy the tests that read the summary skip with a
// note naming it; the private checkout has it and they run.
const SUMMARY = new URL('../docs/build/spikes/P6-ROUTING-MEMORY.summary.json', import.meta.url);
const noSummary = existsSync(SUMMARY) ? '' : 'docs/build/spikes/P6-ROUTING-MEMORY.summary.json is not in this copy (a private path the public export leaves out)';
const committed = noSummary ? { macClose: {} } : JSON.parse(readFileSync(SUMMARY, 'utf8'));
const mc = committed.macClose;

describe('the macClose derived keys (routing-memory-close.mjs)', () => {
  // why: F-1343 the keys added to macClose by hand (passes, source, passLine, appHead, localCap, unroutedReads) come from the committed step, and remake the committed block
  it('remakes the committed macClose block from the summarizer part of it', (ctx) => {
    if (noSummary) ctx.skip(noSummary);
    const summary = { ...mc, modes: mc.modes.map((m: Record<string, unknown>) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'passes'))) };
    for (const k of ['source', 'passLine', 'appHead', 'localCap', 'unroutedReads']) delete (summary as Record<string, unknown>)[k];
    const made = closeBlock({ summary, earlier: committed, appHead: mc.appHead, capTag: 'c1280', unrouted: { ...mc.unroutedReads, unrouted: [], baked: [] } });
    expect(made).toEqual(mc);
  });

  // why: F-1343 localCap.uncappedPeakMiB is read from the uncapped run's routing peak in mac.modes, never typed: a changed peak changes the figure and the margin
  it('reads the uncapped peak from mac.modes and ties the margin to the cap', (ctx) => {
    if (noSummary) ctx.skip(noSummary);
    expect(mc.localCap.uncappedPeakMiB).toBe(committed.mac.modes.find((m: { tag: string }) => m.tag === 'mnone').peakMiB.routing.peakMiB);
    expect(mc.localCap.capMiB).toBe(capMiB(mc.modes.find((m: { tag: string }) => m.tag === 'c1280').setting));
    expect(mc.localCap.marginMiB).toBeCloseTo(mc.localCap.capMiB - mc.localCap.uncappedPeakMiB, 1);
  });

  // why: F-1343 the up step writes ids-<tag>.txt per cap, so the c1280 up cannot overwrite the c320 ids (both are mode mmap)
  it('has the rig write the ids file per cap, not per mode', () => {
    const sh = readFileSync(new URL('../infra/load/routing-memory.sh', import.meta.url), 'utf8');
    expect(sh).toContain('>"$dir/out/ids-c${cap%m}.txt"');
    expect(sh).not.toContain('ids-$mode.txt');
  });

  // why: F-1343 the pass line: a run that routes fewer legs, a routing OOM kill or a restart is a fail
  it('applies the pass line', (ctx) => {
    if (noSummary) ctx.skip(noSummary);
    const c1280 = mc.modes.find((m: { tag: string }) => m.tag === 'c1280');
    expect(passes(c1280)).toBe(true);
    expect(passes(mc.modes.find((m: { tag: string }) => m.tag === 'c320'))).toBe(false);
    expect(passes({ ...c1280, events: { routing: { oom_kill: 1 } } })).toBe(false);
    expect(passes({ ...c1280, state: { routing: 'running oom=false restarts=1 started=x' } })).toBe(false);
  });
});
