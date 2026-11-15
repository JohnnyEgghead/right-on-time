// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-IMP-1, FR-IMP-10 (P3-IMPORT-WORKER Acceptance: the worker's import job on the Compose stack at its default settings)
// The world is a fresh setup's (ci/import-stack.sh). Each case requests through API-80 as an office user and does
// nothing else to make the run happen: the worker, started by its real start-up, executes it.
//   1. A dry run answers 202, API-81 shows stage and percent moving, an open stream receives EVT-08 with the run id only
//      at each change (counted against the run's own state writes) and at the finish, and the run ends done with a
//      report equal to setup's dry-run counts (FR-IMP-6): the totals, the problems by reason and the pairs (F-533).
//   2. The worker killed mid-run (SIGKILL) leaves the row running; once the restarted worker's heartbeat is fresh, the
//      row is executed again and ends in 1 done record with the same counts; a new request is then accepted.
//   3. A run whose worker is killed at each of its 3 attempts ends failed with attempts_exhausted, with no 4th attempt;
//      a new request is then accepted (owner ruling dc73cb08).
//   4. A planted changed byte in the generator's inputs: the export is refused by the manifest check, and the run ends
//      failed with generator_manifest, never left running; with the inputs restored a run ends done again.
// Must-fail probes (the lane report holds their runs): with the import job left out of the worker's registry, case 1
// times out with its row running; with the EVT-08 send removed, case 1's event count is 0.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const base = process.env.BW_IMPORT_STACK_URL;
const session = process.env.BW_IMPORT_STACK_SESSION;
const project = process.env.BW_IMPORT_STACK_PROJECT;
const tmp = process.env.BW_IMPORT_STACK_TMP;
if (!base || !session || !project || !tmp) throw new Error('BW_IMPORT_STACK_URL, _SESSION, _PROJECT and _TMP are not set: run ci/import-stack.sh');
const root = path.resolve(import.meta.dirname, '../..');
/** The app's origin at its default setting (SD-8: a cookie-carrying write must come from it). */
const APP_ORIGIN = 'http://localhost:8080';
const headers = { cookie: `bw_session=${session}` };

