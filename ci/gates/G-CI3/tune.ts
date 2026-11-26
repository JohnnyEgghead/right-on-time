// SPDX-License-Identifier: AGPL-3.0-or-later
// The build-tuning instrument of SD-27 and SD-15 (P3-OFFICE-WRITES; record docs/build/spikes/P3-OFFICE-WRITES.md):
//   node ci/gates/G-CI3/tune.ts
// 1. Per-window limits (SD-27: under 2 in a 2-hour window, under 3 in a 4-hour window): the generator's demo-week jobs
//    (seed 20260915, the world seed's fixture) per technician, day and window, against the limits and the daily 5.
// 2. The at-risk margin (SD-15: 15 minutes): the approved board of the sample day (mockups/src/office/board.html,
//    Tue Sep 15, 10:28 AM: "1 Late", "2 At risk") read for each listed job's ETA and window end, and the margins that
//    reproduce its counts with the rule of @bw/domain timingOf.
// Not a gate step: it measures, it does not pass or fail anything.
// Kept as evidence, nothing calls it: it made the measured record that set the per-window job limits (2 and 3) and the 15-minute at-risk margin; run it by hand to repeat that measurement.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PER_WINDOW_LIMIT, timingOf } from '../../../packages/domain/src/index.ts';
import { generate } from '../../../packages/generator/src/generate.ts';
import { loadInputs } from '../../../packages/generator/src/io.ts';
import { parseFixture } from '../../../packages/setup/src/fixture.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

// 1. Per-window limits on the demo week.
const fx = parseFixture(generate(loadInputs())['fixture.json']);
// F-1687: each job's own window (its end minus its start) sets the limit that applies; a job no technician holds is not counted.
const hours = (t: string) => Number(t.slice(0, 2)) + Number(t.slice(3, 5)) / 60;
const perWindow = new Map<string, { n: number; length: number }>();
const perDay = new Map<string, number>();
let unassigned = 0;
for (const j of fx.demoWeekJobs) {
  if (j.technician === null) {
    unassigned++;
    continue;
  }
  const key = `${j.technician}|${j.date}|${j.windowStart}-${j.windowEnd}`;
  const w = perWindow.get(key) ?? { n: 0, length: hours(j.windowEnd) - hours(j.windowStart) };
  w.n++;
  perWindow.set(key, w);
  perDay.set(`${j.technician}|${j.date}`, (perDay.get(`${j.technician}|${j.date}`) ?? 0) + 1);
}
const histogram = (m: Map<string, number>) => {
  const h = new Map<number, number>();
  for (const v of m.values()) h.set(v, (h.get(v) ?? 0) + 1);
  return [...h.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}: ${v}`).join(', ');
};
const days = [...new Set(fx.demoWeekJobs.map((j) => j.date))].sort();
const sampleDay = fx.demoWeekJobs.filter((j) => j.date === '2026-09-15');
console.log(`tune: demo week ${days[0]} to ${days.at(-1)}: ${fx.demoWeekJobs.length} jobs (${sampleDay.length} on Tue Sep 15), ${unassigned} with no technician (not counted below)`);
for (const [length, mode] of [[2, 'two_hour'], [4, 'four_hour']] as const) {
  const counts = new Map([...perWindow].filter(([, w]) => w.length === length).map(([k, w]) => [k, w.n] as const));
  if (counts.size === 0) continue;
  const overLimit = [...counts.values()].filter((v) => v > PER_WINDOW_LIMIT[mode]).length;
  console.log(`tune: jobs per technician per ${length}-hour window: ${histogram(counts)}; max ${Math.max(...counts.values())}; over the limit of ${PER_WINDOW_LIMIT[mode]}: ${overLimit}`);
}
const otherLengths = new Set([...perWindow.values()].map((w) => w.length).filter((l) => l !== 2 && l !== 4));
if (otherLengths.size > 0) console.log(`tune: windows of other lengths (hours): ${[...otherLengths].join(', ')} (no limit applies; not counted above)`);
console.log(`tune: jobs per technician per day: ${histogram(perDay)}; max ${Math.max(...perDay.values())} (daily capacity 5)`);

// 2. The at-risk margin against the approved board.
const board = readFileSync(path.join(ROOT, 'mockups', 'src', 'office', 'board.html'), 'utf8').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const minutes = (t: string, pm: boolean) => {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return ((h % 12) + (pm ? 12 : 0)) * 60 + m;
};
const rows = [...board.matchAll(/(Late|At risk) (\w+) - [\w ]+? [\w]+ [A-Z]\. - ETA (\d{1,2}:\d{2}) (AM|PM), window (\d{1,2})-(\d{1,2})/g)].map((m) => {
  const end = Number(m[6]);
  const endMin = (end < 8 ? end + 12 : end) * 60;
  return { shown: m[1] as string, name: m[2] as string, eta: minutes(m[3] as string, m[4] === 'PM'), end: endMin };
});
const shownLate = rows.filter((r) => r.shown === 'Late').length;
const shownRisk = rows.filter((r) => r.shown === 'At risk').length;
console.log(`tune: approved board lists ${rows.length} jobs: ${rows.map((r) => `${r.name} ${r.shown}, ETA ${r.end - r.eta} min before its window end`).join('; ')}`);
const fits: number[] = [];
for (let margin = 0; margin <= 60; margin += 5) {
  const t = rows.map((r) => timingOf(r.eta * 60_000, r.end * 60_000, margin));
  const ok = t.filter((x) => x === 'late').length === shownLate && t.filter((x) => x === 'at_risk').length === shownRisk;
  if (ok) fits.push(margin);
}
console.log(`tune: margins (0 to 60, step 5) that reproduce "${shownLate} Late" and "${shownRisk} At risk": ${fits.join(', ')}; smallest ${fits[0]}`);
