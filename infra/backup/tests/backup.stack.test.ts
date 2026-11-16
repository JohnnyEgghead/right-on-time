// SPDX-License-Identifier: AGPL-3.0-or-later
// P3-BACKUP local proofs (BUILD_PLAN P3-BACKUP Acceptance, the local half; SPECIFICATIONS sections 4.8 and 11.7):
// backup.sh, restore-test.sh, retention.sh and hosted-check-server.sh run as on the hosted server, in the Debian 13
// runner container (infra/backup/tests/runner.Dockerfile) with this Mac's Docker socket, against the Compose stack of
// infra/backup/tests/stack.sh: real PostgreSQL 18 with the seeded world, and an S3-compatible server for the lightsail
// target. Each arm's raw output is kept in .build/ci/restore-test/arms/arm-<name>.log (F-397; BW_PROOF_EVIDENCE names another folder). Needs the stack: without it
// every test fails (a red, never a skip). Run: see vitest.stack.config.ts.
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..', '..', '..');
// F-397: the arm logs go to a git-ignored run folder, so a gate run on a working tree never overwrites the committed lane record.
const evidence = process.env.BW_PROOF_EVIDENCE ?? path.join(root, '.build/ci/restore-test/arms');
const state = process.env.BW_PROOF_STATE ?? path.join(tmpdir(), process.env.BW_BACKUP_PROJECT ?? 'bw-w16-backup');
const kv = (file: string) =>
  Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const stack = existsSync(path.join(state, 'stack.env')) ? kv(path.join(state, 'stack.env')) : {};
const bucketDir = stack.BUCKET_DIR ?? path.join(state, 'bucket');
// The engine's socket as the engine sees it, mounted at the default path the scripts use: DOCKER_HOST's path when it names
// a unix socket (the wave run's own engine, unix:///var/run/dind/docker.sock, F-126), else /var/run/docker.sock (Docker
// Desktop's VM, a Linux host). A fixed /var/run/docker.sock on the wave engine mounts an empty folder (F-387).
const engineSock = /^unix:\/\/(\/.+)$/.exec(process.env.DOCKER_HOST ?? '')?.[1] ?? '/var/run/docker.sock';
let dbId = '';

interface Result { code: number; out: string }
interface RunOpts { env?: Record<string, string>; s3?: boolean; mounts?: string[]; path?: string }

/** Runs a script of infra/backup in the runner container, as root, with the stack's db and the target. */
async function runner(script: string, arm: string, opts: RunOpts = {}): Promise<Result> {
  const env = { BW_PROJECT: stack.PROJECT as string, BACKUP_TARGET: 'local', BACKUP_LOCAL_DIR: '/bucket', ...opts.env };
  const args = ['run', '--rm', '--network', stack.NETWORK as string,
    '-v', `${engineSock}:/var/run/docker.sock`,
    '-v', `${path.join(root, 'infra/backup')}:/opt/brightwater/backup:ro`,
    '-v', `${bucketDir}:/bucket`, ...(opts.mounts ?? []).flatMap((m) => ['-v', m]),
    ...(opts.s3 ? ['--env-file', path.join(state, 's3.env')] : []),
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...(opts.path ? ['-e', `PATH=${opts.path}`] : []),
    stack.RUNNER_IMAGE as string, 'bash', script.startsWith('/') ? script : `/opt/brightwater/backup/${script}`];
  let res: Result;
  try {
    const r = await run('docker', args, { maxBuffer: 64 * 1024 * 1024, timeout: 540_000 });
    res = { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    res = { code: typeof x.code === 'number' ? x.code : -1, out: (x.stdout ?? '') + (x.stderr ?? '') };
  }
  writeFileSync(path.join(evidence, `arm-${arm}.log`), `# ${script} ${JSON.stringify(opts.env ?? {})}\n${res.out}# exit ${res.code}\n`);
  return res;
}
const sh = (arm: string, cmd: string, opts: RunOpts = {}) => {
  const f = path.join(state, `cmd-${arm}.sh`);
  writeFileSync(f, cmd);
  return runner(`/state/cmd-${arm}.sh`, arm, { ...opts, mounts: [...(opts.mounts ?? []), `${state}:/state`] });
};
const sql = (q: string, db = 'brightwater') =>
  execFileSync('docker', ['exec', '-i', dbId, 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'brightwater', '-d', db], { input: q, encoding: 'utf8' }).trim();
const events = (out: string) => out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as { event: string; msg: string; process: string });
const sets = (prefix = 'backups') => (existsSync(path.join(bucketDir, prefix)) ? readdirSync(path.join(bucketDir, prefix)).sort() : []);
const stampDaysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const clearBucket = () => sh('clear', 'rm -rf /bucket/backups /bucket/planted /bucket/blocker\n');

