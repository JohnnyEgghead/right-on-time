// SPDX-License-Identifier: AGPL-3.0-or-later
// P6-ROUTING-MEMORY closing cycle (F-1343): the keys of the summary's macClose block that routing-memory-summary.mjs does not make, made from
// its output and the rig's raw files by a committed step, so the whole block can be remade (nothing added by hand).
//   node infra/load/routing-memory-close.mjs <summarizer output.json> <earlier summary.json (its mac block: the uncapped run)> <app head> <cap tag> <unrouted-<tag>.json> > <macClose.json>
// Added: per mode `passes` (the pass line below); `source`, `passLine`, `appHead`; `localCap` (the uncapped routing peak of the earlier summary's
// mac block, mode mnone, and the cap tag's cap: the margin is the cap less the peak); `unroutedReads` (the rig's unrouted-<tag>.json, its timings only).
import { readFileSync } from 'node:fs';
import { isMain } from '../../ci/is-main.ts';

export const SD49_MS = 3000;
export const PASS_LINE = 'every run routes every leg of the list, route p95 within SD-49 3000 ms, routing 0 OOM kills and 0 restarts; stop rule: a run 1 under the line ends the setting';
export const SOURCE = 'infra/load/routing-memory-summary.mjs over the routing-memory.sh out folder (raw files kept in .build/evidence/P6-ROUTING-MEMORY-CLOSE/mac-out, not committed)';

/** Whether a mode (a summarizer entry) meets the pass line: every run routes every leg within SD-49, and routing is never killed or restarted. */
export function passes(mode) {
  const killed = (mode.events?.routing?.oom_kill ?? 0) > 0 || (mode.events?.routing?.oom ?? 0) > 0;
  const restarted = !/restarts=0(\s|$)/.test(mode.state?.routing ?? '') || /oom=true/.test(mode.state?.routing ?? '');
  const runsOk = mode.perRun.length > 0 && mode.perRun.every((r) => r.burst.routed === r.burst.legs && r.burst.failed === 0 && r.burst.ms.p95 <= SD49_MS && r.burst.overSd49 === 0);
  return runsOk && !killed && !restarted;
}

const round1 = (x) => Math.round(x * 10) / 10;

/** The cap in MiB of a tag's mode: 'collected ... cap=1280m ...' in its setting line. */
export function capMiB(setting) {
  const m = /cap=(\d+)m\b/.exec(setting);
  if (!m) throw new Error(`no cap in the setting: ${setting}`);
  return Number(m[1]);
}

export function localCap(uncappedMode, capTag, cappedMode, headOfUncapped) {
  const uncapped = uncappedMode.peakMiB.routing.peakMiB;
  const cap = capMiB(cappedMode.setting);
  return { uncappedPeakMiB: uncapped, uncappedPeakFrom: `mac.modes[tag ${uncappedMode.tag}].peakMiB.routing (same rig, no memory limit, head ${headOfUncapped})`, capMiB: cap, marginMiB: round1(cap - uncapped) };
}

export function unroutedReads(u) {
  return { task: u.task, finding: u.finding, api: u.api, routing: u.routing, pair: u.pair, bakedPair: u.bakedPair, reads: u.reads, ownTimeMs: u.ownTimeMs, limitMs: u.limitMs, pass: u.pass, unroutedMs: u.unroutedMs, bakedMs: u.bakedMs };
}

/** The macClose block: the summarizer's own output with the derived keys added. */
export function closeBlock({ summary, earlier, appHead, capTag, unrouted, uncappedHead }) {
  const modes = summary.modes.map((m) => ({ ...m, passes: passes(m) }));
  const uncapped = earlier.mac.modes.find((m) => m.tag === 'mnone');
  const capped = modes.find((m) => m.tag === capTag);
  if (!uncapped || !capped) throw new Error('the uncapped mode mnone or the cap tag is missing');
  return { ...summary, modes, source: SOURCE, passLine: PASS_LINE, appHead, localCap: localCap(uncapped, capTag, capped, uncappedHead ?? earlier.mac.head), unroutedReads: unroutedReads(unrouted) };
}

if (isMain(import.meta.url)) {
  const [summaryFile, earlierFile, appHead, capTag, unroutedFile] = process.argv.slice(2);
  if (!unroutedFile) throw new Error('usage: routing-memory-close.mjs <summary.json> <earlier summary.json> <app head> <cap tag> <unrouted.json>');
  const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
  console.log(JSON.stringify(closeBlock({ summary: read(summaryFile), earlier: read(earlierFile), appHead, capTag, unrouted: read(unroutedFile) }), null, 1));
}
