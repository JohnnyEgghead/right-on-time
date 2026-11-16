// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1801 (owner answer 5d88f9a6, "Reset it at release") infra/deploy/reset-world.sh recreates a set-up world's database and runs
// setup fresh, in the owner's order, from the stack's own settings file, and changes nothing before its checks pass. These runs use --local
// with a stand-in docker on PATH that records each call; nothing here starts a container or reaches a server. The real run on a local stack
// is the lane's evidence (reset-local.log).
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const dir = mkdtempSync(path.join(tmpdir(), 'reset-world-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const SEED = 'test-seed-not-real-0123456789';
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s|%s\\n' "$*" "\${SAMPLE_PASSWORD_SEED:-unset}" >>"$CALLS"
case "$*" in
  'volume ls'*) [ -z "\${FAKE_VOL:-}" ] || echo "$FAKE_VOL" ;;
  *'exec -T db psql'*)
    if [ "\${FAKE_DB:-up}" != up ] && ! grep -q 'timeout 180 db' "$CALLS"; then exit 1
    elif [[ "$*" == *'greatest(world_epoch'* ]]; then if grep -q 'timeout 180 db' "$CALLS"; then echo "\${FAKE_EPOCH_AFTER:-1}"; else echo "\${FAKE_EPOCH:-1}"; fi; else echo 42; fi ;;
  *'run --rm --no-deps -T migrate') if [ -n "\${FAKE_MIGRATE_FAIL:-}" ]; then exit 1; fi; echo '{"level":30,"status":"migrated"}' ;;
  *'run --rm --no-deps -T setup')
    if [ "\${FAKE_SETUP:-done}" = done ]; then echo '{"level":30,"status":"setup done"}'; else echo '{"level":50,"status":"setup refused","errorCode":"world_not_fresh"}'; exit 1; fi ;;
