// SPDX-License-Identifier: AGPL-3.0-or-later
// Database test fixtures: a fresh migrated database per test file, and a way to act as a real database role.
// asRole runs the callback in a transaction under SET LOCAL ROLE, so PostgreSQL itself checks every privilege as
// that role (the access wall the app and pbs processes hit), then rolls back so tests leave no rows behind.
import { afterAll, beforeAll } from 'vitest';
import { createClient, type Queryable } from '../client.ts';
import { migrateUrl } from '../migrate.ts';
import { createDatabase, type TestDatabase } from './database.ts';
import { pgAdminUrl } from './provided.ts';

/**
 * 1 query in flight on a connection that every test of a file shares (F-314). A test that vitest times out leaves
 * its query running on the connection; pg would queue every later test's queries behind it ("client.query() when the
 * client is already executing a query"), so each later test waits out its own timeout too and the file outlasts its
 * gate's limit. Here the overlapping call is refused at once and names the query still in flight.
 */
export function oneQueryInFlight(c: Queryable): Queryable {
  let inFlight: string | null = null;
  return {
    async query<R>(text: string, values?: unknown[]) {
      if (inFlight !== null) {
        throw new Error(`the file's shared database connection is still running an earlier query (a test that timed out left it in flight): ${inFlight.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
      inFlight = text;
      try {
        return await c.query<R>(text, values);
      } finally {
        inFlight = null;
      }
    },
  };
}

export interface MigratedDatabase {
  url(): string;
  /** A connected superuser client of this file's database. */
  admin(): Queryable;
  /** Run fn as role `app` or `pbs` inside a transaction that is rolled back afterwards. */
  asRole<T>(role: 'app' | 'pbs' | 'postgres', fn: (db: Queryable) => Promise<T>): Promise<T>;
}

export function useMigratedDatabase(): MigratedDatabase {
  let db: TestDatabase | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let shared: Queryable | undefined;
  beforeAll(async () => {
    db = await createDatabase(pgAdminUrl());
    await migrateUrl(db.url);
    client = createClient({ connectionString: db.url });
    await client.connect();
    shared = oneQueryInFlight(client as unknown as Queryable);
  });
  afterAll(async () => {
    await client?.end();
    await db?.drop();
  });
  const q = () => {
    if (!shared) throw new Error('the database is not ready (beforeAll has not run)');
    return shared;
  };
  return {
    url: () => db?.url ?? '',
    admin: q,
    async asRole(role, fn) {
      const c = q();
      await c.query('BEGIN');
      try {
        if (role !== 'postgres') await c.query(`SET LOCAL ROLE ${role}`);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK');
      }
    },
  };
}

/** The PostgreSQL error code of a rejected promise (23503 foreign key, 23505 unique, 23514 check, 42501 privilege). */
export async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as { code?: string }).code ?? (e as Error).message);
  }
  return 'no error';
}

/** Savepoint wrapper: run 1 statement that may fail without aborting the surrounding transaction. */
export async function attempt(db: Queryable, sql: string, values: unknown[] = []): Promise<string> {
  await db.query('SAVEPOINT attempt');
  const code = await errorCode(db.query(sql, values));
  await db.query(code === 'no error' ? 'RELEASE SAVEPOINT attempt' : 'ROLLBACK TO SAVEPOINT attempt');
  return code;
}

/** Minimal reference rows a job needs, inserted as the caller's role. Returns their ids. */
export async function seedReference(db: Queryable): Promise<{ branchId: string; streetId: string; customerId: string; userId: string; windowId: string; serviceId: string; technicianId: string }> {
  await db.query(`INSERT INTO world.branch (id, name_key, zone, office_phone, depot_lon, depot_lat, map_file)
                  VALUES ('columbus', 'branch.columbus', 'America/New_York', '(614) 555-0100', -83.0, 39.96, 'columbus.pmtiles')`);
  const street = await db.query<{ id: string }>(`INSERT INTO world.street (name, name_search, city, zip, branch_id, points)
                  VALUES ('High St', 'high st', 'Columbus', '43215', 'columbus', '[[-83.0, 39.96]]') RETURNING id`);
  const streetId = street.rows[0]?.id ?? '';
  const customer = await db.query<{ id: string }>(`INSERT INTO world.customer (branch_id, name, name_search, texts_on, text_language, zone,
                    street_id, house_number, lon, lat, customer_since, source, status, inbox_token)
                  VALUES ('columbus', 'Ann Lee', 'ann lee', true, 'en', 'America/New_York', $1, 12, -83.0, 39.96, '2020-05-01',
                    'office', 'active', 'abcdefghijklmnopqrstuv') RETURNING id`, [streetId]);
  const user = await db.query<{ id: string }>(`INSERT INTO world."user" (email, name, name_search, role, branch_id, language, status, sample, reviewer)
                  VALUES ('dana@example.test', 'Dana Ruiz', 'dana ruiz', 'manager', 'columbus', 'en', 'active', true, false) RETURNING id`);
  const userId = user.rows[0]?.id ?? '';
  await db.query(`INSERT INTO world.service_type (id, screen_label_key, text_label_key, price_text_key, typical_length_key,
                    invoice_price_cents, job_type, expected_minutes, skill, bookable_online)
                  VALUES ('tune_up', 's.k', 't.k', 'p.k', 'l.k', 8900, 'maintenance', 60, 'heating_cooling', true)`);
  const window = await db.query<{ id: string }>(`INSERT INTO world.arrival_window (branch_id, mode, start_local, end_local, label_key, capacity)
                  VALUES ('columbus', 'two_hour', '08:00', '10:00', 'w.8', 12) RETURNING id`);
  const tech = await db.query<{ id: string }>(`INSERT INTO world.technician (user_id, branch_id, name, name_in_texts, phone, primary_skill,
                    skills, installer, shift_start, shift_end, working_days, saturdays, since)
                  VALUES ($1, 'columbus', 'Maria Santos', 'Maria', '(614) 555-0142', 'heating_cooling', '{heating_cooling}', false,
                    '08:00', '17:00', '{1,2,3,4,5}', 'none', '2016-03-01') RETURNING id`, [userId]);
  return {
    branchId: 'columbus', streetId, customerId: customer.rows[0]?.id ?? '', userId,
    windowId: window.rows[0]?.id ?? '', serviceId: 'tune_up', technicianId: tech.rows[0]?.id ?? '',
  };
}

/** Insert a job row with the given overrides; returns its job number. */
export async function insertJob(db: Queryable, ref: { customerId: string; windowId: string }, over: Record<string, unknown> = {}): Promise<number> {
  const row: Record<string, unknown> = {
    customer_id: ref.customerId, branch_id: 'columbus', service_id: 'tune_up', date: '2026-09-15', zone: 'America/New_York',
    window_id: ref.windowId, window_start: '2026-09-15T08:00:00-04:00', window_end: '2026-09-15T10:00:00-04:00',
    status: 'scheduled', version: 1, expected_minutes: 60, booked_via: 'office', booked_at: '2026-09-14T12:00:00Z',
    billing_state: 'not_sent', autopilot: false, touched_by_person: false, pilot: false, ...over,
  };
  const cols = Object.keys(row);
  const r = await db.query<{ job_number: number }>(
    `INSERT INTO world.job (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING job_number`,
    Object.values(row),
  );
  return r.rows[0]?.job_number ?? -1;
}
