// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1650: the F-1592 rig, runnable. It measures the proxy's 502 window after the web container moves to a new address, on this
// machine's local Docker only (nothing hosted, no network beyond the pulled images).
//
// The rig: the nginx files of this checkout's infra/nginx (the working tree, so an edited http.conf is what runs) in the pinned nginx
// image of infra/compose.yaml; a node stand-in web on a fixed subnet; the proxy's DNS forwarded to 192.0.2.1 (TEST-NET, unreachable),
// so a lookup of a stopped web fails rather than answering NXDOMAIN. Web stops, a holder container takes its freed address, 6 s of
// failing lookups pass, and web starts on a new address. The window is the time from that start to the proxy's first /healthz 200,
// polled every 0.1 s, capped at 60 s.
//
// Arms: "fixed" runs http.conf as it is; "bad" runs it with the 1 line "resolver_timeout 3s;" removed (F-1592's known-bad).
//
//   node infra/tests/f1592-window.ts [--arm fixed|bad|both] [--runs N]
//
// Prints 1 JSON line per arm run, then "VERDICT PASS" or "VERDICT FAIL". Exit 0 only when every fixed run's window is under 10 s and
// every bad run's window is 20 s or more (or no 200 in 60 s). Exit 1 on a FAIL, 2 on a usage or Docker error.
// Images: node:26.12.1-bookworm-slim, alpine:3.22, and the compose.yaml nginx image. Every container and the network carry the
// label bw-f1592 and are removed at the end of each arm, pass or fail.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const RESOLVER_TIMEOUT_LINE = 'resolver_timeout 3s;\n';
export const FIXED_UNDER_S = 10;
export const BAD_AT_LEAST_S = 20;
const CAP_S = 60;
const LABEL = 'bw-f1592';
const NET = `${LABEL}-net`;
const NODE = 'node:26.12.1-bookworm-slim';
const HOLDER = 'alpine:3.22';

/** http.conf for the "bad" arm: the resolver_timeout line removed. Throws unless the line is there exactly once. */
export function badArm(conf: string): string {
  const count = conf.split(RESOLVER_TIMEOUT_LINE).length - 1;
  if (count !== 1) throw new Error(`http.conf holds "${RESOLVER_TIMEOUT_LINE.trim()}" ${count} times, not once`);
  return conf.replace(RESOLVER_TIMEOUT_LINE, '');
}

export interface ArmRun { arm: 'fixed' | 'bad'; run: number; moved: boolean; window_s: number | null; non200: number }

/** PASS when every fixed window is under FIXED_UNDER_S and every bad window is BAD_AT_LEAST_S or more (null: no 200 within the cap). */
export function verdict(runs: ArmRun[]): boolean {
  return runs.length > 0 && runs.every((r) => {
    if (!r.moved) return false; // web kept its address: the run measured nothing
    if (r.arm === 'fixed') return r.window_s !== null && r.window_s < FIXED_UNDER_S;
    return r.window_s === null || r.window_s >= BAD_AT_LEAST_S;
  });
}

function docker(args: string[], check = true): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (check && r.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')}: ${(r.stderr || '').trim()}`);
  return (r.stdout || '').trim();
}

function cleanup(): void {
  const ids = docker(['ps', '-aq', '--filter', `label=${LABEL}`], false).split(/\s+/).filter(Boolean);
  if (ids.length) docker(['rm', '-fv', ...ids], false);
  docker(['network', 'rm', NET], false);
}

async function code(url: string): Promise<number> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    await r.arrayBuffer();
    return r.status;
  } catch {
    return 0;
  }
}

function address(name: string): string {
  const info = JSON.parse(docker(['inspect', name])) as { NetworkSettings: { Networks: Record<string, { IPAddress: string }> } }[];
  return info[0]!.NetworkSettings.Networks[NET]!.IPAddress;
}

