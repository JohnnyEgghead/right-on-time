// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1341: the load-day copy's routing step serves routing at the .env's ROUTING_MEM_LIMIT (320m, D-21) unless the caller gives a cap.
// temp-server.sh runs for real here with an ssh stub on PATH that records what it is sent; no server, no cloud call.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '../..');
const script = path.join(root, 'infra/load/temp-server.sh');
let work: string;

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'bw-temp-server-'));
  writeFileSync(path.join(work, 'ip'), '192.0.2.1');
  writeFileSync(path.join(work, 'key.pem'), 'x');
  // ssh stub: the last argument is the remote command; one that writes cap.yaml gets its stdin saved, and every command is logged.
  const stub = path.join(work, 'ssh');
  writeFileSync(stub, '#!/bin/sh\nfor a; do last="$a"; done\nprintf "%s\\n" "$last" >> "$BW_STUB_LOG"\ncase "$last" in "cat > "*infra/cap.yaml) cat > "$BW_STUB_CAP" ;; *) cat > /dev/null ;; esac\n');
  chmodSync(stub, 0o755);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

function routing(...args: string[]) {
  const cap = path.join(work, `cap-${args.join('-') || 'none'}.yaml`);
  const log = path.join(work, `log-${args.join('-') || 'none'}.txt`);
  const r = spawnSync('bash', [script, 'routing', ...args], {
    env: { ...process.env, PATH: `${work}:${process.env.PATH}`, BW_LOAD_DIR: work, BW_STUB_CAP: cap, BW_STUB_LOG: log },
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr, cap, log };
}

// What the routing container runs at: cap.yaml's mem_limit when it has one, else the .env the install step writes (compose.yaml reads it).
function effectiveLimit(capFile: string): string {
  const cap = parse(readFileSync(capFile, 'utf8')) as { services: { routing: { mem_limit?: string } } };
  const env = /echo 'ROUTING_MEM_LIMIT=(\d+m)'/.exec(readFileSync(script, 'utf8'))![1]!;
  return cap.services.routing.mem_limit ?? env;
}

describe('temp-server.sh routing step', () => {
  it('serves routing at the 320m of the .env when no cap is given, and starts the routing service', () => {
    const r = routing('mmap');
    expect(r.status, r.stderr).toBe(0);
    expect(effectiveLimit(r.cap)).toBe('320m');
    expect(readFileSync(r.log, 'utf8')).toMatch(/up -d --no-build --force-recreate routing/);
  });

  it('serves routing at the cap the caller gives, and at 8g only when asked for uncapped', () => {
    expect(effectiveLimit(routing('load', '600m').cap)).toBe('600m');
    expect(effectiveLimit(routing('mmap', 'uncapped').cap)).toBe('8g');
  });

  it('refuses a cap that is not <n>m, <n>g or uncapped', () => {
    expect(routing('mmap', 'lots').status).toBe(2);
  });

  it('keeps the measuring script uncapped by name, so its runs are the 8g runs they were', () => {
    expect(readFileSync(path.join(root, 'infra/load/routing-memory-server.sh'), 'utf8')).toContain('"${BW_ROUTING_CAP:-uncapped}"');
  });
});
