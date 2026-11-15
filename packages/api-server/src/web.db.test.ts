// SPDX-License-Identifier: AGPL-3.0-or-later
// The kernel on the real database (PostgreSQL 18, the migrated schema) as the web process's own login bw_web
// (migration 0008, F-150): the SQL session store over system.session and world."user", the process logins and their
// privileges at the real access wall, and the production kernel serving the health check. Run by gate G-CI7
// (ci/gates/G-CI7/vitest.db.config.ts); the merge set excludes *.db.test.ts.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineContract, z } from '@bw/api';
import { loadConfig } from '@bw/config';
import { createPool, inTransaction, provisionLogins } from '@bw/db';
import { createLogger } from '@bw/log';
import { DbClock, Temporal } from '@bw/time';
import { attempt, useMigratedDatabase } from '../../db/src/testing/fixture.ts';
import { mount } from './kernel/mount.ts';
import { sessionCookie, SqlSessionStore, startSession } from './kernel/sessions.ts';
import { api, MANAGER } from './policy/entry.ts';
import { createWebKernel } from './web.ts';

const db = useMigratedDatabase();
const asLogin = (url: string, user: string) => {
  const u = new URL(url);
  u.username = user;
  return u.toString();
};
const lines: string[] = [];
const log = createLogger({ process: 'web', clock: { realNow: () => Temporal.Instant.from('2026-11-01T12:00:00Z') }, write: (l) => lines.push(l) });

let userIds: Record<string, string> = {};
beforeAll(async () => {
  const a = db.admin();
  await a.query(`INSERT INTO world.branch (id, name_key, zone, office_phone, depot_lon, depot_lat, map_file)
                 VALUES ('columbus', 'branch.columbus', 'America/New_York', '(614) 555-0100', -83.0, 39.96, 'columbus.pmtiles')`);
  for (const [email, role, status] of [['dana@example.test', 'manager', 'active'], ['maria@example.test', 'technician', 'active'], ['off@example.test', 'manager', 'turned_off']]) {
    const r = await a.query<{ id: string }>(`INSERT INTO world."user" (email, name, name_search, role, branch_id, language, status, sample, reviewer)
                 VALUES ($1, 'Test User', 'test user', $2, 'columbus', 'en', $3, true, false) RETURNING id`, [email, role, status]);
    userIds = { ...userIds, [email!]: r.rows[0]!.id };
  }
  await a.query(`INSERT INTO system.demo_clock (id, demo_anchor, real_anchor, rate, paused, world_epoch, pbs_epoch, last_reset_real, last_write_real)
                 VALUES (1, '2026-09-15T14:00:00Z', now(), 1, true, 4, 4, now(), now())`);
});

