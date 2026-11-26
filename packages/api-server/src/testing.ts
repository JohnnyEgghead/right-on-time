// SPDX-License-Identifier: AGPL-3.0-or-later
// Test kit for the kernel: a recording database, a memory session store with signed-in principals, a fixed clock and
// a capturing logger. Principals are real sessions resolved by the real resolveCaller (only the store is in memory).
import type { Queryable, QueryResultLike } from '@bw/db';
import { createLogger, type Logger } from '@bw/log';
import { FixedClock } from '@bw/time';
import { tokenChecks } from './handlers/index.ts';
import { issueAccessCookie } from './kernel/access-code.ts';
import { mount, type KernelDb, type KernelDeps, type Router } from './kernel/mount.ts';
import { MemorySessionStore, sessionCookie, startSession } from './kernel/sessions.ts';
import type { Handler, PolicyEntry, Role } from './types.ts';

export const ORIGIN = 'https://bw.j7l.io';
export const ACCESS_KEY = 'k'.repeat(43);
/**
 * The kit's pbs (F-643): no billing service. With PBS_URL unset the real billing handlers (API-65 to API-67) fetched the production
 * default http://pbs:8090, and each call cost the host's lookup of the name "pbs": 10 ms on an idle Mac, 5 s on the Mac with 2 lookups in
 * flight, 3.9 s on Spectre's Docker bridge (the wave container), up to the 5 s pbs call timeout. G-CI7's API matrix makes 24 such calls a
 * pass, so it hit the 60 s test limit. Port 9 is a fetch "bad port": fetch refuses it at once with no lookup and no socket, so a handler
 * that reaches pbs gets "billing unavailable" in under 1 ms on every host. A test that needs a pbs passes its own PBS_URL.
 */
export const NO_PBS_URL = 'http://127.0.0.1:9';

class RecordingDb implements KernelDb {
  readonly log: string[] = [];
  fail = false;
  /** The worker's last beat as the health check reads it (null: no row yet); the kit's real clock is 2026-11-01T12:00:00Z. */
  heartbeat: Date | null = new Date('2026-11-01T11:59:55Z');
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    this.log.push('BEGIN');
    const tx: Queryable = {
      query: async <R>(text: string): Promise<QueryResultLike<R>> => {
        if (this.fail) throw new Error('database down');
        this.log.push(text);
        if (text.includes('system.worker_heartbeat')) {
          return { rows: (this.heartbeat ? [{ beat_real: this.heartbeat }] : []) as R[], rowCount: this.heartbeat ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    try {
      const out = await fn(tx);
      this.log.push('COMMIT');
      return out;
    } catch (e) {
      this.log.push('ROLLBACK');
      throw e;
    }
  }
}

export interface Kit {
  router: Router;
  db: RecordingDb;
  clock: FixedClock;
  sessions: MemorySessionStore;
  lines: Record<string, unknown>[];
  log: Logger;
  deps: KernelDeps;
  /** A signed-in principal of a role: its cookie header (web) and bearer token (native session). */
  signIn(role: Role, opts?: { via?: 'password' | 'sign_in_as'; client?: 'web' | 'native'; keep?: boolean; status?: string }): Promise<{ userId: string; token: string; cookie: string }>;
  accessCookie(): string;
  call(method: string, path: string, init?: { headers?: Record<string, string>; body?: unknown }): Promise<Response>;
}

let users = 0;

export function kit(
  table: readonly PolicyEntry[], handlers: Record<string, Handler<unknown>>, settings: Partial<KernelDeps['settings']> = {}, tokens: KernelDeps['tokens'] = tokenChecks,
  extra: Pick<KernelDeps, 'events'> = {},
): Kit {
  const db = new RecordingDb();
  const clock = new FixedClock({ demo: '2026-09-15T14:28:00Z', real: '2026-11-01T12:00:00Z', worldEpoch: 3 });
  const sessions = new MemorySessionStore();
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ process: 'web', clock, level: 'debug', write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) });
  const deps: KernelDeps = {
    db, sessions, clock, log, accessKey: ACCESS_KEY, tokens, ...extra,
    settings: { APP_ORIGIN: ORIGIN, DEMO_MODE: false, ACCESS_CODE_ON: false, PBS_URL: NO_PBS_URL, ...settings },
  };
  const router = mount(table, handlers, deps);
  return {
    router, db, clock, sessions, lines, log, deps,
    async signIn(role, opts = {}) {
      const userId = `0192f000-0000-7000-8000-${String(++users).padStart(12, '0')}`;
      sessions.users.set(userId, { role, status: opts.status ?? 'active' });
      const token = await startSession(sessions, clock, { userId, role }, { client: opts.client ?? 'web', via: opts.via ?? 'password', keepSignedIn: opts.keep ?? false });
      return { userId, token, cookie: sessionCookie(token, false, true).split(';')[0]! };
    },
    accessCookie: () => issueAccessCookie(ACCESS_KEY, clock, true).split(';')[0]!,
    call(method, path, init = {}) {
      const headers: Record<string, string> = { ...init.headers };
      let body: string | undefined;
      if (init.body !== undefined) {
        body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
        headers['content-type'] ??= 'application/json';
      }
      return router.handle(new Request(`http://web:3000${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }), { address: '203.0.113.7' });
    },
  };
}