function run(cmd: string, args: string[], input?: string): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: root, input });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 6).join(' ')} failed (${r.status}): ${(r.stderr || r.stdout).slice(0, 400)}`);
  return r.stdout;
}
const compose = (...args: string[]) => run('docker', ['compose', '-p', project!, '-f', 'infra/compose.yaml', ...args]);
const containerOf = (service: string) => compose('ps', '-a', '-q', service).trim();
/** SQL in the stack's database as its owner login. */
const psql = (sql: string) => run('docker', ['exec', '-i', containerOf('db'), 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 240_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

interface RunRow { status: string; stage: string; percent: number; report: { attempts?: number; error?: string } | null }
const row = (id: string): RunRow => JSON.parse(psql(`SELECT row_to_json(r) FROM (SELECT status, stage, percent, report FROM world.import_run WHERE id = '${id}') r`)) as RunRow;

async function api(method: 'GET' | 'POST', p: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const init: RequestInit = body === undefined
    ? { method, headers }
    : { method, headers: { ...headers, 'content-type': 'application/json', origin: APP_ORIGIN }, body: JSON.stringify(body) };
  const res = await fetch(`${base}/api/v1${p}`, init);
  const json = (await res.json().catch(() => ({}))) as { data?: unknown };
  return { status: res.status, data: json.data ?? json };
}
async function requestDryRun(): Promise<string> {
  const r = await api('POST', '/import/runs', { kind: 'dry_run' });
  expect(r.status, JSON.stringify(r.data)).toBe(202);
  return (r.data as { runId: string }).runId;
}
const finished = (id: string) => until(`run ${id} to finish`, () => row(id).status !== 'running');

/**
 * The FR-IMP-6 counts as API-81 shows them, for a done run: the totals, the problems by reason (the stored report holds an object of
 * counts, API-81 an array of { reason, count, examples }; both are read as reason -> count) and the duplicate pairs (F-533).
 */
type Report = { customers: unknown; visits: unknown; equipment: unknown; problems: { total: number; byReason: unknown }; duplicates: unknown };
type Counts = { customers: unknown; visits: unknown; equipment: unknown; problems: { total: number; byReason: Record<string, number> }; duplicates: unknown };
const byReason = (v: unknown): Record<string, number> =>
  Array.isArray(v)
    ? Object.fromEntries((v as { reason: string; count: number }[]).map((x) => [x.reason, x.count]).sort())
    : Object.fromEntries(Object.entries((v ?? {}) as Record<string, number>).sort());
const countsOf = (r: Report): Counts => ({
  customers: r.customers, visits: r.visits, equipment: r.equipment, problems: { total: r.problems.total, byReason: byReason(r.problems.byReason) }, duplicates: r.duplicates,
});
/** Setup's dry run's counts, read from its stored report (the generator's checked output, imported by setup). */
let setupCounts: Counts;

/** SIGKILL the worker, as a crashed process: its connections end, its run lock with them. */
function killWorker(): void {
  run('docker', ['kill', '-s', 'KILL', containerOf('worker')]);
}
/** Start the worker again and wait until its heartbeat is fresh: written after this start. */
async function startWorker(): Promise<void> {
  const t = psql('SELECT now()');
  run('docker', ['start', containerOf('worker')]);
  await until('the restarted worker heartbeat', () => psql(`SELECT count(*) FROM system.worker_heartbeat WHERE beat_real > '${t}'`) === '1', 60_000);
}
const workerLog = () => run('docker', ['logs', containerOf('worker')]);

/** A raw reader of API-09, so the test sees the exact wire text. */
async function openStream(): Promise<{ text: () => string; close: () => void }> {
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/v1/events`, { headers: { ...headers, accept: 'text/event-stream' }, signal: ctl.signal });
  expect(res.status).toBe(200);
  let text = '';
  void (async () => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of res.body!) text += dec.decode(chunk as Uint8Array, { stream: true });
    } catch {
      // closed
    }
  })();
  return { text: () => text, close: () => ctl.abort() };
}
const frames = (t: string) => [...t.matchAll(/event: (\S+)\nid: (\d+)\ndata: (.*)\n\n/g)].map((m) => ({ event: m[1]!, data: JSON.parse(m[3]!) as { ids: Record<string, unknown> } }));

beforeAll(() => {
  const rep = JSON.parse(psql(`SELECT report FROM world.import_run WHERE by_setup AND kind = 'dry_run' AND status = 'done'`)) as Report;
  setupCounts = countsOf(rep);
  expect((setupCounts.customers as { total: number }).total).toBe(18_400);
});
afterAll(() => {
  psql('DROP TRIGGER IF EXISTS seen_state ON world.import_run; DROP FUNCTION IF EXISTS public.seen_state(); DROP TABLE IF EXISTS public.seen_state;');
});

