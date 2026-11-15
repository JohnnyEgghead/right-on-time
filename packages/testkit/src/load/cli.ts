// SPDX-License-Identifier: AGPL-3.0-or-later
// The load script's command line (P4-LOAD, P7-LOAD reuses it): runs the load day N times and writes the output file.
//   NODE_EXTRA_CA_CERTS=<the temporary server's certificate> node packages/testkit/src/load/cli.ts \
//     --origin https://<ip> --world <world.json> --out <dir> --label main --runs 5 --first-run 1 --run-seconds 1700 --rest-seconds 0 \
//     --vans on --instance-plan small_3_0
// The 20 runs of a label may be made in chunks (F-883): --first-run continues the numbering and the seeds, so runs 6 to 10 are
// --runs 5 --first-run 6, and a stopped chunk loses only its own runs. <dir>/<label>-run-NN.json holds each run's raw delays and how
// it was made (never committed). <dir>/<label>-summary.json is rewritten after every run from every run file of the label in <dir>,
// so it always pools runs 1 to N as measured; it refuses a set with a gap, a repeat or 2 shapes. --rest-seconds is an idle wait
// before each run but the first of a chunk, so every run starts with the server in the same CPU state.
// P7-LOAD adds --pages on (NFR-02: office pages in a browser on the office profile, pages.ts; --page-cert is the server's
// certificate, --page-every-seconds the cycle) and, in every run, the end-state check and the NFR-03 counts; --task names the record.
// F-1498: --routing on|off names the arm (the routing service up at its cap, or stopped; run-day.sh sets it from BW_LOAD_ROUTING): it
// is part of a run's shape, so 1 label never pools the 2 arms, and the summary says which arm it is.
// Exit 0: every run finished. Exit 1: a run could not finish, or the run set is not whole. The verdict is in the file.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildTimeline, checkLoadDay, squeeze, type LoadWorld } from './plan.ts';
import { addedLatencyMs, baseRttMs, OFFICE_PAGES } from './pages.ts';
import { runLoad, type RunResult } from './run.ts';
import { LOAD_DAY_RUNS, nfr01Passes, nfr02Passes, nfr03Of, OFFICE_PROFILE, pool, poolPages, runSetProblem, type RunShape } from './stats.ts';

const { values: a } = parseArgs({
  options: {
    origin: { type: 'string' }, world: { type: 'string' }, out: { type: 'string' }, label: { type: 'string', default: 'main' },
    runs: { type: 'string', default: '20' }, 'first-run': { type: 'string', default: '1' }, 'run-seconds': { type: 'string', default: '600' },
    'rest-seconds': { type: 'string', default: '0' }, vans: { type: 'string', default: 'on' },
    'instance-plan': { type: 'string' }, 'reassign-share': { type: 'string', default: '0.05' }, seed: { type: 'string', default: '1' },
    'settle-seconds': { type: 'string', default: '30' }, 'runs-required': { type: 'string', default: String(LOAD_DAY_RUNS) },
    task: { type: 'string', default: 'P4-LOAD' }, pages: { type: 'string', default: 'off' }, 'page-cert': { type: 'string' },
    'page-every-seconds': { type: 'string', default: '10' }, routing: { type: 'string', default: 'on' },
    // The hosted mode (infra/load/hosted-day.sh, owner answer f3d84787) runs on the hosted server itself and says so here.
    'server-kind': { type: 'string', default: 'temporary copy of the hosted plan' },
  },
});
const runsRequired = Number(a['runs-required']);
if (!a.origin || !a.world || !a.out || !a['instance-plan']) {
  console.error('load: --origin, --world, --out and --instance-plan are required');
  process.exit(2);
}
const world = JSON.parse(readFileSync(a.world, 'utf8')) as LoadWorld;
checkLoadDay(world);
const durationMs = Number(a['run-seconds']) * 1000;
const runs = Number(a.runs);
const firstRun = Number(a['first-run']);
const restSeconds = Number(a['rest-seconds']);
const reassignShare = Number(a['reassign-share']);
const vans = a.vans === 'on';
const pagesOn = a.pages === 'on';
if (a.routing !== 'on' && a.routing !== 'off') {
  console.error('load: --routing is on or off');
  process.exit(2);
}
const routing = a.routing;
if (pagesOn && !a['page-cert']) {
  console.error('load: --pages on needs --page-cert');
  process.exit(2);
}
const log = (line: string): void => console.log(`${process.uptime().toFixed(0)} s ${line}`);
mkdirSync(a.out, { recursive: true });

