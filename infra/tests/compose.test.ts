// SPDX-License-Identifier: AGPL-3.0-or-later
// Static checks of infra/compose.yaml and the demo profile against SPECIFICATIONS SD-3 and 11.1.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '../..');
type Service = { image?: string; profiles?: string[]; command?: string[]; mem_limit?: string; environment?: Record<string, string>; healthcheck?: { test?: string[]; start_period?: string } };
const compose = parse(readFileSync(path.join(root, 'infra/compose.yaml'), 'utf8'), { merge: true }) as {
  name: string;
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
};
const svc = compose.services;

function envFile(rel: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path.join(root, rel), 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

// A service's cap in MiB on a copy whose Compose settings are `env` (its .env): a `${NAME:-<n>m}` cap takes the copy's value, else
// its default (only routing's cap is a setting: BUILD_PLAN D-21).
function capMib(service: string, env: Record<string, string> = {}): number {
  const raw = svc[service]!.mem_limit!;
  const v = /^\$\{([A-Z_]+):-([0-9]+m)\}$/.exec(raw);
  const value = v ? (env[v[1]!] ?? v[2]!) : raw;
  expect(value, `${service} cap`).toMatch(/^[0-9]+m$/);
  return Number(value.replace(/m$/, ''));
}

// The routing record's instrument file (docs/build/spikes/P6-ROUTING-MEMORY.md): the hosted figures a test counts come from it only.
type MacCloseMode = { tag: string; passes: boolean; perRun: { burst: { legs: number; routed: number; legsSha256: string | null; ms: { p95: number | null } } }[]; setting: string };
// F-1852: docs/build/ and docs/SPECIFICATIONS.md are private paths (scripts/private-paths.txt), so in a public copy the tests that
// read them skip with a note naming the path; the private checkout has both and they run.
const absent = (rel: string): string => (existsSync(path.join(root, rel)) ? '' : `${rel} is not in this copy (a private path the public export leaves out)`);
const noRoutingSummary = absent('docs/build/spikes/P6-ROUTING-MEMORY.summary.json');
const noSpec = absent('docs/SPECIFICATIONS.md');
const routingSummary = (noRoutingSummary ? {} : JSON.parse(readFileSync(path.join(root, 'docs/build/spikes/P6-ROUTING-MEMORY.summary.json'), 'utf8'))) as {
  serverCap: { instancePlan: string; routingCap: number; routingAnonMaxMiB: { max: number }; hostUsedPercentOfPlan: number; burstRouted: string[]; burstP95Ms: { max: number }; sd49LimitMs: number };
  macClose: { passLine: string; localCap: { uncappedPeakMiB: number; capMiB: number; marginMiB: number }; modes: MacCloseMode[] };
};

// Whether a process named in a "Read by" cell loads @bw/config: a Compose service whose entry point (its `command`) does
// not mention @bw/config does not (migrate, setup); anything else (web, worker, pbs, nginx, "every process") is read as one that does.
function loadsConfig(reader: string): boolean {
  const entry = svc[reader]?.command?.[1];
  return !entry || readFileSync(path.join(root, entry), 'utf8').includes('@bw/config');
}

// The rows of SPECIFICATIONS 11.1 whose own-copy cell is 1 literal value, backticked or quoted ("same" repeats it in the hosted
// cell). A name cell may list several names (F-1696: the 4 DATA_LOCATION_* settings share 1 row); a hosted cell then either
// gives 1 literal for all of them or quoted values each "for" the names it lists by their last word ("for the app, texts and
// maps" is DATA_LOCATION_APP, _TEXTS and _MAPS). `demo` is the hosted value when that cell gives one; `hostedServer` marks a
// hosted cell that says the value is a setting of the hosted server itself (hosted.env), not of the demo profile. `config` is
// false for a row read only by processes that never load @bw/config (section 11.1's rule: read at start-up by @bw/config),
// which Compose sets on that process alone.
type Row = { own: string; demo: string | undefined; hostedServer: boolean; readers: string[]; config: boolean };
const LITERAL = /^(?:`([^`]+)`|"([^"]+)")(?: \([^)]*\))?$/;
function literal(cell: string | undefined): string | undefined {
  const m = LITERAL.exec(cell ?? '');
  return m ? (m[1] ?? m[2]) : undefined;
}
// The hosted value of `name` from a cell of quoted values each followed by "for <names>", or undefined.
function hostedFor(cell: string, name: string): string | undefined {
  for (const m of cell.matchAll(/"([^"]+)" for (?:the )?([a-z]+(?:(?:, | and )[a-z]+)*)/g)) {
    if (m[2]!.split(/, | and /).some((w) => name.endsWith(`_${w.toUpperCase()}`))) return m[1];
  }
  return undefined;
}
function specSettings(): Map<string, Row> {
  const lines = readFileSync(path.join(root, 'docs/SPECIFICATIONS.md'), 'utf8').split('\n');
  const start = lines.indexOf('### 11.1 Settings');
  const out = new Map<string, Row>();
  for (const line of lines.slice(start, start + 60)) {
    if (line.startsWith('### 11.2')) break;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const names = /^`[A-Z_]+`(?:, `[A-Z_]+`)*$/.test(cells[0] ?? '') ? [...cells[0]!.matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]!) : [];
    const own = literal(cells[1]);
    const hostedServer = /\bhosted server\b/.test(cells[2] ?? '');
    const readers = (cells[3] ?? '').replace(/\([^)]*\)/g, '').split(',').map((r) => r.trim()).filter(Boolean);
    for (const name of names) {
      const demo = cells[2] === 'same' ? own : (literal(cells[2]) ?? hostedFor(cells[2] ?? '', name));
      if (own !== undefined && (demo !== undefined || hostedServer)) out.set(name, { own, demo, hostedServer, readers, config: readers.some(loadsConfig) });
    }
  }
  return out;
}

describe('infra/compose.yaml', () => {
  // why: SD-3
  it('has exactly the SD-3 services and the F-150 migrate step, with certbot and setup one-shot in their own profiles', () => {
    expect(compose.name).toBe('brightwater');
    expect(Object.keys(svc).sort()).toEqual(['certbot', 'db', 'migrate', 'pbs', 'proxy', 'routing', 'setup', 'web', 'worker']);
    expect(svc.certbot!.profiles).toEqual(['certbot']);
    expect(svc.setup!.profiles).toEqual(['setup']);
    for (const s of ['proxy', 'web', 'worker', 'pbs', 'db', 'migrate', 'routing']) expect(svc[s]!.profiles, s).toBeUndefined();
    expect(svc.proxy!.image).toMatch(/^nginx:1\.30\.6@sha256:[0-9a-f]{64}$/);
    expect(svc.db!.image).toMatch(/^postgres:18\.[0-9]+-bookworm@sha256:[0-9a-f]{64}$/);
    expect(svc.certbot!.image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  // why: SD-3
  it('runs web, worker and pbs from 1 image with 3 entry points, each memory-capped', () => {
    const images = new Set(['web', 'worker', 'pbs'].map((s) => svc[s]!.image));
    expect([...images]).toEqual(['${BW_IMAGE:-bw-app:local}']);
    expect(svc.web!.command).toEqual(['node', 'apps/web/src/server.ts']);
    expect(svc.worker!.command).toEqual(['node', 'apps/worker/src/main.ts']);
    expect(svc.pbs!.command).toEqual(['node', 'apps/pbs/src/main.ts']);
    // routing's cap is the 1 that a copy sets (ROUTING_MEM_LIMIT, BUILD_PLAN D-21), with a fixed local default; every other is fixed
    for (const [name, s] of Object.entries(svc)) expect(s.mem_limit, name).toMatch(name === 'routing' ? /^\$\{ROUTING_MEM_LIMIT:-[0-9]+m\}$/ : /^[0-9]+m$/);
  });

  // why: F-295 setup's cap is measured, and the caps of what runs beside setup fit the hosted plan; F-1291 routing counted at its cap
  it("caps setup above its measured peak, and the running stack plus setup inside the hosted plan's memory", (ctx) => {
    if (noRoutingSummary) ctx.skip(noRoutingSummary);
    // The hosted server's caps: compose.yaml's, with infra/hosted/hosted.env's routing cap (D-21: 320m on every Lightsail copy).
    const mib = (s: string): number => capMib(s, envFile('infra/hosted/hosted.env'));
    // docs/build/spikes/P2-SETUP.md (F-282): setup's cgroup memory.peak on small_3_0 with the stack up, at most 624 MiB;
    // the plan's total memory as free -m reads it there, 1936 MiB.
    expect(mib('setup')).toBeGreaterThan(624);
    // P3-IMPORT-WORKER: the worker's import job does setup's import work (its cap is setup's), and it executes no run
    // while setup holds its lock (apps/worker/src/import/job.ts), so at most 1 of the 2 imports runs at a time. While
    // setup runs, the worker is idle (WORKER_IDLE_MIB: the cap it ran in before it imported); while the worker imports,
    // setup is not running (a one-shot service).
    const WORKER_IDLE_MIB = 128;
    expect(mib('worker')).toBeGreaterThanOrEqual(mib('setup'));
    const always = ['proxy', 'web', 'pbs', 'db'].reduce((sum, s) => sum + mib(s), 0);
    // F-1291: routing is counted at its cap, and with it the caps add up to more than the plan's memory (2048 MiB with the worker
    // importing, 2176 with setup). The excess must fit inside routing's own reclaimable part: with --mmap its memory is the mapped files'
    // page cache, which the kernel takes back under pressure. Its anon memory (what cannot be taken back) is read from the small_3_0
    // run at this cap, never a figure from another machine.
    const hosted = routingSummary.serverCap;
    expect(hosted.instancePlan).toBe('small_3_0');
    expect(hosted.routingCap, 'the summary measured routing at the cap the hosted server sets').toBe(mib('routing'));
    const reclaimable = mib('routing') - hosted.routingAnonMaxMiB.max;
    for (const beside of [mib('worker'), mib('setup') + WORKER_IDLE_MIB]) {
      expect(always + mib('routing') + beside - 1936, 'the caps over the plan fit in routing page cache').toBeLessThanOrEqual(reclaimable);
    }
  });

  // why: F-1322 routing's cap is the one measured for each kind of copy: 320m on every Lightsail copy, the Mac rig's measured cap locally
  it('caps routing at 320m on every Lightsail copy and at the measured local cap elsewhere', (ctx) => {
    if (noRoutingSummary) ctx.skip(noRoutingSummary);
    const c = routingSummary.serverCap;
    // the Lightsail cap: measured on small_3_0, every leg routed within SD-49, and NFR-13 within 60% by host used memory (D-21)
    expect(c.instancePlan).toBe('small_3_0');
    expect(c.routingCap).toBe(320);
    expect(c.burstRouted.every((r) => r === '515/515')).toBe(true);
    expect(c.burstP95Ms.max).toBeLessThanOrEqual(c.sd49LimitMs);
    expect(c.hostUsedPercentOfPlan).toBeLessThanOrEqual(60);
    // every Lightsail copy sets it: the hosted server's .env source, the staging copy's .env (staging.test.ts runs write_env), and the
    // load-day copy's .env
    expect(capMib('routing', envFile('infra/hosted/hosted.env'))).toBe(320);
    for (const rel of ['infra/deploy/staging.sh', 'infra/load/temp-server.sh']) expect(readFileSync(path.join(root, rel), 'utf8'), rel).toMatch(/echo ["']ROUTING_MEM_LIMIT=320m["']/);
    // local copies: 320m failed the Mac rig's pass line on run 1, so the default is the local cap measured there (uncapped peak plus margin)
    const mac = routingSummary.macClose;
    const at = (cap: number): MacCloseMode => mac.modes.find((m) => new RegExp(` cap=${cap}m `).test(m.setting))!;
    const local = capMib('routing');
    expect(at(320).passes).toBe(false);
    expect(local).toBe(mac.localCap.capMiB);
    expect(mac.localCap.capMiB).toBeCloseTo(mac.localCap.uncappedPeakMiB + mac.localCap.marginMiB, 1);
    expect(at(local).passes, `the local cap ${local}m passes the pass line`).toBe(true);
    for (const r of at(local).perRun) {
      expect(r.burst.routed).toBe(r.burst.legs);
      expect(r.burst.ms.p95!).toBeLessThanOrEqual(3000);
    }
  });

  // why: F-882 web's Node heap limit sits under its memory cap, so V8 collects before the kernel kills web for out of memory
  it("sets web's Node heap limit under its memory cap, with room for Node's code and buffers", () => {
    const capMib = Number(svc.web!.mem_limit!.replace(/m$/, ''));
    const nodeOptions = svc.web!.environment?.NODE_OPTIONS ?? '';
    // The image's Node, under web's NODE_OPTIONS, says its whole heap limit (old space plus the 3 young-generation
    // semi-spaces): the old space alone is not enough, since the default semi-spaces are 3 x 64 MiB (P4-LOAD.md). The image
    // runs the Node of infra/image/Dockerfile's NODE_IMAGE (F-901). The host's Node answers only when it is the same major;
    // otherwise the pinned image answers, and a host with neither fails the test, it never skips.
    const nodeImage = /^ARG NODE_IMAGE=(node:\S+)/m.exec(readFileSync(path.join(root, 'infra/image/Dockerfile'), 'utf8'))?.[1];
    expect(nodeImage, 'infra/image/Dockerfile has no ARG NODE_IMAGE=node:<version>').toBeDefined();
    const imageMajor = /^node:(\d+)\./.exec(nodeImage!)?.[1];
    const probe = 'Math.round(require("node:v8").getHeapStatistics().heap_size_limit / 1048576)';
    const env = { ...process.env, NODE_OPTIONS: nodeOptions };
    const out = process.versions.node.split('.')[0] === imageMajor
      ? execFileSync(process.execPath, ['-p', probe], { env, encoding: 'utf8' })
      : execFileSync('docker', ['run', '--rm', '-e', `NODE_OPTIONS=${nodeOptions}`, '--entrypoint', 'node', nodeImage!, '-p', probe], { encoding: 'utf8' });
    const limitMib = Number(out.trim());
    // Measured on the load day (docs/build/spikes/P4-LOAD.md): outside its JS heap web's Node holds code, ICU, libuv and
    // buffers, and each health probe (the healthcheck above) is a 2nd Node in the same cgroup, about 19 MiB anon.
    const OUTSIDE_HEAP_MIB = 40;
    const PROBE_MIB = 24;
    expect(limitMib + OUTSIDE_HEAP_MIB + PROBE_MIB, `heap limit ${limitMib} MiB under a ${capMib}m cap`).toBeLessThanOrEqual(capMib);
    expect(svc.web!.healthcheck!.test!.join(' ')).toContain('node');
  });

  // why: SD-3, NFR-12, FR-MAP-3
  it("runs the routing service from the bake's pinned OSRM image over the map volume read-only, on the Compose network only, needed by nothing", () => {
    type Full = Service & { volumes?: string[]; ports?: unknown; expose?: string[]; read_only?: boolean; restart?: string; depends_on?: unknown };
    const r = svc.routing as Full;
    const bakePin = /^OSRM=(\S+)/m.exec(readFileSync(path.join(root, 'infra/data/maps/run.sh'), 'utf8'))?.[1];
    expect(bakePin).toMatch(/^ghcr\.io\/project-osrm\/osrm-backend@sha256:[0-9a-f]{64}$/);
    expect(r.image).toBe(bakePin);
    expect(r.command!.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    const sh = r.command![2]!;
    expect(sh).toContain('exec osrm-routed --algorithm mld --mmap --ip 0.0.0.0 --port 5000 /data/maps/ohio.osrm');
    // it waits for its files rather than exiting (an exit under restart: unless-stopped would loop), on a file the manifest names
    expect(sh).toMatch(/until \[ -e \/data\/maps\/(ohio\.osrm\.[a-z_]+) \]; do .*sleep 30; done;/);
    const waited = /\/data\/maps\/(ohio\.osrm\.[a-z_]+)/.exec(sh)![1];
    const manifest = JSON.parse(readFileSync(path.join(root, 'packages/maps/MANIFEST.json'), 'utf8')) as { assets: { id: string; kind: string }[] };
    expect(manifest.assets.filter((a) => a.kind === 'routing').map((a) => a.id)).toContain(waited);
    expect(r.volumes).toEqual(['${BW_MAPS_DIR:-../.build/data/maps}:/data/maps:ro']);
    expect(r.ports).toBeUndefined();
    expect(r.expose).toEqual(['5000']);
    expect(r.read_only).toBe(true);
    expect(r.restart).toBe('unless-stopped');
    expect(r.depends_on).toBeUndefined();
    for (const [name, s] of Object.entries(svc)) expect(JSON.stringify((s as Full).depends_on ?? {}), name).not.toContain('routing');
  });

  // why: F-258 the worker's import job reads the street list setup reads, from the same mount
  it('mounts into the worker the data folder setup reads, read-only, at the same path', () => {
    type WithVolumes = Service & { volumes?: string[] };
    const data = (s: string) => ((svc[s] as WithVolumes).volumes ?? []).filter((v) => v.endsWith(':/app/.build/data:ro'));
    expect(data('worker')).toEqual(['${BW_DATA_DIR:-../.build/data}:/app/.build/data:ro']);
    expect(data('worker')).toEqual(data('setup'));
  });

  // why: F-221 "up --wait" must not report a crash-looping web process as up
  it('gives web a healthcheck that probes its own /healthz and needs a 200', () => {
    const t = svc.web!.healthcheck?.test ?? [];
    expect(t.slice(0, 3)).toEqual(['CMD', 'node', '-e']);
    expect(t[3]).toContain("fetch('http://127.0.0.1:3000/healthz')");
    expect(t[3]).toContain('r.status === 200 ? 0 : 1');
    expect(svc.web!.healthcheck?.start_period).toMatch(/^\d+s$/);
  });

  // why: SD-3
  it('keeps the volume names the live server holds (the certificate and the database), plus 1 login volume per process', () => {
    // P3-ITEMS adds the photo volume (SPECIFICATIONS section 2 volumes; SD-32): photo and signature files, written once by web.
    expect(Object.keys(compose.volumes).sort()).toEqual(['acme', 'dblogin-pbs', 'dblogin-web', 'dblogin-worker', 'letsencrypt', 'pgdata', 'photos']);
  });

  // why: F-96
  it("gives an own copy's db, migrate and setup a published default password that the hosted server's file overrides", () => {
    type WithEnvFile = Service & { env_file?: { path: string; required: boolean }[] };
    for (const name of ['db', 'migrate', 'setup']) {
      expect((svc[name] as WithEnvFile).env_file, name).toEqual([
        { path: './own-copy-db.env', required: false },
        { path: '${DB_ENV_FILE:-/etc/brightwater/db.env}', required: false },
      ]);
    }
    expect(Object.keys(envFile('infra/own-copy-db.env'))).toEqual(['POSTGRES_PASSWORD']);
    expect(envFile('infra/own-copy-db.env').POSTGRES_PASSWORD).toMatch(/^own-copy-example-default$/);
    // The database is never published on a host port, so the published default opens nothing outside the machine.
    expect((svc.db as Service & { ports?: unknown }).ports).toBeUndefined();
  });

  // why: SD-24, F-150, F-362
  it('runs setup as a one-shot from the app image, as the schema owner, after migrate, with the street list read-only', () => {
    const s = svc.setup as Service & { restart?: string; volumes?: string[]; depends_on?: Record<string, { condition: string }> };
    expect(s.image).toBe('${BW_IMAGE:-bw-app:local}');
    expect(s.command).toEqual(['node', 'packages/setup/src/cli.ts']);
    expect(s.restart).toBe('no');
    expect(s.environment).toEqual({
      DATABASE_URL: 'postgres://brightwater@db:5432/brightwater', SAMPLE_PASSWORD_SEED: '${SAMPLE_PASSWORD_SEED:-}', REVIEWER_PASSWORD: '${REVIEWER_PASSWORD:-}',
      MAPS_DIR: '/data/maps',
    });
    expect(s.volumes).toEqual(['${BW_DATA_DIR:-../.build/data}:/app/.build/data:ro', '${BW_MAPS_DIR:-../.build/data/maps}:/data/maps:ro']);
    expect(s.depends_on).toEqual({ migrate: { condition: 'service_completed_successfully' } });
  });

  // why: F-150, SD-40
  it('runs the migrate step before web, worker and pbs, and gives each process its own login and only its own password volume', () => {
    const m = svc.migrate as Service & { restart?: string; volumes?: string[]; depends_on?: Record<string, { condition: string }> };
    expect(m.image).toBe('${BW_IMAGE:-bw-app:local}');
    expect(m.command).toEqual(['node', 'packages/db/src/cli/start.ts']);
    expect(m.restart).toBe('no');
    expect(m.environment).toEqual({ DATABASE_URL: 'postgres://brightwater@db:5432/brightwater', BW_DB_LOGINS_DIR: '/var/lib/bw/db-login' });
    expect(m.depends_on).toEqual({ db: { condition: 'service_healthy' } });
    expect(m.volumes!.sort()).toEqual(['dblogin-pbs:/var/lib/bw/db-login/pbs', 'dblogin-web:/var/lib/bw/db-login/web', 'dblogin-worker:/var/lib/bw/db-login/worker']);
    for (const [name, login] of [['web', 'bw_web'], ['worker', 'bw_worker'], ['pbs', 'bw_pbs']] as const) {
      const s = svc[name] as Service & { volumes?: string[]; depends_on?: Record<string, { condition: string }> };
      expect(s.environment!.DATABASE_URL, name).toBe(`postgres://${login}@db:5432/brightwater`);
      expect(s.environment!.DATABASE_PASSWORD_FILE, name).toBe(`/var/lib/bw/db-login/${name}/password`);
      // web and worker also mount the photo volume (PHOTOS_DIR), read-write: API-103 writes it, the worker's Cleanup deletes
      // the files no row references (F-474). pbs never sees it. Only the worker also mounts the street list its import job
      // reads (P3-IMPORT-WORKER), read-only.
      const extra = name === 'web' ? ['photos:/data/photos'] : name === 'worker' ? ['photos:/data/photos', '${BW_DATA_DIR:-../.build/data}:/app/.build/data:ro'] : [];
      expect(s.volumes, name).toEqual([`dblogin-${name}:/var/lib/bw/db-login/${name}:ro`, ...extra]);
      expect(s.depends_on, name).toEqual({ migrate: { condition: 'service_completed_successfully' } });
      expect(JSON.stringify(s.environment), name).not.toMatch(/POSTGRES_PASSWORD|brightwater@/);
    }
  });

  // why: SD-3
  it('defaults every 11.1 setting to the own-copy value, and the demo profile holds the hosted values', (ctx) => {
    if (noSpec) ctx.skip(noSpec);
    const spec = specSettings();
    expect(spec.size).toBeGreaterThanOrEqual(10);
    const demo = envFile('infra/profiles/demo.env');
    // NODE_OPTIONS is Node's own heap setting for web (F-882), not an app setting of 11.1.
    const own = (e: Record<string, string>) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('DATABASE_') && k !== 'NODE_OPTIONS'));
    // F-218: the web process alone also takes its secrets (the access code, the key its cookies are signed with, the sample password seed)
    // and the iPhone install link's settings, each blank or none unless the owner's .env sets it; none is in the hosted profile (NFR-14).
    const WEB_ONLY: Record<string, string> = {
      ACCESS_CODE: '${ACCESS_CODE:-}', ACCESS_COOKIE_KEY: '${ACCESS_COOKIE_KEY:-}', SAMPLE_PASSWORD_SEED: '${SAMPLE_PASSWORD_SEED:-}',
      IOS_INSTALL_KIND: '${IOS_INSTALL_KIND:-none}', IOS_INSTALL_LINK: '${IOS_INSTALL_LINK:-}',
    };
    const webEnv = own(svc.web!.environment!);
    for (const [k, v] of Object.entries(WEB_ONLY)) {
      expect(webEnv[k], k).toBe(v);
      expect(own(svc.worker!.environment!)[k], `worker ${k}`).toBeUndefined();
      expect(own(svc.pbs!.environment!)[k], `pbs ${k}`).toBeUndefined();
      expect(demo[k], `profile ${k}`).toBeUndefined();
    }
    const env = Object.fromEntries(Object.entries(webEnv).filter(([k]) => !(k in WEB_ONLY)));
    const rows = [...spec].filter(([, r]) => r.config);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    // The settings the config-loading processes read: Compose defaults each to the own-copy value.
    expect(Object.keys(env).sort()).toEqual(rows.map(([k]) => k).sort());
    // The demo profile holds the hosted value of each row whose hosted cell is a literal, and no other.
    const hostedEnv = envFile('infra/hosted/hosted.env');
    expect(Object.keys(demo).sort()).toEqual(rows.filter(([, r]) => !r.hostedServer).map(([k]) => k).sort());
    for (const [name, r] of rows) {
      expect(env[name], name).toBe(`\${${name}:-${r.own}}`);
      if (r.hostedServer) {
        // A hosted-server setting lives in hosted.env, not the demo profile (F-395).
        expect(demo[name], `profile ${name}`).toBeUndefined();
        expect(hostedEnv[name], `hosted.env ${name}`).toBeDefined();
      } else {
        expect(demo[name], name).toBe(r.demo);
      }
    }
    // A row read only by a process that never loads @bw/config is set on that process alone, at its own-copy value.
    for (const [name, r] of spec) {
      if (r.config) continue;
      const procs = r.readers.filter((p) => svc[p]);
      expect(procs.length, name).toBeGreaterThan(0);
      for (const p of procs) expect(svc[p]!.environment?.[name], `${p} ${name}`).toBe(r.own);
      for (const p of ['web', 'worker', 'pbs']) expect(own(svc[p]!.environment!)[name], `${p} ${name}`).toBeUndefined();
    }
    expect(own(svc.worker!.environment!)).toEqual(env);
    expect(own(svc.pbs!.environment!)).toEqual(env);
  });

  // why: SD-3
  it('hosted.env picks the TLS site and leaves ROUTES to the deploy mode (F-1645: deploy-stage.test.ts checks the lock)', () => {
    const hosted = envFile('infra/hosted/hosted.env');
    // P3-BACKUP added the backup settings (infra/tests/backup.test.ts checks them); P6-ROUTING-MEMORY the routing cap (D-21).
    expect(hosted).toEqual({ PROXY_CONF: 'hosted.conf', HTTP_BIND: '80', HTTPS_BIND: '443',
      BACKUP_TARGET: 'lightsail', BACKUP_BUCKET: 'brightwater-backup-use1', BACKUP_REGION: 'us-east-1', ROUTING_MEM_LIMIT: '320m' });
    expect(svc.proxy!.environment).toEqual({ PROXY_CONF: '${PROXY_CONF:-local.conf}', ROUTES: '${ROUTES:-open}' });
  });
});