describe('the worker executes an office import run (F-258)', () => {
  // why: FR-IMP-1
  it('a dry run requested through API-80 is finished by the worker, API-81 moving and EVT-08 at each change, with setup dry-run counts', async () => {
    // Every write of the row's stage, percent or status, as the database saw it, so the events can be counted against them.
    psql(`CREATE TABLE public.seen_state (n serial, run uuid, stage text, percent int, status text);
      GRANT INSERT ON public.seen_state TO app; GRANT USAGE ON SEQUENCE public.seen_state_n_seq TO app;
      CREATE FUNCTION public.seen_state() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF (NEW.stage, NEW.percent, NEW.status) IS DISTINCT FROM (OLD.stage, OLD.percent, OLD.status) THEN
        INSERT INTO public.seen_state (run, stage, percent, status) VALUES (NEW.id, NEW.stage, NEW.percent, NEW.status); END IF; RETURN NEW; END $$;
      CREATE TRIGGER seen_state AFTER UPDATE ON world.import_run FOR EACH ROW EXECUTE FUNCTION public.seen_state();`);
    const stream = await openStream();
    await sleep(500);
    const id = await requestDryRun();
    const seen: string[] = [];
    let last: { status: string; report: unknown } = { status: 'running', report: null };
    await until('API-81 to show the run done', async () => {
      const r = await api('GET', `/import/runs/${id}`);
      expect(r.status).toBe(200);
      const d = r.data as { status: string; stage: string; percent: number; report: unknown };
      const s = `${d.stage} ${d.percent}`;
      if (d.status === 'running' && seen.at(-1) !== s) seen.push(s);
      last = d;
      return d.status !== 'running';
    });
    expect(last.status).toBe('done');
    // the stage and percent moved while it ran (parse 0, then validate 10, match 20, write 30 and on)
    expect(new Set(seen).size).toBeGreaterThanOrEqual(3);
    expect(countsOf(last.report as Report)).toEqual(setupCounts);
    // EVT-08: the run id only, once per state write of the run, the finish included
    const writes = Number(psql(`SELECT count(*) FROM public.seen_state WHERE run = '${id}'`));
    await until('1 EVT-08 per state write', () => frames(stream.text()).filter((f) => f.event === 'import.run.changed').length >= writes, 15_000);
    await sleep(1_000);
    const evt = frames(stream.text()).filter((f) => f.event === 'import.run.changed');
    stream.close();
    expect(writes).toBeGreaterThanOrEqual(5);
    expect(evt.length).toBe(writes);
    for (const f of evt) expect(f.data).toEqual({ ids: { runId: id } });
    const peak = run('docker', ['exec', containerOf('worker'), 'cat', '/sys/fs/cgroup/memory.peak']).trim();
    // The measure behind the worker's cap (infra/compose.yaml): its cgroup's peak since start, over 1 export and 1 run.
    // The script prints it after the suite (vitest keeps a passing test's output).
    writeFileSync(path.join(tmp!, 'worker-peak'), `${(Number(peak) / 1048576).toFixed(0)} MiB`);
    // F-532 (b): what the worker holds after an import has settled (memory.current), the number infra/tests/compose.test.ts counts the idle
    // worker at while setup runs (it counts its old 128 cap until this is read on the hosted server).
    const idle = run('docker', ['exec', containerOf('worker'), 'cat', '/sys/fs/cgroup/memory.current']).trim();
    // memory.current counts page cache, which the kernel reclaims at the cap; anon plus shmem is what cannot be reclaimed (no swap on the plan).
    const stat = run('docker', ['exec', containerOf('worker'), 'cat', '/sys/fs/cgroup/memory.stat']);
    const anon = stat.split('\n').filter((l) => /^(anon|shmem) /.test(l)).reduce((n, l) => n + Number(l.split(' ')[1]), 0);
    writeFileSync(path.join(tmp!, 'worker-after-run'), `${(Number(idle) / 1048576).toFixed(0)} MiB memory.current, ${(anon / 1048576).toFixed(0)} MiB anon+shmem`);
  });

  // why: FR-IMP-10 (F-533) the export check the deploy runs on the hosted server runs here too: in the running worker container, as
  // server-deploy.sh runs it (docker compose exec -T worker node apps/worker/src/import/check.ts), it finds the generator's inputs
  // and its export matches the manifest
  it('the import source check finds its inputs and its export matches the manifest, from its own worker container', () => {
    const out = compose('run', '--rm', '--no-deps', '-T', 'worker', 'node', 'apps/worker/src/import/check.ts');
    expect(out).toMatch(/"status":"import source ok"/);
  });

  // why: FR-IMP-1, FR-IMP-10
  it('a worker killed mid-run leaves the row running; the restarted worker executes it again to 1 done record, and a new request is accepted', async () => {
    // F-533: "1 done record" is counted as the office runs this request started (rows keyed by id are always 1), not by the run's own id.
    const officeRuns = () => Number(psql(`SELECT count(*) FROM world.import_run WHERE NOT by_setup AND kind = 'dry_run'`));
    const before = officeRuns();
    const id = await requestDryRun();
    await until('the run to be working', () => { const r = row(id); return r.report?.attempts === 1 && r.percent > 0; });
    killWorker();
    await sleep(2_000);
    expect(row(id).status).toBe('running');
    await startWorker();
    await finished(id);
    expect(row(id).status).toBe('done');
    expect(officeRuns() - before, 'the request made 1 office run and the restart made no second').toBe(1);
    expect(Number(psql(`SELECT count(*) FROM world.import_run WHERE NOT by_setup AND kind = 'dry_run' AND status = 'done' AND id = '${id}'`))).toBe(1);
    const r = await api('GET', `/import/runs/${id}`);
    expect(countsOf((r.data as { report: Parameters<typeof countsOf>[0] }).report)).toEqual(setupCounts);
    const next = await requestDryRun();
    await finished(next);
    expect(row(next).status).toBe('done');
  });

  // why: FR-IMP-1, FR-IMP-10
  it('a run whose worker is killed at each of its 3 attempts ends failed with a message, with no 4th attempt, and a new request is accepted', async () => {
    const id = await requestDryRun();
    for (let a = 1; a <= 3; a++) {
      await until(`attempt ${a} to be working`, () => { const r = row(id); return r.report?.attempts === a && r.percent > 0; });
      killWorker();
      await sleep(1_000);
      expect(row(id)).toMatchObject({ status: 'running', report: { attempts: a } });
      await startWorker();
    }
    await finished(id);
    expect(row(id)).toMatchObject({ status: 'failed', report: { error: 'attempts_exhausted', attempts: 3 } });
    expect((await api('GET', `/import/runs/${id}`)).data).toMatchObject({ status: 'failed', report: null });
    expect(workerLog()).toMatch(/"status":"import run failed","errorCode":"attempts_exhausted"/);
    const next = await requestDryRun();
    await finished(next);
    expect(row(next).status).toBe('done');
  });

  // why: FR-IMP-10
  it('with a planted changed byte in the generator inputs the run ends failed with generator_manifest, never left running', async () => {
    // 1 letter of 1 named person changed: the generated customers.csv then differs from packages/generator/MANIFEST.json.
    const named = JSON.parse(readFileSync(path.join(root, 'packages/generator/named-people.json'), 'utf8')) as { people: { name: string }[] };
    const first = named.people[0]!;
    first.name = first.name.slice(0, -1) + (first.name.endsWith('x') ? 'y' : 'x');
    // The files go under the repo (.build/ci, git-ignored), not the system temp dir: in the wave run the Compose engine is a separate
    // container that shares only the /work volume with this one, so a bind mount of a /tmp file fails there (runc "error mounting").
    const plantDir = path.join(root, '.build', 'ci', 'import-stack-plant');
    mkdirSync(plantDir, { recursive: true });
    const planted = path.join(plantDir, 'named-people.json');
    writeFileSync(planted, JSON.stringify(named, null, 2));
    const override = path.join(plantDir, 'planted.yaml');
    writeFileSync(override, `services:\n  worker:\n    volumes:\n      - ${planted}:/app/packages/generator/named-people.json:ro\n`);
    const recreate = async (extra: string[]) => {
      const t = psql('SELECT now()');
      compose(...extra, 'up', '-d', '--no-deps', '--no-build', '--force-recreate', 'worker');
      await until('the recreated worker heartbeat', () => psql(`SELECT count(*) FROM system.worker_heartbeat WHERE beat_real > '${t}'`) === '1', 60_000);
    };
    await recreate(['-f', override]);
    try {
      const id = await requestDryRun();
      await finished(id);
      expect(row(id)).toMatchObject({ status: 'failed', report: { error: 'generator_manifest', attempts: 1 } });
      expect(workerLog()).toMatch(/"status":"import run failed","errorCode":"generator_manifest"/);
    } finally {
      await recreate([]);
      rmSync(plantDir, { recursive: true, force: true });
    }
    const next = await requestDryRun();
    await finished(next);
    expect(row(next).status).toBe('done');
  });
});