type RunFile = RunResult & { shape: RunShape };
const runPath = (n: number): string => join(a.out!, `${a.label}-run-${String(n).padStart(2, '0')}.json`);
for (let n = firstRun; n < firstRun + runs; n++) {
  if (existsSync(runPath(n))) {
    console.error(`load: refused: ${runPath(n)} exists; a measured run is never replaced`);
    process.exit(2);
  }
}

// NFR-02's profile: the real round trip to the server, measured once, plus the latency that makes it 20 ms (pages.ts).
const rtt = pagesOn ? await baseRttMs(new URL(a.origin).hostname) : Number.NaN;
const added = pagesOn ? addedLatencyMs(rtt) : 0;
const pager = world.dispatchers[0]!;
const pageOptions = pagesOn ? {
  origin: a.origin, token: pager.token, branch: pager.branch, jobs: world.jobs.filter((j) => j.branch === pager.branch).map((j) => j.jobNumber),
  certPem: readFileSync(a['page-cert']!, 'utf8'), addedLatencyMs: added, everyMs: Number(a['page-every-seconds']) * 1000,
} : null;
if (pagesOn) log(`pages: base round trip ${rtt.toFixed(1)} ms, added latency ${added} ms, ${OFFICE_PROFILE.mbps} Mbps`);

const summaryPath = join(a.out, `${a.label}-summary.json`);
const finite = (n: number): number | null => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null);
/** Every run file of the label, in run order: the pooled figure is over all of them, never only this chunk's. */
const readRuns = (): RunFile[] => {
  const name = new RegExp(`^${a.label}-run-(\\d+)\\.json$`);
  return readdirSync(a.out!).filter((f) => name.test(f)).sort()
    .map((f) => JSON.parse(readFileSync(join(a.out!, f), 'utf8')) as RunFile)
    .sort((x, y) => x.shape.run - y.shape.run);
};
const writeSummary = (): string | null => {
  const results = readRuns();
  const problem = runSetProblem(results.map((r) => r.shape));
  const p = pool(results);
  const pg = poolPages(results.map((r) => r.pages ?? { coldMs: [], warmMs: [], errors: 0, errorsBy: {} }));
  const n3 = nfr03Of(results.map((r) => ({ ...r, vanReadErrors: r.vanReadErrors ?? 0, pageErrors: r.pageErrors ?? 0, endState: r.endState ?? { jobs: 0, matched: 0, behind: 0, ahead: 0, missing: 0 }, endStateErrors: r.endStateErrors ?? 0 })), runsRequired);
  writeFileSync(summaryPath, `${JSON.stringify({
    task: a.task, label: a.label, instancePlan: a['instance-plan'], origin: a['server-kind'],
    shape: { jobs: world.jobs.length, dispatchers: world.dispatchers.length, technicians: world.technicians.length, branches: new Set(world.jobs.map((j) => j.branch)).size },
    routing, runSeconds: durationMs / 1000, squeezeFactor: finite(squeeze(world, durationMs)), restSeconds, vans, reassignShare, seed: Number(a.seed),
    runSet: problem ?? 'runs 1 to N, 1 shape', runsRequired,
    firstRunStart: results[0]?.startedAt ?? null, lastRunEnd: results[results.length - 1]?.endedAt ?? null,
    nfr01: { p50Ms: finite(p.p50Ms), p95Ms: finite(p.p95Ms), p95S: finite(p.p95S), p99Ms: finite(p.p99Ms), maxMs: finite(p.maxMs), passes: problem === null && nfr01Passes(p, runsRequired) },
    nfr02: pagesOn ? {
      profile: { ...OFFICE_PROFILE, baseRttMs: finite(rtt), addedLatencyMs: added }, pages: OFFICE_PAGES.length,
      samples: pg.samples, warmSamples: pg.warmSamples, errors: pg.errors, coldErrors: pg.coldErrors, coldAttempts: pg.coldAttempts, p50Ms: finite(pg.p50Ms), p95Ms: finite(pg.p95Ms), p95S: finite(pg.p95S), maxMs: finite(pg.maxMs),
      warmP95Ms: finite(pg.warmP95Ms), passes: problem === null && nfr02Passes(pg, runsRequired),
    } : null,
    nfr03: { ...n3, passes: problem === null && n3.passes },
    totals: { runs: p.runs, samples: p.samples, lost: p.lost, writesPlanned: p.writesPlanned, writesApplied: p.writesApplied, writesRefused: p.writesRefused, writesFailed: p.writesFailed, boardReadErrors: p.boardReadErrors },
    perRun: results.map((r, i) => ({
      run: r.shape.run, startedAt: r.startedAt, endedAt: r.endedAt, loadAvg1Start: r.loadAvg1Start, loadAvg1End: r.loadAvg1End, clientLoopDelayMs: r.clientLoopDelayMs,
      p95Ms: finite(p.runP95Ms[i] as number), pageP95Ms: finite(pg.runP95Ms[i] ?? Number.NaN), pageSamples: r.pages?.coldMs.length ?? 0, pageErrorsBy: r.pages?.errorsBy ?? {}, pageColdErrors: r.pages?.coldErrors ?? null, pageWarmErrors: r.pages?.warmErrors ?? null,
      endState: r.endState ?? null, vanReadErrors: r.vanReadErrors ?? null, samples: r.delaysMs.length, lost: r.lost, writesApplied: r.writesApplied, writesRefused: r.writesRefused, writesFailed: r.writesFailed,
      itemRetries: r.writes.itemRetries, refusedBy: r.writes.refusedBy, failedBy: r.writes.failedBy, streams: r.streams, board: r.board, vans: r.vans, vanRoutes: r.vanRoutes ?? null, itemMs: r.writes.itemMs, assignMs: r.writes.assignMs, durationMs: Math.round(r.durationMs),
    })),
  }, null, 1)}\n`);
  return problem;
};