esac
exit 0
`;

function run(name: string, opts: { envText?: string; vol?: string; db?: 'up' | 'down'; setup?: 'done' | 'refused'; shellSeed?: string; epoch?: number; epochAfter?: number; migrateFail?: boolean } = {}) {
  const d = path.join(dir, name);
  const bin = path.join(d, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(path.join(bin, 'docker'), 0o755);
  const envFile = path.join(d, 'stack.env');
  const envText = opts.envText ?? `BW_IMAGE=bw-app:t\nSAMPLE_PASSWORD_SEED=${SEED}\nROUTES=locked\n`;
  writeFileSync(envFile, envText);
  const calls = path.join(d, 'calls.txt');
  writeFileSync(calls, '');
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: d, CALLS: calls, BW_DEPLOY_LOG_DIR: path.join(d, 'logs'),
    FAKE_VOL: opts.vol ?? 'bw-t_pgdata', FAKE_DB: opts.db ?? 'up', FAKE_SETUP: opts.setup ?? 'done', FAKE_EPOCH: String(opts.epoch ?? 1),
    FAKE_EPOCH_AFTER: String(opts.epochAfter ?? opts.epoch ?? 1),
  };
  if (opts.migrateFail) env.FAKE_MIGRATE_FAIL = '1';
  if (opts.shellSeed) env.SAMPLE_PASSWORD_SEED = opts.shellSeed;
  const r = spawnSync('bash', [path.join(root, 'infra/deploy/reset-world.sh'), '--local', '--project', 'bw-t', '--env-file', envFile], { encoding: 'utf8', env, cwd: root });
  const lines = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('|') as [string, string]);
  const logs = readdirSync(path.join(d, 'logs'));
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: lines, envAfter: readFileSync(envFile, 'utf8'), envText, logs };
}

/** The compose subcommand of a recorded call, without the -p/-f/--env-file prefix every compose call carries. */
const sub = (call: string) => call.replace(/^compose -p bw-t -f \S+\/infra\/compose\.yaml --env-file \S+ /, 'compose ');

describe('infra/deploy/reset-world.sh --local (F-1801)', () => {
  // why: F-1801 the owner's steps in order: stop web, worker and pbs; remove db and its database volume; start db; migrate; setup; start
  // the services; every compose call is scoped to the stack's own project and settings file, and the step ends by naming hosted-check
  it('runs stop, remove, db, migrate, setup and start in that order on its own project, and names the next step', () => {
    const r = run('order');
    expect(r.status, r.out).toBe(0);
    for (const [c] of r.calls) if (c.startsWith('compose')) expect(c).toMatch(/^compose -p bw-t -f \S+\/infra\/compose\.yaml --env-file \S+\/stack\.env /);
    const changing = r.calls.map(([c]) => sub(c)).filter((c) => !/ ps |exec -T db psql| volume ls /.test(` ${c} `));
    expect(changing).toEqual([
      'compose stop web worker pbs',
      'compose rm -sf db',
      'volume rm bw-t_pgdata',
      'compose up -d --no-build --wait --wait-timeout 180 db',
      'compose run --rm --no-deps -T migrate',
      'compose --profile setup run --rm --no-deps -T setup',
      'compose up -d --no-build --wait --wait-timeout 180 web worker pbs',
    ]);
    expect(r.calls[0]![0]).toBe('volume ls -q --filter label=com.docker.compose.project=bw-t --filter label=com.docker.compose.volume=pgdata');
    expect(r.out).toContain('setup done');
    expect(r.out).toMatch(/Next step: bash infra\/backup\/hosted-check\.sh\n?$/);
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toMatch(/^\d{8}T\d{6}Z-reset-local\.log$/);
  });

  // why: F-1801 the reset changes no setting (ROUTES stays as it is), and the seed reaches setup only through Compose's settings file:
  // never printed, and a value in the caller's shell is not passed on in its place
  it('leaves the settings file byte-for-byte, never prints the seed, and drops a seed set in the shell', () => {
    const r = run('settings', { shellSeed: 'a-different-shell-seed-000000' });
    expect(r.status, r.out).toBe(0);
    expect(r.envAfter).toBe(r.envText);
    expect(r.out).not.toContain(SEED);
    expect(r.out).not.toContain('a-different-shell-seed');
    expect(r.calls.every(([, seed]) => seed === 'unset')).toBe(true);
  });

  // why: F-1817 a reset that starts the world at epoch 1 below a hosted world at epoch N reads as stale to every open page and phone (no reset
  // notice, items flagged): the reset reads N before it changes anything and raises the new world, with its setup row, to N+1 before any service starts
  it('reads the old world epoch first and raises the new world to the epoch above it, before the services start', () => {
    const r = run('epoch', { epoch: 7 });
    expect(r.status, r.out).toBe(0);
    const cs = r.calls.map(([c]) => sub(c));
    const read = cs.findIndex((c) => /exec -T db psql .*greatest\(world_epoch, pbs_epoch\)/.test(c));
    const rm = cs.findIndex((c) => c.startsWith('compose stop '));
    const setup = cs.findIndex((c) => c.includes('-T setup'));
    const raise = cs.findIndex((c) => /exec -T db psql .*UPDATE system\.demo_clock SET world_epoch = 8, pbs_epoch = 7 WHERE id = 1; UPDATE system\.clock_move SET world_epoch = 8 WHERE world_epoch = 1 AND kind = 'reset'/.test(c));
    const start = cs.findIndex((c) => c.startsWith('compose up -d --no-build --wait --wait-timeout 180 web worker pbs'));
    expect(read).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(rm);
    expect(raise).toBeGreaterThan(setup);
    expect(raise).toBeLessThan(start);
    expect(r.out).toContain('the new world starts at epoch 8');
  });

  // why: F-1824 a re-run after a failed step 3 reads the new database (epoch 1) at step 0; the old world's epoch is kept, so it still lands at old+1
  it('keeps the old world epoch across a failed run, so the re-run lands at old + 1, and clears it when the reset ends OK', () => {
    const first = run('rerun', { epoch: 7, epochAfter: 1, migrateFail: true });
    expect(first.status).toBe(1);
    expect(first.out).toContain('FAILED at step 3');
    const second = run('rerun', { epoch: 1, epochAfter: 1 });
    expect(second.status, second.out).toBe(0);
    expect(second.out).toContain('the new world starts at epoch 8');
    expect(second.calls.map(([c]) => sub(c)).some((c) => /SET world_epoch = 8, pbs_epoch = 7/.test(c))).toBe(true);
    // Ended OK: the file is gone, so the next reset reads the live world again.
    const third = run('rerun', { epoch: 3, epochAfter: 1 });
    expect(third.out).toContain('the new world starts at epoch 4');
  });

  // why: F-1817 a world at epoch 1 (or none) needs no raise: setup's own epoch 1 is already above nothing, and the new world is not below the old
  it('leaves setup at epoch 1 when the old world was at epoch 0 or gave no answer', () => {
    for (const epoch of [0]) {
      const r = run(`epoch-${epoch}`, { epoch });
      expect(r.status, r.out).toBe(0);
      expect(r.calls.some(([c]) => c.includes('UPDATE system.demo_clock'))).toBe(false);
    }
    const none = run('epoch-none', { db: 'down' });
    expect(none.status, none.out).toBe(0);
    expect(none.calls.some(([c]) => c.includes('UPDATE system.demo_clock'))).toBe(false);
  });

  // why: F-1801 a settings file without the seed would bring back other sign-ins: the step stops at its checks, before it stops a service
  it('stops before any change when the settings file has no sample password seed', () => {
    const r = run('noseed', { envText: 'BW_IMAGE=bw-app:t\nROUTES=locked\n' });
    expect(r.status).toBe(2);
    expect(r.out).toContain('SAMPLE_PASSWORD_SEED');
    expect(r.out).toContain('nothing was changed');
    expect(r.calls.map(([c]) => sub(c)).filter((c) => /stop|rm|up |run /.test(c))).toEqual([]);
  });

  // why: F-1801 a setup that does not log setup done fails the step (exit 1), and the services are not started over a half-made world
  it('fails, naming the step, when setup does not finish, and starts no service after it', () => {
    const r = run('refused', { setup: 'refused' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('setup refused');
    expect(r.out).toContain('FAILED at step 4');
    expect(r.calls.map(([c]) => sub(c))).not.toContain('compose up -d --no-build --wait --wait-timeout 180 web worker pbs');
  });

  // why: F-1801 a re-run after a failed step finds the database volume already gone and goes on; 2 volumes for 1 project stop it
  it('goes on when the database volume is already gone, and stops on 2 database volumes', () => {
    const gone = run('gone', { vol: '', db: 'down' });
    expect(gone.status, gone.out).toBe(0);
    expect(gone.calls.map(([c]) => c).filter((c) => c.startsWith('volume rm'))).toEqual([]);
    const two = run('two', { vol: 'bw-t_pgdata\nbw-t_pgdata2' });
    expect(two.status).toBe(2);
    expect(two.calls.map(([c]) => sub(c)).filter((c) => /stop|rm|up |run /.test(c))).toEqual([]);
  });

  // why: F-1818 no labeled volume while the db answers a job count: a world is up that the script cannot name, so it changes nothing
  it('stops before any change when no volume is labeled but the database answers', () => {
    const r = run('unlabeled', { vol: '' });
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain('no database volume is labeled');
    expect(r.calls.map(([c]) => sub(c)).filter((c) => /stop|rm|up |run /.test(c))).toEqual([]);
  });
});
