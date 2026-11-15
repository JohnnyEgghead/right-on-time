// SPDX-License-Identifier: AGPL-3.0-or-later
// Test world for the office writes: the migrated schema, P2-SEED's real reference seed (branches, the bundled street
// list, services, staff and technician users, technicians, windows, the Columbus peak days, the clock row), plus
// customers the fixture adds, the production kernel as the web process's login bw_web, and sessions the real session
// layer creates. Used by office-writes.db.test.ts and gate G-CI3's barrier tests.
import { loadConfig } from '@bw/config';
import { BUS_CHANNEL, createClient, createPool, type Queryable } from '@bw/db';
import { createLogger } from '@bw/log';
import { realNow, type RealTimeUse } from '@bw/time';
import type { MigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { seedReference } from '../../../import/src/testing/world.ts';
import { sessionCookie, SqlSessionStore, startSession } from '../kernel/sessions.ts';
import { createWebKernel, type WebKernel } from '../web.ts';

export const ORIGIN = 'http://localhost:8080'; // APP_ORIGIN's default (section 11.1)

export const loginUrl = (url: string, login: string): string => {
  const u = new URL(url);
  u.username = login;
  return u.toString();
};

export interface Staff {
  userId: string;
  name: string;
  cookie: string;
}

export interface OfficeWorld {
  kernel: WebKernel;
  /** A pool as bw_web: the access wall the web process's writes hit. */
  web: ReturnType<typeof createPool>;
  /** 2 dispatchers (office: Keisha Thompson, Ana Gutierrez) and a manager (Dana Ruiz), each with a real session. */
  staff: { keisha: Staff; ana: Staff; dana: Staff };
  technicians: Map<string, string>;
  windows: Map<string, string>;
  customers: string[];
  close(): Promise<void>;
}

/** Build the world on a migrated database: the reference seed, `customers` Columbus customers, the kernel and 3 sessions. */
export async function officeWorld(db: MigratedDatabase, customers = 40): Promise<OfficeWorld> {
  const a = db.admin();
  await seedReference(a);
  const ids = await addCustomers(a, 'columbus', customers);
  const kernel = createWebKernel({ settings: loadConfig({ DATABASE_URL: loginUrl(db.url(), 'bw_web'), ACCESS_CODE_ON: 'off' }), log: createLogger({ process: 'web', write: () => undefined }) });
  const web = createPool({ connectionString: loginUrl(db.url(), 'bw_web'), max: 8 });
  const store = new SqlSessionStore(web);
  const clock = { realNow: (use: RealTimeUse) => (use === 'session_idle' ? realNow('session_idle') : realNow('session_lifetime')) };
  const person = async (sql: string): Promise<Staff> => {
    const r = await a.query<{ id: string; name: string; role: 'office' | 'manager' }>(sql);
    const u = r.rows[0];
    if (!u) throw new Error(`the reference seed has no user for: ${sql}`);
    const token = await startSession(store, clock, { userId: u.id, role: u.role }, { client: 'web', via: 'password', keepSignedIn: false });
    return { userId: u.id, name: u.name, cookie: sessionCookie(token, false, false).split(';')[0] as string };
  };
  const byEmail = (email: string) => `SELECT id, name, role FROM world."user" WHERE email = '${email}'`;
  const staff = {
    keisha: await person(byEmail('keisha.t@brightwater.example')),
    ana: await person(byEmail('ana.gutierrez@brightwater.example')),
    dana: await person(byEmail('dana.ruiz@brightwater.example')),
  };
  const t = await a.query<{ id: string; name: string }>(`SELECT id, name FROM world.technician WHERE branch_id = 'columbus'`);
  const w = await a.query<{ id: string; key: string }>(
    `SELECT id, mode || ' ' || to_char(start_local, 'HH24:MI') AS key FROM world.arrival_window WHERE branch_id = 'columbus'`);
  return {
    kernel, web, staff, customers: ids,
    technicians: new Map(t.rows.map((x) => [x.name, x.id])),
    windows: new Map(w.rows.map((x) => [x.key, x.id])),
    async close() {
      await kernel.close();
      await web.end();
    },
  };
}

/** n active customers of a branch on its streets, each at its own point near the depot (fixture rows: no phone, no texts). */
export async function addCustomers(a: Queryable, branch: string, n: number): Promise<string[]> {
  const r = await a.query<{ id: string }>(
    `INSERT INTO world.customer (branch_id, name, name_search, texts_on, text_language, zone, street_id, house_number, lon, lat,
                                 customer_since, source, status, inbox_token)
     SELECT $1, 'Fixture Customer ' || g, 'fixture customer ' || g, false, 'en', b.zone, s.id, 100 + g,
            b.depot_lon + (g % 7) * 0.01, b.depot_lat + (g % 5) * 0.01, DATE '2020-01-01', 'office', 'active', 'fixture-inbox-' || $1 || '-' || g
       FROM generate_series(1, $2::int) AS g
       JOIN world.branch b ON b.id = $1
       CROSS JOIN LATERAL (SELECT id FROM world.street WHERE branch_id = $1 ORDER BY id OFFSET g % 20 LIMIT 1) s
     RETURNING id`, [branch, n]);
  return r.rows.map((x) => x.id);
}

export interface Caller {
  get(path: string, who: Staff): Promise<Response>;
  post(path: string, body: unknown, who: Staff): Promise<Response>;
  del(path: string, who: Staff): Promise<Response>;
  patch(path: string, body: unknown, who: Staff): Promise<Response>;
}

export function caller(kernel: WebKernel): Caller {
  const send = (method: string, path: string, who: Staff, body?: unknown) => kernel.router.handle(new Request(`http://web:3000/api/v1${path}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), origin: ORIGIN, cookie: who.cookie },
  }), { address: '203.0.113.9' });
  return {
    get: (p, who) => send('GET', p, who),
    post: (p, body, who) => send('POST', p, who, body),
    del: (p, who) => send('DELETE', p, who),
    patch: (p, body, who) => send('PATCH', p, who, body),
  };
}

/** A LISTEN connection on the bus channel that collects every notice in order (the publish half's real receiver). */
export async function listen(url: string): Promise<{ notices: { name: string; ids: Record<string, unknown> }[]; waitFor(n: number): Promise<number>; end(): Promise<void> }> {
  const c = createClient({ connectionString: url });
  await c.connect();
  const notices: { name: string; ids: Record<string, unknown> }[] = [];
  c.on('notification', (m) => {
    if (m.channel === BUS_CHANNEL) notices.push(JSON.parse(m.payload ?? '{}') as { name: string; ids: Record<string, unknown> });
  });
  await c.query(`LISTEN ${BUS_CHANNEL}`);
  return {
    notices,
    // A notice reaches the listener just after its commit; give it up to 2 s, then report how many arrived.
    async waitFor(n) {
      for (let i = 0; i < 100 && notices.length < n; i++) await new Promise((r) => setTimeout(r, 20));
      return notices.length;
    },
    end: () => c.end(),
  };
}
