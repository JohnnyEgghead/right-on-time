// SPDX-License-Identifier: AGPL-3.0-or-later
// The live map stack suite's count of API-116 calls (F-1269, F-1420). API-116 (live map data, a link-token route) allows 60 calls a minute per
// address (SPECIFICATIONS 7.1), counted in a sliding window (packages/api-server/src/kernel/rate-limit.ts), and every load of a live map page reads
// it on the server under the visitor's address too (apps/web/app/m/[liveMapToken]/page.tsx, F-1160). The web process logs every answer with its
// contract, its real time and how long it took (packages/api-server/src/kernel/mount.ts), and the suite's calls all come from 1 address, so the web
// container's log is the limiter's own count for it. ci/livemap-stack/livemap.stack.ts paces its cases with it, and ci/livemap-stack.sh prints a
// run's busiest window after the suite:
//   node ci/livemap-stack/api116.ts <web container>
import { spawnSync } from 'node:child_process';
import { isMain } from '../is-main.ts';

export const LIMIT = 60;
export const WINDOW_MS = 60_000;
const CONTRACT = 'API-116';

export interface WebLog {
  /** When the limiter counted each API-116 call (the answer's stamp less its duration), in the web process's real time, oldest first. */
  hits: number[];
  /** The newest stamp of any line: the web process's time when its last line was written. */
  newest: number;
}

/** The API-116 calls in the lines of a web process's log. Lines that are not JSON log lines are skipped. */
export function parseWebLog(text: string): WebLog {
  const hits: number[] = [];
  let newest = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let x: { contract?: unknown; realTime?: unknown; durationMs?: unknown };
    try {
      x = JSON.parse(line) as typeof x;
    } catch {
      continue;
    }
    const at = typeof x.realTime === 'string' ? Date.parse(x.realTime) : Number.NaN;
    if (!Number.isFinite(at)) continue;
    newest = Math.max(newest, at);
    if (x.contract === CONTRACT) hits.push(at - (typeof x.durationMs === 'number' ? x.durationMs : 0));
  }
  hits.sort((a, b) => a - b);
  return { hits, newest };
}

/** A web container's whole log (stdout and stderr), read with docker. */
export function readWebLog(container: string): WebLog {
  const r = spawnSync('docker', ['logs', container], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`docker logs ${container} failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return parseWebLog(`${r.stdout}\n${r.stderr}`);
}

/** The most calls inside any WINDOW_MS, as the limiter counts them (a call counts while less than WINDOW_MS old). */
export function busiest(hits: readonly number[]): number {
  let best = 0;
  for (let i = 0, j = 0; i < hits.length; i++) {
    while (hits[j]! <= hits[i]! - WINDOW_MS) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

/**
 * How long from `now` until the last WINDOW_MS hold at most LIMIT - room calls, so that a case making at most `room` calls cannot take any
 * window past LIMIT; 0 when they already do. Every time is in the web process's clock, and the answer is a duration.
 */
export function waitFor(hits: readonly number[], now: number, room: number): number {
  const recent = hits.filter((t) => now - t < WINDOW_MS);
  const over = recent.length - (LIMIT - room);
  return over <= 0 ? 0 : recent[over - 1]! + WINDOW_MS - now;
}

if (isMain(import.meta.url)) {
  const container = process.argv[2];
  if (!container) {
    console.error('usage: node ci/livemap-stack/api116.ts <web container>');
    process.exit(2);
  }
  const { hits } = readWebLog(container);
  console.log(`livemap-stack: API-116 calls ${hits.length}, busiest ${WINDOW_MS / 1000} s window ${busiest(hits)} of ${LIMIT} (the link-token limit per address)`);
}