beforeAll(async () => {
  mkdirSync(evidence, { recursive: true });
  if (!stack.PROJECT) throw new Error(`stack unavailable: ${state}/stack.env is missing (bash infra/backup/tests/stack.sh up)`);
  dbId = execFileSync('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${stack.PROJECT}`, '--filter', 'label=com.docker.compose.service=db'], { encoding: 'utf8' }).trim();
  if (!dbId) throw new Error(`stack unavailable: no db container in ${stack.PROJECT}`);
  await clearBucket();
});

describe('backup and restore test on the local stack (SPECIFICATIONS 11.7)', () => {
  let stamp = '';

  // why: NFR-07
  it('1 backup writes its dump and manifest to the target and its passed backup_record in the same snapshot transaction', async () => {
    const before = Number(sql("SELECT count(*) FROM system.backup_record"));
    const r = await runner('backup.sh', 'backup');
    expect(r.code, r.out).toBe(0);
    expect(events(r.out).map((e) => e.event)).toEqual(['started', 'counted', 'dumped', 'uploaded', 'retention', 'passed']);
    [stamp] = sets() as [string];
    expect(sets()).toHaveLength(1);
    expect(readdirSync(path.join(bucketDir, 'backups', stamp)).sort()).toEqual(['brightwater.dump', 'manifest.json']);
    const manifest = JSON.parse(readFileSync(path.join(bucketDir, 'backups', stamp, 'manifest.json'), 'utf8'));
    const bytes = readFileSync(path.join(bucketDir, 'backups', stamp, 'brightwater.dump')).length;
    expect(manifest.dump.bytes).toBe(bytes);
    // F-1582: the manifest names the checksum method it was made with.
    expect(manifest.checksum_method).toBe('full-row-v2');
    // Every table of world, pbs and system, counted inside the snapshot.
    const tables = sql("SELECT count(*) FROM pg_tables WHERE schemaname IN ('world', 'pbs', 'system')");
    expect(Object.keys(manifest.tables)).toHaveLength(Number(tables));
    expect(manifest.tables['world.customer'].rows).toBe(Number(sql('SELECT count(*) FROM world.customer')));
    // The snapshot predates the row its own transaction inserts: the manifest counts the records before it.
    expect(manifest.tables['system.backup_record'].rows).toBe(before);
    const rec = JSON.parse(sql(`SELECT row_to_json(r) FROM (SELECT result, size_bytes, nights_kept, location, manifest,
        started_real = (manifest->>'taken_real')::timestamptz AS same_start FROM system.backup_record
        WHERE kind = 'backup' ORDER BY started_real DESC LIMIT 1) r`));
    expect(rec).toMatchObject({ result: 'passed', size_bytes: bytes, nights_kept: 1, location: `file:///bucket/backups/${stamp}/`, same_start: true });
    expect(rec.manifest).toEqual(manifest);
  });

  // why: NFR-07
  it('the restore test fetches the set from the target, sees its half copy fail, restores, and passes every compare', async () => {
    // The restore's memory beside the running stack: the db container's cgroup, sampled every 0.5 s. memory.current
    // counts page cache, which the kernel reclaims at the 512m cap; anon cannot be reclaimed; oom_kill counts kills.
    const cg = (f: string) => execFileSync('docker', ['exec', dbId, 'cat', `/sys/fs/cgroup/${f}`], { encoding: 'utf8' });
    const oom = () => Number(/^oom_kill (\d+)$/m.exec(cg('memory.events'))?.[1]);
    const oomBefore = oom();
    const samples: { cur: number; anon: number }[] = [];
    const tick = setInterval(() => {
      // anon plus shmem (PostgreSQL's shared buffers): the part no reclaim can free.
      execFile('docker', ['exec', dbId, 'sh', '-c', 'cat /sys/fs/cgroup/memory.current; grep -E "^(anon|shmem) " /sys/fs/cgroup/memory.stat'], (_e, out) => {
        const m = /^(\d+)\nanon (\d+)\nshmem (\d+)/.exec(out ?? '');
        if (m) samples.push({ cur: Number(m[1]), anon: Number(m[2]) + Number(m[3]) });
      });
    }, 500);
    const r = await runner('restore-test.sh', 'restore');
    clearInterval(tick);
    const oomAfter = oom();
    const mib = (b: number) => Math.round(b / 1048576);
    const peak = (k: 'cur' | 'anon') => mib(Math.max(...samples.map((s) => s[k])));
    const stats = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}}',
      ...execFileSync('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${stack.PROJECT}`], { encoding: 'utf8' }).trim().split('\n')], { encoding: 'utf8' });
    writeFileSync(path.join(evidence, 'memory-local.txt'), `restore beside the running stack (local, Docker Desktop; db mem_limit 512m, memory.max ${cg('memory.max').trim()}):\n` +
      `db container: ${samples.length} samples every 0.5 s; memory.current first ${mib(samples[0]?.cur ?? 0)} MiB, peak ${peak('cur')} MiB; ` +
      `anon+shmem first ${mib(samples[0]?.anon ?? 0)} MiB, peak ${peak('anon')} MiB; oom_kill before ${oomBefore}, after ${oomAfter}\n` +
      `stack after the restore (docker stats):\n${stats}`);
    expect(oomAfter).toBe(oomBefore);
    expect(r.code, r.out).toBe(0);
    const ev = events(r.out);
    const checks = ev.filter((e) => e.event.startsWith('check_')).map((e) => `${e.event} ${e.msg.split(':')[0]}`);
    expect(checks).toEqual(['fetched', 'truncated', 'restored', 'compare', 'import', 'record'].map((c) => `check_passed ${c}`));
    expect(ev.find((e) => e.msg.startsWith('truncated'))?.msg).toMatch(/failed to restore \(exit [1-9]\d*\), as required/);
    expect(ev.find((e) => e.msg.startsWith('fetched'))?.msg).toMatch(/SHA-256 equals the manifest's/);
    expect(ev.find((e) => e.msg.startsWith('import'))?.msg).toBe('import: 15 FR-IMP-6 counts equal their targets');
    expect(sql("SELECT result || ' ' || location FROM system.backup_record WHERE kind = 'restore_test' ORDER BY started_real DESC LIMIT 1"))
      .toBe(`passed file:///bucket/backups/${stamp}/`);
    expect(sql("SELECT count(*) FROM pg_database WHERE datname = 'restore_check'")).toBe('0');
  });

  // why: NFR-07
  it('a planted manifest with 1 wrong checksum fails the compare, on that table only', async () => {
    const m = JSON.parse(readFileSync(path.join(bucketDir, 'backups', stamp, 'manifest.json'), 'utf8'));
    const md5 = m.tables['world.customer'].md5 as string;
    m.tables['world.customer'].md5 = (md5[0] === '0' ? '1' : '0') + md5.slice(1);
    writeFileSync(path.join(state, 'planted-manifest.json'), JSON.stringify(m));
    await sh('plant', `mkdir -p /bucket/planted/${stamp} && cp /bucket/backups/${stamp}/brightwater.dump /bucket/planted/${stamp}/ && cp /state/planted-manifest.json /bucket/planted/${stamp}/manifest.json\n`);
    const records = sql("SELECT count(*) FROM system.backup_record WHERE kind = 'restore_test'");
    const r = await runner('restore-test.sh', 'planted-manifest', { env: { BACKUP_PREFIX: 'planted/', BACKUP_RECORD: 'off' } });
    expect(r.code, r.out).toBe(1);
    const ev = events(r.out);
    expect(ev.filter((e) => e.event === 'check_failed').map((e) => e.msg.split(':')[0])).toEqual(['compare', 'record']);
    expect(ev.filter((e) => e.event === 'mismatch').map((e) => e.msg.split(':')[0])).toEqual(['world.customer']);
    expect(ev.find((e) => e.event === 'check_failed')?.msg).toMatch(/^compare: 1 of \d+ manifest tables differ/);
    expect(sql("SELECT count(*) FROM system.backup_record WHERE kind = 'restore_test'")).toBe(records);
    await sh('unplant', 'rm -rf /bucket/planted\n');
  });

  // why: F-1582 the sets in the hosted bucket made before F-1579 carry key-only checksums and no method mark; the checkers
  // compute the restored side with the method the manifest names, so old and new sets both check clean, a real
  // difference still fails under each method, and an unknown method is refused.
  describe('checksum methods (F-1582)', () => {
    const scratch = 'f1582_src';
    const loc = () => `file:///bucket/planted/${stamp}/`;
    const deployedSql = readFileSync(path.join(root, 'infra/backup/tests/fixtures/checksums-deployed-c9821657.sql'), 'utf8');
    const currentSql = readFileSync(path.join(root, 'infra/backup/checksums.sql'), 'utf8');
    const newManifest = () => JSON.parse(readFileSync(path.join(bucketDir, 'backups', stamp, 'manifest.json'), 'utf8'));
    /** A scratch database restored from the set's dump, optionally changed by 1 statement, to compute a set's checksums on. */
    const scratchDb = (change?: string) => {
      sql(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`, 'postgres');
      sql(`CREATE DATABASE ${scratch}`, 'postgres');
      execFileSync('docker', ['exec', '-i', dbId, 'pg_restore', '-U', 'brightwater', '-d', scratch, '--exit-on-error'],
        { input: readFileSync(path.join(bucketDir, 'backups', stamp, 'brightwater.dump')), maxBuffer: 64 * 1024 * 1024 });
      if (change) sql(change, scratch);
    };
    /** The checksums the code before F-1579 made (its deployed checksums.sql), on the scratch database. */
    const deployedSums = () => JSON.parse(sql(`${deployedSql}\nSELECT pg_temp.bw_checksums();`, scratch));
    /** A manifest the old way: no checksum_method, key-only checksums by the deployed code. */
    const oldManifest = () => {
      const m = newManifest();
      delete m.checksum_method;
      return { ...m, tables: deployedSums() };
    };
    /** Plants the set's dump with this manifest under planted/, with its passed backup record when asked, and runs the restore test. */
    const restoreTest = async (arm: string, manifest: object, withRecord: boolean) => {
      const text = JSON.stringify(manifest);
      writeFileSync(path.join(state, `${arm}.json`), text);
      await sh(`plant-${arm}`, `rm -rf /bucket/planted && mkdir -p /bucket/planted/${stamp} && cp /bucket/backups/${stamp}/brightwater.dump /bucket/planted/${stamp}/ && cp /state/${arm}.json /bucket/planted/${stamp}/manifest.json\n`);
      if (withRecord) {
        sql(`INSERT INTO system.backup_record (kind, location, started_real, finished_real, result, size_bytes, nights_kept, manifest)
          VALUES ('backup', '${loc()}', clock_timestamp(), clock_timestamp(), 'passed', 1, 1, '${text.replace(/'/g, "''")}'::jsonb)`);
      }
      try {
        const r = await runner('restore-test.sh', arm, { env: { BACKUP_PREFIX: 'planted/', BACKUP_RECORD: 'off' } });
        const ev = events(r.out);
        return { ...r, ev, failed: ev.filter((e) => e.event === 'check_failed').map((e) => e.msg.split(':')[0]),
          mismatched: ev.filter((e) => e.event === 'mismatch').map((e) => e.msg.split(':')[0]),
          compare: ev.find((e) => e.msg.startsWith('compare:'))?.msg ?? '' };
      } finally {
        sql(`DELETE FROM system.backup_record WHERE kind = 'backup' AND location = '${loc()}'`);
        await sh(`unplant-${arm}`, 'rm -rf /bucket/planted\n');
      }
    };
    /** The drill's restore-copy.sh check on a set folder holding only this manifest. */
    const restoreCopyCheck = async (arm: string, manifest: object) => {
      writeFileSync(path.join(state, `${arm}.json`), JSON.stringify(manifest));
      return sh(arm, `set -e\nmkdir -p /tmp/set && cp /state/${arm}.json /tmp/set/manifest.json\nexec bash /opt/brightwater/drill/restore-copy.sh check /tmp/set\n`,
        { mounts: [`${path.join(root, 'infra/drill')}:/opt/brightwater/drill:ro`] });
    };

    it('a set made the old way (no checksum_method, key-only checksums by the deployed code) checks clean', async () => {
      scratchDb();
      const m = oldManifest();
      expect(m).not.toHaveProperty('checksum_method');
      // The key-only checksums differ from the set's own full-row ones: read as full-row, the old set would fail every table.
      expect(m.tables['world.customer'].md5).not.toBe(newManifest().tables['world.customer'].md5);
      const r = await restoreTest('method-old', m, true);
      expect(r.code, r.out).toBe(0);
      expect(r.failed).toEqual([]);
      expect(r.compare).toMatch(/every row count and checksum equals the manifest \(checksum method key-only-v1\)$/);
    });

    it('a set made the new way (checksum_method full-row-v2) checks clean', async () => {
      const r = await restoreTest('method-new', newManifest(), true);
      expect(r.code, r.out).toBe(0);
      expect(r.failed).toEqual([]);
      expect(r.compare).toMatch(/every row count and checksum equals the manifest \(checksum method full-row-v2\)$/);
    });

    it('key-only-v1: a manifest made after 1 changed primary key fails the compare, on that table only', async () => {
      // 1 customer's key changed, FK triggers off for that 1 transaction (the scratch database is thrown away).
      scratchDb(`BEGIN; SET LOCAL session_replication_role = replica;
        UPDATE world.customer SET id = gen_random_uuid() WHERE id = (SELECT id FROM world.customer ORDER BY id LIMIT 1); COMMIT;`);
      const r = await restoreTest('method-old-planted', oldManifest(), false);
      expect(r.code, r.out).toBe(1);
      expect(r.mismatched).toEqual(['world.customer']);
      expect(r.failed).toEqual(['compare', 'record']);
      expect(r.compare).toMatch(/^compare: 1 of \d+ manifest tables differ .*checksum method key-only-v1\)$/);
    });

    it('full-row-v2: a manifest made after 1 changed value outside a key fails the compare, on that table only', async () => {
      scratchDb('UPDATE world.customer SET texts_on = NOT texts_on WHERE id = (SELECT id FROM world.customer ORDER BY id LIMIT 1)');
      const m = { ...newManifest(), tables: JSON.parse(sql(`${currentSql}\nSELECT pg_temp.bw_checksums('full-row-v2');`, scratch)) };
      const r = await restoreTest('method-new-planted', m, false);
      expect(r.code, r.out).toBe(1);
      expect(r.mismatched).toEqual(['world.customer']);
      expect(r.failed).toEqual(['compare', 'record']);
      expect(r.compare).toMatch(/^compare: 1 of \d+ manifest tables differ .*checksum method full-row-v2\)$/);
    });

    it('an unknown checksum method fails the restore test by name, and the drill check refuses it before any compare', async () => {
      const m = { ...newManifest(), checksum_method: 'full-row-v9' };
      const r = await restoreTest('method-unknown', m, true);
      expect(r.code, r.out).toBe(1);
      expect(r.failed).toEqual(['compare']);
      expect(r.compare).toMatch(/^compare: the compare stopped \(psql exit \d+\): unknown checksum method "full-row-v9" in the manifest/);
      expect(r.mismatched).toEqual([]);
      const d = await restoreCopyCheck('method-unknown-drill', m);
      expect(d.code, d.out).toBe(2);
      expect(d.out).toMatch(/refused: unknown checksum method \\?"full-row-v9\\?" in the manifest/);
      expect(events(d.out).map((e) => e.event)).not.toContain('check_passed');
      // A null method is no method: refused too, never read as the old one.
      const n = await restoreCopyCheck('method-null-drill', { ...newManifest(), checksum_method: null });
      expect(n.code, n.out).toBe(2);
      expect(n.out).toMatch(/refused: unknown checksum method null/);
    });

    it('drops its scratch database', () => {
      sql(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`, 'postgres');
      expect(sql(`SELECT count(*) FROM pg_database WHERE datname = '${scratch}'`, 'postgres')).toBe('0');
    });
  });

  // why: NFR-07
  it('retention deletes a set older than 14 days and keeps a newer one', async () => {
    const old = stampDaysAgo(20);
    const young = stampDaysAgo(13);
    await sh('plant-dated', [old, young].map((s) => `mkdir -p /bucket/backups/${s} && cp /bucket/backups/${stamp}/manifest.json /bucket/backups/${s}/ && echo planted > /bucket/backups/${s}/brightwater.dump`).join('\n') + '\n');
    expect(sets()).toEqual([old, young, stamp].sort());
    const r = await runner('retention.sh', 'retention');
    expect(r.code, r.out).toBe(0);
    expect(sets()).toEqual([young, stamp].sort());
    expect(events(r.out).filter((e) => e.event === 'deleted').map((e) => e.msg.split(' ')[0]).sort()).toEqual([`${old}/brightwater.dump`, `${old}/manifest.json`]);
    await sh('unplant-dated', `rm -rf /bucket/backups/${young}\n`);
  });

  // why: NFR-07
  it('a forced failure (the target cannot be written) writes a failed backup_record, raises backup_failed and leaves no set', async () => {
    await sh('blocker', 'echo not-a-folder > /bucket/blocker\n');
    const passed = sql("SELECT count(*) FROM system.backup_record WHERE kind = 'backup' AND result = 'passed'");
    const r = await runner('backup.sh', 'forced-failure', { env: { BACKUP_LOCAL_DIR: '/bucket/blocker' } });
    expect(r.code, r.out).toBe(1);
    const ev = events(r.out);
    expect(ev.map((e) => e.event)).toContain('backup_failed');
    expect(ev.find((e) => e.event === 'backup_failed')?.msg).toMatch(/a failed backup_record row is written/);
    // The SD-30 rule's input: the last backup failed. No passed row was added (its transaction rolled back).
    expect(sql("SELECT result FROM system.backup_record WHERE kind = 'backup' ORDER BY started_real DESC LIMIT 1")).toBe('failed');
    expect(sql("SELECT count(*) FROM system.backup_record WHERE kind = 'backup' AND result = 'passed'")).toBe(passed);
    expect(sets()).toEqual([stamp]);
    await sh('unblock', 'rm -f /bucket/blocker\n');
  });

  // why: F-390
  it('with no db container the backup and the restore test log the reason and their failure event, never an empty journal', async () => {
    for (const [script, event] of [['backup.sh', 'backup_failed'], ['restore-test.sh', 'failed']] as const) {
      const r = await runner(script, `no-db-${script.replace('.sh', '')}`, { env: { BW_PROJECT: 'bw-no-such-project' } });
      expect(r.code, r.out).toBe(1);
      const ev = events(r.out);
      expect(ev.filter((e) => e.event === 'error').map((e) => e.msg).join('\n')).toMatch(/no running db container/);
      expect(ev.map((e) => e.event), r.out).toContain(event);
    }
  });

  // why: F-492
  it('a lock wait that times out runs the cleanup: a failed record, no work folder, no set, and the holder keeps restore_check', async () => {
    // Another job holds the lock and owns restore_check, as a running restore test does.
    sql('DROP DATABASE IF EXISTS restore_check', 'postgres');
    sql('CREATE DATABASE restore_check', 'postgres');
    const since = sql('SELECT clock_timestamp()');
    const before = sets();
    try {
      for (const [script, kind] of [['backup.sh', 'backup'], ['restore-test.sh', 'restore_test']] as const) {
        const r = await sh(`lock-timeout-${kind}`, [
          'mkdir -p /run/lock', 'exec 8>/run/lock/brightwater-backup.lock', 'flock 8',
          `BW_BACKUP_LOCK_WAIT=2 bash /opt/brightwater/backup/${script}; echo "rc=$?"`,
          'echo "work=$(find /var/lib/brightwater-backup -mindepth 1 2>/dev/null | wc -l)"', ''].join('\n'));
        expect(r.out, r.out).toMatch(/^rc=1$/m);
        expect(r.out, r.out).toMatch(/^work=0$/m);
        expect(events(r.out).find((e) => e.event === 'error')?.msg).toMatch(/held the lock for 2 seconds/);
        expect(sql(`SELECT string_agg(result, ',') FROM system.backup_record WHERE kind = '${kind}' AND started_real >= '${since}'`), r.out).toBe('failed');
      }
      // F-1774: the backup's failed row starts when the run did (before the 2 s wait), not when it finished
      expect(sql(`SELECT bool_and(finished_real - started_real >= interval '2 seconds') FROM system.backup_record WHERE kind = 'backup' AND started_real >= '${since}'`)).toBe('t');
      expect(sql("SELECT count(*) FROM pg_database WHERE datname = 'restore_check'", 'postgres')).toBe('1');
      expect(sets()).toEqual(before);
    } finally {
      sql(`DELETE FROM system.backup_record WHERE result = 'failed' AND started_real >= '${since}'`);
      sql('DROP DATABASE IF EXISTS restore_check', 'postgres');
    }
  });

  // why: F-1697
  it('before setup (no day_snapshot row) a timer run of the backup and the restore test exits 0 by name and writes nothing', async () => {
    sql('CREATE TABLE public.f1697_kept AS SELECT * FROM system.day_snapshot; DELETE FROM system.day_snapshot');
    const records = sql('SELECT count(*) FROM system.backup_record');
    const before = sets();
    try {
      for (const script of ['backup.sh', 'restore-test.sh']) {
        const r = await runner(script, `not-set-up-${script.replace('.sh', '')}`);
        expect(r.code, r.out).toBe(0);
        expect(events(r.out).map((e) => `${e.event} ${e.msg}`)).toEqual([expect.stringMatching(/^not_set_up no world is set up yet \(no system\.day_snapshot row\)/)]);
      }
      expect(sql('SELECT count(*) FROM system.backup_record')).toBe(records);
      expect(sets()).toEqual(before);
    } finally {
      sql('INSERT INTO system.day_snapshot SELECT * FROM public.f1697_kept; DROP TABLE public.f1697_kept');
    }
  });

  // why: F-1773
  it('a snapshot session that ends after the preflight fails the backup with its failed record, never an unbound variable', async () => {
    const since = sql('SELECT clock_timestamp()');
    const before = sets();
    try {
      const r = await runner('backup.sh', 'session-ends', {
        mounts: [`${path.join(root, 'infra/backup/tests/stubs-session')}:/stubs-session:ro`],
        path: '/stubs-session:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      });
      expect(r.code, r.out).toBe(1);
      expect(r.out).not.toMatch(/unbound variable/);
      const ev = events(r.out);
      expect(ev.find((e) => e.event === 'backup_failed')?.msg, r.out).toMatch(/a failed backup_record row is written/);
      expect(sql(`SELECT string_agg(result, ',') FROM system.backup_record WHERE kind = 'backup' AND started_real >= '${since}'`), r.out).toBe('failed');
      expect(sets()).toEqual(before);
    } finally {
      sql(`DELETE FROM system.backup_record WHERE result = 'failed' AND started_real >= '${since}'`);
    }
  });

  // why: F-1771
  it('the setup preflight never reads a database that does not answer, or a query that errors, as not set up: both runs fail with their failed records', async () => {
    const before = sets();
    const scripts = [['backup.sh', 'backup', 'backup_failed'], ['restore-test.sh', 'restore_test', 'failed']] as const;
    // 1. The db container paused, as the reviewer ran it: docker exec is refused, so no query answers and no record can be written.
    execFileSync('docker', ['pause', dbId]);
    try {
      for (const [script, , event] of scripts) {
        const r = await runner(script, `db-paused-${script.replace('.sh', '')}`);
        expect(r.code, r.out).toBe(1);
        const ev = events(r.out);
        expect(ev.map((e) => e.event), r.out).not.toContain('not_set_up');
        expect(ev.find((e) => e.event === 'error')?.msg, r.out).toBe('the database did not answer whether a world is set up');
        expect(ev.map((e) => e.event), r.out).toContain(event);
      }
    } finally {
      execFileSync('docker', ['unpause', dbId]);
    }
    // 2. The database answers but the preflight's query errors: each run fails and writes its failed record.
    const since = sql('SELECT clock_timestamp()');
    sql(`ALTER TABLE system.day_snapshot RENAME TO day_snapshot_f1771;
      CREATE VIEW system.day_snapshot AS SELECT x FROM generate_series(1, 1) x WHERE x / 0 = 1`);
    try {
      for (const [script, kind, event] of scripts) {
        const r = await runner(script, `query-error-${script.replace('.sh', '')}`);
        expect(r.code, r.out).toBe(1);
        const ev = events(r.out);
        expect(ev.map((e) => e.event), r.out).not.toContain('not_set_up');
        expect(ev.find((e) => e.event === 'error')?.msg, r.out).toBe('the database did not answer whether a world is set up');
        expect(ev.map((e) => e.event), r.out).toContain(event);
        expect(sql(`SELECT string_agg(result, ',') FROM system.backup_record WHERE kind = '${kind}' AND started_real >= '${since}'`), r.out).toBe('failed');
      }
      expect(events(readFileSync(path.join(evidence, 'arm-query-error-backup.log'), 'utf8')).find((e) => e.event === 'backup_failed')?.msg)
        .toMatch(/a failed backup_record row is written/);
    } finally {
      sql('DROP VIEW system.day_snapshot; ALTER TABLE system.day_snapshot_f1771 RENAME TO day_snapshot');
      sql(`DELETE FROM system.backup_record WHERE result = 'failed' AND started_real >= '${since}'`);
    }
    expect(sets()).toEqual(before);
  });

  // why: F-394
  it('a retention failure is logged and the backup it follows is kept and recorded passed', async () => {
    const stub = path.join(state, 'retention-fails.sh');
    writeFileSync(stub, '#!/usr/bin/env bash\necho "retention stub: delete failed" >&2\nexit 1\n');
    chmodSync(stub, 0o755);
    const before = sets().length;
    const passed = Number(sql("SELECT count(*) FROM system.backup_record WHERE kind = 'backup' AND result = 'passed'"));
    const r = await runner('backup.sh', 'retention-failure', { mounts: [`${stub}:/opt/brightwater/backup/retention.sh:ro`] });
    expect(r.code, r.out).toBe(0);
    const ev = events(r.out).map((e) => e.event);
    expect(ev).toContain('warn');
    expect(ev).toContain('passed');
    expect(ev).not.toContain('backup_failed');
    expect(sets().length).toBe(before + 1);
    expect(Number(sql("SELECT count(*) FROM system.backup_record WHERE kind = 'backup' AND result = 'passed'"))).toBe(passed + 1);
  });

  // why: F-393
  it('a bucket manifest that differs from the backup_record manifest fails the record check alone', async () => {
    // The restore test takes the newest set, which the retention-failure test above made.
    const file = path.join(bucketDir, 'backups', sets().at(-1) as string, 'manifest.json');
    const original = readFileSync(file, 'utf8');
    try {
      writeFileSync(file, JSON.stringify({ ...JSON.parse(original), planted: 'differs from the stored record' }));
      const r = await runner('restore-test.sh', 'planted-record', { env: { BACKUP_RECORD: 'off' } });
      expect(r.code, r.out).toBe(1);
      expect(events(r.out).filter((e) => e.event === 'check_failed').map((e) => e.msg.split(':')[0])).toEqual(['record']);
    } finally {
      writeFileSync(file, original);
    }
  });

  // why: F-393
  it('a manifest with 1 table the dump lacks fails the compare on that table', async () => {
    const m = JSON.parse(readFileSync(path.join(bucketDir, 'backups', stamp, 'manifest.json'), 'utf8'));
    m.tables['world.never_existed'] = { rows: 1, md5: '00000000000000000000000000000000' };
    writeFileSync(path.join(state, 'planted-extra-table.json'), JSON.stringify(m));
    await sh('plant-extra', `mkdir -p /bucket/planted/${stamp} && cp /bucket/backups/${stamp}/brightwater.dump /bucket/planted/${stamp}/ && cp /state/planted-extra-table.json /bucket/planted/${stamp}/manifest.json\n`);
    const r = await runner('restore-test.sh', 'planted-extra-table', { env: { BACKUP_PREFIX: 'planted/', BACKUP_RECORD: 'off' } });
    expect(r.code, r.out).toBe(1);
    expect(events(r.out).filter((e) => e.event === 'mismatch').map((e) => e.msg.split(':')[0])).toEqual(['world.never_existed']);
    expect(events(r.out).filter((e) => e.event === 'check_failed').map((e) => e.msg.split(':')[0])).toContain('compare');
    await sh('unplant-extra', 'rm -rf /bucket/planted\n');
  });

  // why: NFR-10
  it('a Region outside the United States is refused before anything is read or written', async () => {
    const records = sql('SELECT count(*) FROM system.backup_record');
    for (const script of ['backup.sh', 'restore-test.sh', 'retention.sh']) {
      const r = await runner(script, `region-refused-${script.replace('.sh', '')}`, { env: { BACKUP_TARGET: 'lightsail', BACKUP_BUCKET: 'bw-proof-bucket', BACKUP_REGION: 'eu-west-1' } });
      expect(r.code, r.out).toBe(2);
      expect(r.out).toContain('BACKUP_REGION eu-west-1 is not a US Region (NFR-10)');
    }
    expect(sql('SELECT count(*) FROM system.backup_record')).toBe(records);
  });
});

describe('the lightsail target through the AWS CLI, against an S3-compatible server (section 4.8, SD-36)', () => {
  const s3env = { BACKUP_TARGET: 'lightsail', BACKUP_BUCKET: 'bw-proof-bucket', BACKUP_REGION: 'us-east-1', BACKUP_ENDPOINT_URL: 'http://s3:7070' };

  // why: OQ-12, NFR-07
  it('backs up, restore-tests and expires sets in the bucket with the same scripts', async () => {
    const b = await runner('backup.sh', 's3-backup', { env: s3env, s3: true });
    expect(b.code, b.out).toBe(0);
    const r = await runner('restore-test.sh', 's3-restore', { env: s3env, s3: true });
    expect(r.code, r.out).toBe(0);
    expect(events(r.out).filter((e) => e.event === 'check_passed')).toHaveLength(6);
    expect(sql("SELECT location FROM system.backup_record WHERE kind = 'restore_test' ORDER BY started_real DESC LIMIT 1")).toMatch(/^s3:\/\/bw-proof-bucket\/backups\/\d{8}T\d{6}Z\/$/);
    const old = stampDaysAgo(15);
    const aws = 'aws --endpoint-url http://s3:7070 --region us-east-1';
    await sh('s3-plant', `echo planted > /tmp/p && ${aws} s3 cp --only-show-errors /tmp/p s3://bw-proof-bucket/backups/${old}/manifest.json\n`, { s3: true });
    const t = await runner('retention.sh', 's3-retention', { env: s3env, s3: true });
    expect(t.code, t.out).toBe(0);
    expect(events(t.out).filter((e) => e.event === 'deleted').map((e) => e.msg.split(' ')[0])).toEqual([`${old}/manifest.json`]);
    const left = await sh('s3-list', `${aws} s3 ls --recursive s3://bw-proof-bucket/backups/\n`, { s3: true });
    expect(left.out).not.toContain(old);
    expect(left.out).toMatch(/brightwater\.dump/);
  });

  // why: NFR-07, NFR-10
  it("the hosted check's server half passes every arm against the stack (systemd stood in for)", async () => {
    // The server's .env holds only the 3 backup settings here; the AWS keys of the local S3 server reach the CLI through
    // a config file, so the check's "no AWS key in the environment" preflight holds as on the server.
    writeFileSync(path.join(state, 'server.env'), 'BACKUP_TARGET=lightsail\nBACKUP_BUCKET=bw-proof-bucket\nBACKUP_REGION=us-east-1\n');
    const keys = kv(path.join(state, 's3.env'));
    writeFileSync(path.join(state, 'aws-config'), `[default]\naws_access_key_id = ${keys.AWS_ACCESS_KEY_ID}\naws_secret_access_key = ${keys.AWS_SECRET_ACCESS_KEY}\n`);
    chmodSync(path.join(state, 'aws-config'), 0o600);
    const r = await runner('hosted-check-server.sh', 'hosted-check-rehearsal', {
      env: { BACKUP_ENDPOINT_URL: 'http://s3:7070', AWS_CONFIG_FILE: '/state/aws-config', BACKUP_TARGET: '', BACKUP_LOCAL_DIR: '' },
      mounts: [`${path.join(state, 'server.env')}:/opt/brightwater/.env:ro`, `${path.join(root, 'infra/hosted/systemd')}:/opt/brightwater/systemd:ro`,
        `${path.join(root, 'infra/backup/tests/stubs')}:/stubs:ro`, `${state}:/state`],
      path: '/stubs:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    });
    rmSync(path.join(state, 'aws-config'));
    expect(r.code, r.out).toBe(0);
    const verdict = r.out.split('\n').find((l) => l.includes('HOSTED-CHECK-SERVER '));
    expect(verdict).toMatch(/HOSTED-CHECK-SERVER PASS: preflight=PASS region=PASS backup=PASS restore=PASS planted=PASS retention=PASS/);
    expect(r.out).toMatch(/MEMORY restore beside the running stack: samples \d+/);
  });
});
