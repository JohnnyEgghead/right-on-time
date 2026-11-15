// SPDX-License-Identifier: AGPL-3.0-or-later
// The web app for the browser gates (P2-SHELL): the look comparator (ci/look-values/shell.pw.test.ts) and the page
// walkers (ci/page-walkers/app.pw.test.ts) read the real Next.js app through the real web process (apps/web/src/server.ts:
// the kernel, the page gate, the 11.5 headers), on loopback. Its database is a closed port: these gates need no data,
// and a read that reaches the database answers server_error, which each component shows as its failure state.
// They use the harness build (BW_WEB_PREVIEW=1, apps/web/.next-preview): the release routes plus the shell preview
// routes (apps/web/next.config.ts). A build is reused only while its source hash matches the tree: the hash covers
// every tracked or new file under apps/web and the workspace packages it imports, and the lockfile, so a stale
// build is never tested.
//   node ci/web-app.ts build    build the harness app if its source hash changed (prints built / reused)
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const WEB_DIR = path.join(ROOT, 'apps/web');
export const PREVIEW_DIST = path.join(WEB_DIR, '.next-preview');
const HASH_FILE = path.join(PREVIEW_DIST, 'bw-source-hash');
const SERVER = path.join(WEB_DIR, 'src/server.ts');
export const SOURCE_PATHS = ['apps/web', 'packages/i18n', 'packages/api', 'packages/outbox', 'packages/time', 'pnpm-lock.yaml'];

const previewEnv = () => ({ ...process.env, BW_WEB_PREVIEW: '1', NEXT_TELEMETRY_DISABLED: '1' });
// Next's own bin, run by this node: a stop signal reaches the server itself, never a wrapper that leaves it running.
const NEXT_BIN = path.join(WEB_DIR, 'node_modules/next/dist/bin/next');

/** sha256 over the path and bytes of every tracked or untracked (not ignored) file of SOURCE_PATHS. */
export function sourceHash(): string {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '--', ...SOURCE_PATHS], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`web-app: git ls-files failed: ${r.stderr}`);
  const h = createHash('sha256');
  for (const f of r.stdout.split('\n').filter(Boolean).sort()) {
    const abs = path.join(ROOT, f);
    if (!existsSync(abs)) continue; // deleted in the work tree
    h.update(f).update('\0').update(readFileSync(abs)).update('\0');
  }
  return h.digest('hex');
}

const LOCK_DIR = path.join(WEB_DIR, '.next-preview.lock');
const LOCK_WAIT_MS = 300_000;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Builds under a lock (mkdir is atomic): vitest runs the 2 browser gates' files in parallel processes. */
export function ensureBuild(log: (s: string) => void = (s) => process.stdout.write(`${s}\n`)): 'built' | 'reused' {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`web-app: ${LOCK_DIR} held for over ${LOCK_WAIT_MS / 1000} s (a stale lock: remove it)`);
      sleep(500);
    }
  }
  try {
    return buildLocked(log);
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

function buildLocked(log: (s: string) => void): 'built' | 'reused' {
  const want = sourceHash();
  if (existsSync(HASH_FILE) && readFileSync(HASH_FILE, 'utf8').trim() === want) {
    log(`web-app: harness build reused (${want.slice(0, 12)})`);
    return 'reused';
  }
  const started = Date.now();
  const r = spawnSync(process.execPath, [NEXT_BIN, 'build'], { cwd: WEB_DIR, env: previewEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`web-app: next build failed (exit ${r.status}):\n${(r.stdout + r.stderr).slice(-4000)}`);
  writeFileSync(HASH_FILE, `${want}\n`);
  log(`web-app: harness build done in ${((Date.now() - started) / 1000).toFixed(1)} s (${want.slice(0, 12)})`);
  return 'built';
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export interface WebApp {
  origin: string;
  stop(): Promise<void>;
}

/** Builds if needed, starts the web process on a free loopback port, waits for its first page answer (30 s). */
export async function startWebApp(): Promise<WebApp> {
  ensureBuild();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  // The same entry the image runs, on loopback only.
  const child: ChildProcess = spawn(process.execPath, [SERVER], {
    cwd: WEB_DIR,
    env: {
      PATH: process.env.PATH ?? '', ...previewEnv(), NODE_ENV: 'production', PORT: String(port), BW_WEB_LISTEN_HOST: '127.0.0.1',
      DATABASE_URL: 'postgres://bw_web@127.0.0.1:9/brightwater',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (d) => (out += String(d)));
  child.stderr?.on('data', (d) => (out += String(d)));
  const stop = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`web-app: the web process exited (${child.exitCode}):\n${out.slice(-2000)}`);
    try {
      if ((await fetch(`${origin}/no-such-page`)).status === 404) return { origin, stop };
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  await stop();
  throw new Error(`web-app: ${origin} did not answer a page within 30 s:\n${out.slice(-2000)}`);
}

if (import.meta.main) {
  if (process.argv[2] !== 'build') {
    console.error('usage: node ci/web-app.ts build');
    process.exit(2);
  }
  ensureBuild();
}
