// SPDX-License-Identifier: AGPL-3.0-or-later
// Teardown check for a stack gate killed the way ci/run-gates.ts kills it at its cap (F-132): SIGKILL to the gate's
// whole process group while its Compose stack is up. Needs docker; run by hand (it is not a gate):
//   node ci/wave/stack-teardown-check.ts               the kill; PASS when nothing of the project is left
//   node ci/wave/stack-teardown-check.ts --known-bad   also SIGKILL the reaper; PASS when the leftovers ARE seen
//                                                      (the check is not vacuous), then it removes them itself
// Also checks the gate built its own image tag (<project>:local) and left the shared bw-app:local untouched.
// Only its own project (bw-contract-tdcheck-<time>) is ever touched.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const knownBad = process.argv.includes('--known-bad');
const project = `bw-contract-tdcheck-${Date.now()}`;
const image = `${project}:local`;
const label = `label=com.docker.compose.project=${project}`;
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (...args: string[]) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
  return { status: r.status, out: (r.stdout ?? '').trim() };
};
const imageId = (ref: string) => {
  const r = docker('image', 'inspect', '--format', '{{.Id}}', ref);
  return r.status === 0 ? r.out : null;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const runningServices = () =>
  new Set(docker('ps', '--filter', label, '--filter', 'status=running', '--format', '{{.Label "com.docker.compose.service"}}').out.split('\n').filter(Boolean));
function leftovers(tmp: string, reaper: number): string[] {
  const left: string[] = [];
  const c = docker('ps', '-aq', '--filter', label).out;
  const v = docker('volume', 'ls', '-q', '--filter', label).out;
  const n = docker('network', 'ls', '-q', '--filter', label).out;
  if (c) left.push(`containers: ${c.split('\n').length}`);
  if (v) left.push(`volumes: ${v.split('\n').join(' ')}`);
  if (n) left.push(`networks: ${n.split('\n').length}`);
  if (imageId(image)) left.push(`image ${image}`);
  if (tmp && existsSync(tmp)) left.push(`temp dir ${tmp} (holds the throwaway db password file)`);
  if (reaper && alive(reaper)) left.push(`reaper pid ${reaper} still running`);
  return left;
}

async function main(): Promise<number> {
  const sharedBefore = imageId('bw-app:local');
  log(`project ${project}; shared bw-app:local before: ${sharedBefore ?? 'absent'}`);
  const gate = spawn('bash', ['ci/gates/contract-gates.sh'], {
    detached: true, // its own process group, as ci/run-gates.ts runs a gate
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BW_CONTRACT_PROJECT: project, BW_CONTRACT_BASE_URL: '' },
  });
  let out = '';
  gate.stdout.on('data', (d: Buffer) => (out += d.toString()));
  gate.stderr.on('data', (d: Buffer) => (out += d.toString()));
  let exited = false;
  gate.on('exit', () => (exited = true));

  const want = ['db', 'pbs', 'proxy', 'web', 'worker'];
  while (!want.every((s) => runningServices().has(s))) {
    if (exited) {
      log(`INCONCLUSIVE: the gate exited before its stack was seen up:\n${out.slice(-1500)}`);
      return 2;
    }
    if (Date.now() - t0 > 300_000) {
      process.kill(-(gate.pid as number), 'SIGKILL');
      log('INCONCLUSIVE: the stack did not come up in 300 s');
      return 2;
    }
    await sleep(500);
  }
  const m = /temp dir (\S+), reaper pid (\d+)/.exec(out);
  const tmp = m?.[1] ?? '';
  const reaper = Number(m?.[2] ?? 0);
  const ownImage = imageId(image);
  const sharedDuring = imageId('bw-app:local');
  log(`stack up: ${[...runningServices()].sort().join(' ')}; own image ${image}: ${ownImage ? 'present' : 'ABSENT'}; temp dir ${tmp}; reaper ${reaper}`);

  process.kill(-(gate.pid as number), 'SIGKILL');
  log(`SIGKILL sent to the gate's process group ${gate.pid}`);
  while (alive(-(gate.pid as number))) await sleep(200);
  log('gate process group gone');
  if (knownBad) {
    if (reaper) process.kill(reaper, 'SIGKILL');
    log(`known-bad: reaper ${reaper} SIGKILLed too; waiting 20 s`);
    await sleep(20_000);
    const left = leftovers(tmp, 0);
    log(`known-bad leftovers: ${left.join('; ') || 'none'}`);
    spawnSync('bash', ['ci/gates/contract-gates.sh', '--reap', String(gate.pid), project, image, tmp], { stdio: 'inherit' });
    const after = leftovers(tmp, 0);
    log(`after removing them: ${after.join('; ') || 'none'}`);
    const ok = left.some((l) => l.startsWith('containers')) && after.length === 0;
    log(ok ? 'PASS (known-bad): without the reaper the kill leaves the stack, and the check sees it' : 'FAIL (known-bad)');
    return ok ? 0 : 1;
  }
  let left: string[] = [];
  for (let i = 0; i < 240; i++) {
    left = leftovers(tmp, reaper);
    if (left.length === 0) break;
    await sleep(500);
  }
  const sharedAfter = imageId('bw-app:local');
  log(`after teardown: ${left.join('; ') || 'nothing left (containers, volumes, networks, own image, temp dir, reaper)'}`);
  log(`shared bw-app:local before/during/after: ${sharedBefore ?? 'absent'} / ${sharedDuring ?? 'absent'} / ${sharedAfter ?? 'absent'}`);
  const ok = left.length === 0 && Boolean(ownImage) && Boolean(tmp) && reaper > 0 && sharedBefore === sharedDuring && sharedDuring === sharedAfter;
  log(ok ? 'PASS: the killed gate left nothing, and it never touched the shared image tag' : 'FAIL');
  return ok ? 0 : 1;
}

main().then((rc) => process.exit(rc));