async function arm(kind: 'fixed' | 'bad', run: number, nginxDir: string, nginxImage: string): Promise<ArmRun> {
  const src = mkdtempSync(path.join(tmpdir(), 'bw-f1592-'));
  try {
    cpSync(nginxDir, src, { recursive: true });
    if (kind === 'bad') writeFileSync(path.join(src, 'http.conf'), badArm(readFileSync(path.join(src, 'http.conf'), 'utf8')));
    cleanup();
    docker(['network', 'create', '--label', LABEL, '--subnet', '10.159.92.0/24', NET]);
    const web = `${LABEL}-web`;
    docker(['run', '-d', '--label', LABEL, '--name', web, '--network', NET, '--network-alias', 'web', NODE, 'node', '-e',
      "require('http').createServer((q,s)=>s.end('ok')).listen(3000)"]);
    const px = `${LABEL}-proxy`;
    docker(['create', '--label', LABEL, '--name', px, '--network', NET, '--dns', '192.0.2.1', '-p', '127.0.0.1::80', nginxImage, '/bin/sh', '-c',
      'ln -sf /etc/nginx/bw/local.conf /etc/nginx/conf.d/default.conf && ln -sf /etc/nginx/bw/routes-open.conf /etc/nginx/bw-routes.conf && exec nginx -g "daemon off;"']);
    docker(['cp', `${src}/.`, `${px}:/etc/nginx/bw`]);
    docker(['start', px]);
    const port = docker(['port', px, '80/tcp']).split('\n')[0]!.split(':').at(-1)!;
    const url = `http://127.0.0.1:${port}/healthz`;
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      up = (await code(url)) === 200;
      if (!up) await sleep(200);
    }
    if (!up) throw new Error(`the proxy never answered 200 at the start: ${docker(['logs', px], false)}`);
    const before = address(web);
    docker(['stop', '-t', '0', web]);
    docker(['run', '-d', '--label', LABEL, '--network', NET, HOLDER, 'sleep', '600']); // takes web's freed address
    const stopped = Date.now();
    while (Date.now() - stopped < 6000) { // nginx re-resolves every 2 s (valid=2s): each lookup now fails
      await code(url);
      await sleep(500);
    }
    docker(['start', web]);
    const t0 = Date.now();
    const after = address(web);
    let non200 = 0;
    let window: number | null = null;
    while (Date.now() - t0 < CAP_S * 1000) {
      if ((await code(url)) === 200) { window = Math.round((Date.now() - t0) / 10) / 100; break; }
      non200++;
      await sleep(100);
    }
    return { arm: kind, run, moved: before !== after, window_s: window, non200 };
  } finally {
    cleanup();
    rmSync(src, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let which = 'both';
  let runs = 1;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--arm' && ['fixed', 'bad', 'both'].includes(args[i + 1] ?? '')) which = args[++i]!;
    else if (args[i] === '--runs' && /^[1-9][0-9]?$/.test(args[i + 1] ?? '')) runs = Number(args[++i]);
    else { console.error('usage: node infra/tests/f1592-window.ts [--arm fixed|bad|both] [--runs N]'); return 2; }
  }
  const root = path.resolve(import.meta.dirname, '../..');
  const image = /^\s*image: (nginx:\S+)\s*$/m.exec(readFileSync(path.join(root, 'infra/compose.yaml'), 'utf8'))?.[1];
  if (!image) { console.error('no nginx image in infra/compose.yaml'); return 2; }
  const arms = (which === 'both' ? ['fixed', 'bad'] : [which]) as ('fixed' | 'bad')[];
  const out: ArmRun[] = [];
  try {
    for (let run = 1; run <= runs; run++) {
      for (const k of arms) {
        const r = await arm(k, run, path.join(root, 'infra/nginx'), image);
        console.log(JSON.stringify(r));
        out.push(r);
      }
    }
  } catch (e) {
    console.error(`docker error: ${(e as Error).message}`);
    return 2;
  }
  const pass = verdict(out);
  console.log(`VERDICT ${pass ? 'PASS' : 'FAIL'} (fixed under ${FIXED_UNDER_S} s, bad ${BAD_AT_LEAST_S} s or more)`);
  return pass ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