const rest = (s: number): Promise<void> => new Promise((r) => setTimeout(r, s * 1000));
try {
  for (let n = firstRun; n < firstRun + runs; n++) {
    if (n > firstRun && restSeconds > 0) {
      log(`${a.label} rest ${restSeconds} s before run ${n}`);
      await rest(restSeconds);
    }
    log(`${a.label} run ${n} (${n - firstRun + 1} of ${runs} in this chunk) begins`);
    const timeline = buildTimeline(world, { durationMs, reassignShare, seed: Number(a.seed) + n - 1 });
    const r = await runLoad({ origin: a.origin, world, timeline, vans, settleMs: Number(a['settle-seconds']) * 1000, pages: pageOptions, log });
    const shape: RunShape = { run: n, runSeconds: durationMs / 1000, vans, reassignShare, restSeconds, ...(pagesOn ? { pages: true } : {}), routing };
    writeFileSync(runPath(n), `${JSON.stringify({ ...r, shape })}\n`);
    const problem = writeSummary();
    if (problem) throw new Error(`the run set is not whole: ${problem}`);
    const p = pool([r]);
    if (r.pages) log(`${a.label} run ${n} pages: cold p95 ${poolPages([r.pages]).p95Ms.toFixed(0)} ms x ${r.pages.coldMs.length}, warm p95 ${poolPages([r.pages]).warmP95Ms.toFixed(0)} ms, ${r.pages.errors} errors`);
    log(`${a.label} run ${n}: p95 ${p.p95Ms.toFixed(0)} ms, ${p.samples} samples, ${p.lost} lost, ${r.writesApplied}/${r.writesPlanned} writes, ${r.writesRefused} refused, ${r.writesFailed} failed, board p50 ${r.board.ms.p50.toFixed(0)} p95 ${r.board.ms.p95.toFixed(0)} ms x ${r.board.count}, client load ${r.loadAvg1Start.toFixed(2)}`);
  }
} catch (e) {
  console.error(`load: stopped: ${(e as Error).message}`);
  writeSummary();
  process.exit(1);
}
const all = pool(readRuns());
log(`${a.label} pooled over ${all.runs} runs: p95 ${all.p95S.toFixed(3)} s, ${all.samples} samples, ${all.lost} lost`);
process.exit(0);
