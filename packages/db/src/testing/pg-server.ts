// SPDX-License-Identifier: AGPL-3.0-or-later
// A real PostgreSQL 18 server for @bw/db's tests and the schema gates, wherever they run: this Mac, the push CI
// container and the wave container on Spectre (ci/wave-run.sh), with no Docker container of its own. (Since F-536 both
// CI containers reach an engine, kept by plan; the push run starts no stack today, and a database test needs none.)
//
//   BW_TEST_PG_URL set   use that server (an admin URL, for example a postgres:18.4 container on 127.0.0.1:55432)
//   otherwise            start PostgreSQL 18.4 from the dev-only embedded-postgres binaries (the same 18.4 release
//                        the Compose file pins), on a free 127.0.0.1 port, in a temp data directory, TCP only
//
// Running as root (the CI containers), initdb and postgres refuse to start, so both run as `nobody` with the data
// directory owned by it.
//
// autovacuum is off on the embedded server (F-314). A test database is filled, emptied and refilled in seconds (the
// import's dry run rolls back 114,000 rows, then the real run inserts them again in 1 transaction), and the
// autovacuum worker visits each database at a moment no test controls. When it vacuums a table while that insert is
// still open it counts none of the rows live (PostgreSQL skips in-progress inserts) and stores reltuples 0 with
// relpages > 0; after the commit the planner reads a density of 0, plans 18,400 customers and 95,870 visits as 1 row
// each, and a 2-table join becomes a 1.76-billion-row nested loop (runner.db.test.ts's join of the 2 ran for over 6
// minutes on Spectre). With autovacuum off, statistics change only when a test or the code under test runs VACUUM or
// ANALYZE itself, so every run plans the same way. Each file's database is dropped at its end, so dead rows never pile
// up. A server named by BW_TEST_PG_URL keeps its own setting. The package's postinstall is denied in pnpm-workspace.yaml (no third-party install script
// runs); its only job, re-creating the library symlinks listed in native/pg-symlinks.json, is done here instead.
import { spawn } from 'node:child_process';
import { chownSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '../client.ts';

export interface PgServer {
  /** Superuser URL of the `postgres` database. */
  adminUrl: string;
  /** server_version, for example "18.4". */
  version: string;
  embedded: boolean;
  stop(): Promise<void>;
}

const PLATFORM_PACKAGE: Record<string, string> = {
  'darwin-arm64': '@embedded-postgres/darwin-arm64',
  'darwin-x64': '@embedded-postgres/darwin-x64',
  'linux-x64': '@embedded-postgres/linux-x64',
  'linux-arm64': '@embedded-postgres/linux-arm64',
};

function nativeDir(): string {
  const key = `${os.platform()}-${os.arch()}`;
  const pkg = PLATFORM_PACKAGE[key];
  if (!pkg) throw new Error(`no embedded PostgreSQL build for ${key}; set BW_TEST_PG_URL to a PostgreSQL 18 server`);
  // The platform package is embedded-postgres's dependency, so resolve it from there (pnpm keeps them apart).
  const wrapper = createRequire(import.meta.url).resolve('embedded-postgres');
  const entry = createRequire(wrapper).resolve(pkg);
  return path.resolve(path.dirname(entry), '..', 'native');
}

/** The package's postinstall, done here: create each listed symlink that is missing. Idempotent. */
function hydrateSymlinks(native: string): void {
  const list = path.join(native, 'pg-symlinks.json');
  if (!existsSync(list)) return;
  const links = JSON.parse(readFileSync(list, 'utf8')) as { source: string; target: string }[];
  const pkgRoot = path.dirname(native);
  for (const { source, target } of links) {
    const abs = path.join(pkgRoot, target);
    if (existsSync(abs)) continue;
    try {
      symlinkSync(path.relative(path.dirname(abs), path.join(pkgRoot, source)), abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

function nobody(): { uid: number; gid: number } {
  const line = readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith('nobody:'));
  const [, , uid, gid] = line?.split(':') ?? [];
  if (!uid || !gid) throw new Error('running as root, but /etc/passwd has no nobody user to run PostgreSQL as');
  return { uid: Number(uid), gid: Number(gid) };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function run(cmd: string, args: string[], as: { uid: number; gid: number } | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(as ?? {}), env: { ...process.env, LC_ALL: 'C' } });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (out += d.toString()));
    p.once('error', reject);
    p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited ${code}:\n${out}`))));
  });
}

async function serverVersion(url: string): Promise<string> {
  const c = createClient({ connectionString: url });
  await c.connect();
  try {
    const { rows } = await c.query<{ server_version: string }>('SHOW server_version');
    return rows[0]?.server_version ?? '';
  } finally {
    await c.end();
  }
}

export async function startPgServer(opts: { startTimeoutMs?: number } = {}): Promise<PgServer> {
  const external = process.env.BW_TEST_PG_URL;
  if (external) {
    const version = await serverVersion(external);
    if (!version.startsWith('18.')) throw new Error(`BW_TEST_PG_URL is PostgreSQL ${version}; PostgreSQL 18 is required`);
    return { adminUrl: external, version, embedded: false, stop: async () => undefined };
  }

  const native = nativeDir();
  hydrateSymlinks(native);
  const as = process.getuid?.() === 0 ? nobody() : undefined;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'bw-pg-'));
  if (as) chownSync(dataDir, as.uid, as.gid);
  const port = await freePort();
  await run(path.join(native, 'bin', 'initdb'), ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C', '--no-sync'], as);

  const child = spawn(
    path.join(native, 'bin', 'postgres'),
    ['-D', dataDir, '-p', String(port), '-h', '127.0.0.1', '-c', 'unix_socket_directories=', '-c', 'fsync=off',
      '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=200', '-c', 'autovacuum=off'],
    { stdio: ['ignore', 'pipe', 'pipe'], ...(as ?? {}), env: { ...process.env, LC_ALL: 'C' } },
  );
  const killOnExit = () => child.kill('SIGKILL');
  process.once('exit', killOnExit);
  let log = '';
  // Ready when the server says so on its log, never after a fixed wait; the timer only bounds a server that never is.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`PostgreSQL did not start within ${opts.startTimeoutMs ?? 30000} ms:\n${log}`)), opts.startTimeoutMs ?? 30000);
    const onData = (d: Buffer) => {
      log += d.toString();
      if (log.includes('database system is ready to accept connections')) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`PostgreSQL exited ${code} while starting:\n${log}`)); });
  });
  const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
  const version = await serverVersion(adminUrl);
  let stopped: Promise<void> | undefined;
  return {
    adminUrl,
    version,
    embedded: true,
    stop() {
      stopped ??= new Promise<void>((resolve) => {
        process.removeListener('exit', killOnExit);
        if (child.exitCode !== null) { resolve(); return; }
        child.once('exit', () => resolve());
        child.kill('SIGINT'); // fast shutdown
      }).then(() => rmSync(dataDir, { recursive: true, force: true }));
      return stopped;
    },
  };
}