describe('process logins (migration 0008)', () => {
  // why: F-150
  it('gives web and worker a login in role app and pbs a login in role pbs, and leaves app and pbs without one', async () => {
    const r = await db.admin().query<{ rolname: string; rolcanlogin: boolean; member_of: string | null }>(
      `SELECT r.rolname, r.rolcanlogin, (SELECT string_agg(g.rolname, ',') FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS member_of
         FROM pg_roles r WHERE r.rolname IN ('app', 'pbs', 'bw_web', 'bw_worker', 'bw_pbs') ORDER BY 1`);
    expect(r.rows).toEqual([
      { rolname: 'app', rolcanlogin: false, member_of: null },
      { rolname: 'bw_pbs', rolcanlogin: true, member_of: 'pbs' },
      { rolname: 'bw_web', rolcanlogin: true, member_of: 'app' },
      { rolname: 'bw_worker', rolcanlogin: true, member_of: 'app' },
      { rolname: 'pbs', rolcanlogin: false, member_of: null },
    ]);
  });

  // why: F-150, FR-BILL-4
  it('holds each login to its role privileges at the access wall', async () => {
    const as = (login: string, sql: string) => db.asRole('postgres', async (tx) => {
      await tx.query(`SET LOCAL ROLE ${login}`);
      return attempt(tx, sql);
    });
    expect(await as('bw_web', 'SELECT 1 FROM system.session LIMIT 1')).toBe('no error');
    expect(await as('bw_web', 'SELECT 1 FROM world."user" LIMIT 1')).toBe('no error');
    expect(await as('bw_web', 'SELECT 1 FROM pbs.invoice LIMIT 1')).toBe('42501');
    expect(await as('bw_web', 'UPDATE world.job_change SET at = at')).toBe('42501');
    expect(await as('bw_pbs', 'SELECT 1 FROM world."user" LIMIT 1')).toBe('42501');
    expect(await as('bw_pbs', 'SELECT 1 FROM pbs.invoice LIMIT 1')).toBe('no error');
  });

  // why: F-150, NFR-14
  it('provisions each login from its own password file, created once and kept on a re-run', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bw-logins-'));
    try {
      expect(await provisionLogins(db.admin(), dir)).toEqual(['bw_web', 'bw_worker', 'bw_pbs']);
      const files = ['web', 'worker', 'pbs'].map((p) => path.join(dir, p, 'password'));
      const first = files.map((f) => readFileSync(f, 'utf8'));
      for (const f of files) expect(statSync(f).mode & 0o777).toBe(0o400);
      expect(new Set(first).size).toBe(3);
      const pw = await db.admin().query<{ rolname: string; scram: boolean }>(
        "SELECT rolname, rolpassword LIKE 'SCRAM-SHA-256$%' AS scram FROM pg_authid WHERE rolname LIKE 'bw\\_%' ORDER BY 1");
      expect(pw.rows).toEqual([{ rolname: 'bw_pbs', scram: true }, { rolname: 'bw_web', scram: true }, { rolname: 'bw_worker', scram: true }]);
      await provisionLogins(db.admin(), dir);
      expect(files.map((f) => readFileSync(f, 'utf8'))).toEqual(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the kernel on the real database, as bw_web', () => {
  const pool = () => createPool({ connectionString: asLogin(db.url(), 'bw_web'), max: 2 });

  // why: NFR-11, F-107
  it('serves the health check through the production kernel', async () => {
    const settings = loadConfig({ DATABASE_URL: asLogin(db.url(), 'bw_web') });
    const k = createWebKernel({ settings, log });
    try {
      // The health check also needs the worker's heartbeat (SPECIFICATIONS 7.4): a fresh one, as the running worker writes it.
      await db.admin().query(`INSERT INTO system.worker_heartbeat (id, beat_real) VALUES (1, now()) ON CONFLICT (id) DO UPDATE SET beat_real = now()`);
      const r = await k.router.handle(new Request('http://web:3000/healthz'));
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('{"status":"ok"}');
      expect(r.headers.get('content-security-policy')).toMatch(/^default-src 'self'/);
    } finally {
      await k.close();
    }
  });

  // why: FR-AUTH-1, FR-AUTH-10, SD-8
  it('resolves real sessions from system.session: a manager in, a technician refused, a turned-off user and an expired session out', async () => {
    const p = pool();
    try {
      const store = new SqlSessionStore(p);
      const clock = new DbClock(p);
      let real = Temporal.Instant.from('2026-11-01T12:00:00Z');
      const sessClock = { realNow: () => real };
      const row = defineContract({ id: 'API-50', name: 'Reports', method: 'GET', path: '/reports', request: z.object({}), response: z.object({ n: z.number() }), errors: [], labels: ['simulated_pilot_data'], examples: [] });
      const router = mount([api(row, MANAGER)], { 'API-50': async (_req, tx) => ({ ok: true, status: 200, data: { n: Number((await tx.query<{ n: string }>('SELECT count(*) AS n FROM system.session')).rows[0]!.n) } }) }, {
        db: { transaction: (fn) => inTransaction(p, fn) }, sessions: store,
        clock: { demoNow: () => clock.demoNow(), worldEpoch: () => clock.worldEpoch(), realNow: () => real },
        log, settings: { APP_ORIGIN: 'http://localhost:8080', DEMO_MODE: false, ACCESS_CODE_ON: false }, accessKey: 'k'.repeat(43),
      });
      const cookie = async (email: string, role: 'manager' | 'technician') =>
        sessionCookie(await startSession(store, sessClock, { userId: userIds[email]!, role }, { client: 'web', via: 'password', keepSignedIn: false }), false, false).split(';')[0]!;
      const call = async (c: string) => router.handle(new Request('http://web:3000/api/v1/reports', { headers: { cookie: c } }));
      const manager = await cookie('dana@example.test', 'manager');
      const ok = await call(manager);
      expect(ok.status).toBe(200);
      const body = JSON.parse(await ok.text()) as { data: { n: number }; meta: { viewer: unknown; worldEpoch: number; demoNow: string } };
      expect(body.meta).toMatchObject({ viewer: { kind: 'staff', userId: userIds['dana@example.test'], role: 'manager' }, worldEpoch: 4, demoNow: '2026-09-15T10:00:00-04:00[America/New_York]' });
      expect(body.data.n).toBeGreaterThanOrEqual(1);
      expect((await call(await cookie('maria@example.test', 'technician'))).status).toBe(403);
      expect((await call(await cookie('off@example.test', 'manager'))).status).toBe(401);
      const before = Number((await p.query<{ n: string }>('SELECT count(*) AS n FROM system.session')).rows[0]!.n);
      real = real.add({ minutes: 31 }); // past the office idle limit, in real time
      expect((await call(manager)).status).toBe(401);
      const after = Number((await p.query<{ n: string }>('SELECT count(*) AS n FROM system.session')).rows[0]!.n);
      expect(after).toBe(before - 1); // the dead session was removed
    } finally {
      await p.end();
    }
  });
});

afterAll(() => {
  expect(lines.join('')).not.toMatch(/dana@|maria@|password/);
});
