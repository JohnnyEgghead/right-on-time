// SPDX-License-Identifier: AGPL-3.0-or-later
// Stack settings check (F-134, F-126): a running Compose project of infra/compose.yaml is at its default settings
// (BUILD_PLAN line 141, "the Compose stack at its default settings"). Shared by every stack gate, on the Mac and in the
// wave run's own engine.
//   node ci/wave/stack-settings.ts <project>
// The expected values come from the Compose file itself: each service's environment entry ${KEY:-default} expects
// KEY=default, and a literal entry expects that literal. The actual values are each running container's environment
// (docker inspect). Exit 0: every value of every service matches. Exit 1: a mismatch, a missing service or a value
// form this check cannot judge (each printed). Exit 2: usage.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isMain } from '../is-main.ts';
import { parse } from 'yaml';

export const STACK_SERVICES = ['db', 'pbs', 'proxy', 'web', 'worker'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Expected environment per service, from the Compose file text. `null` marks a value this check cannot judge. */
export function expectedEnv(composeText: string): Record<string, Record<string, string | null>> {
  const doc: unknown = parse(composeText, { merge: true });
  const services = isObj(doc) && isObj(doc.services) ? doc.services : {};
  const out: Record<string, Record<string, string | null>> = {};
  for (const name of STACK_SERVICES) {
    const svc = services[name];
    const env = isObj(svc) && isObj(svc.environment) ? svc.environment : {};
    const want: Record<string, string | null> = {};
    for (const [k, raw] of Object.entries(env)) {
      const v = String(raw);
      const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}$/.exec(v);
      if (m && m[1] === k) want[k] = m[2] ?? '';
      else if (!v.includes('$')) want[k] = v;
      else want[k] = null;
    }
    out[name] = want;
  }
  return out;
}

/** Problems: each service's actual `KEY=value` list (null = no running container) against the expected values. */
export function envProblems(
  expected: Record<string, Record<string, string | null>>,
  actual: Record<string, string[] | null>,
): string[] {
  const problems: string[] = [];
  for (const [svc, want] of Object.entries(expected)) {
    const list = actual[svc];
    if (!list) {
      problems.push(`${svc}: no running container`);
      continue;
    }
    const got = new Map(list.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)] as const));
    for (const [k, v] of Object.entries(want)) {
      if (v === null) problems.push(`${svc}: ${k} has a value form this check cannot judge`);
      else if (!got.has(k)) problems.push(`${svc}: ${k} is not set (default ${JSON.stringify(v)})`);
      else if (v === '*') {
        if (got.get(k) === '') problems.push(`${svc}: ${k} is empty, a value was set for this suite`);
      } else if (got.get(k) !== v) problems.push(`${svc}: ${k}=${JSON.stringify(got.get(k))}, default ${JSON.stringify(v)}`);
    }
  }
  return problems;
}

/**
 * A suite that runs the stack with a few settings on (the P2-AUTH stack: ACCESS_CODE_ON, DEMO_MODE and the secrets) names them
 * as KEY=value arguments; every service that has the key then expects that value, and every other value stays at its default.
 * A secret is named KEY=* : any non-empty value matches, and the value is never printed.
 */
export function applyOverrides(expected: Record<string, Record<string, string | null>>, overrides: Record<string, string>): Record<string, Record<string, string | null>> {
  const out: Record<string, Record<string, string | null>> = {};
  for (const [svc, want] of Object.entries(expected)) {
    out[svc] = Object.fromEntries(Object.entries(want).map(([k, v]) => [k, Object.hasOwn(overrides, k) ? overrides[k]! : v]));
  }
  return out;
}

function docker(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
  return { status: r.status, stdout: r.stdout ?? '' };
}

function main(argv: string[]): number {
  const project = argv[0];
  const overrides: Record<string, string> = {};
  for (const a of argv.slice(1)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(a);
    if (!m) {
      console.error('usage: node ci/wave/stack-settings.ts <compose project> [KEY=value | KEY=* ...]');
      return 2;
    }
    overrides[m[1]!] = m[2]!;
  }
  if (!project) {
    console.error('usage: node ci/wave/stack-settings.ts <compose project> [KEY=value | KEY=* ...]');
    return 2;
  }
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const file = path.join(root, 'infra', 'compose.yaml');
  const expected = applyOverrides(expectedEnv(readFileSync(file, 'utf8')), overrides);
  const actual: Record<string, string[] | null> = {};
  for (const svc of STACK_SERVICES) {
    const ps = docker(['compose', '-p', project, '-f', file, 'ps', '-q', '--status', 'running', svc]);
    const id = ps.status === 0 ? ps.stdout.trim().split('\n')[0] : '';
    if (!id) {
      actual[svc] = null;
      continue;
    }
    const ins = docker(['inspect', '--format', '{{json .Config.Env}}', id]);
    actual[svc] = ins.status === 0 ? (JSON.parse(ins.stdout) as string[]) : null;
  }
  const problems = envProblems(expected, actual);
  const n = Object.values(expected).reduce((a, w) => a + Object.keys(w).length, 0);
  for (const p of problems) console.log(`stack-settings: ${p}`);
  console.log(`stack-settings: project ${project}, ${n} values on ${STACK_SERVICES.length} services, ${problems.length} problem(s)`);
  return problems.length === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
