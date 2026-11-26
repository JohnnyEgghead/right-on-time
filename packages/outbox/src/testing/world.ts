// SPDX-License-Identifier: AGPL-3.0-or-later
// Test support for the outbox's database tests and gates G-CI2 and G-CI9 (not product code; the image leaves out
// **/src/testing). A minimal migrated world: @bw/db's reference fixture, the 1 clock row (paused, so demo now is
// exactly what a test sets), customers and jobs, the simulator row, and pools signed in as the real process logins.
import type { Queryable } from '@bw/db';
import { createPool } from '@bw/db';
import { Temporal, type Instant } from '@bw/time';
import { insertJob, seedReference } from '../../../db/src/testing/fixture.ts';
import type { SimulatorMode } from '../gateway.ts';
import { catalogTexts, type TextCatalog } from '../render.ts';
import type { VisitDayLabels } from '../reply.ts';

export const I = (s: string): Instant => Temporal.Instant.from(s);

/** The host's own IANA zone (the TZ a gate run was started under). */
export function hostZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * A pool signed in as a process login (bw_web or bw_worker, both members of role app: the access wall the processes
 * hit), with the database session's TimeZone set to the host zone, so a run under each host zone of NFR-08's matrix
 * also moves the session zone that any SQL local-time cast would read (F-178 part b).
 */
export function loginPool(databaseUrl: string, login: 'bw_web' | 'bw_worker'): ReturnType<typeof createPool> {
  const u = new URL(databaseUrl);
  u.username = login;
  u.password = '';
  return createPool({ connectionString: u.toString(), max: 4, options: `-c TimeZone=${hostZone()}` });
}

export interface OutboxRef {
  branchId: string;
  streetId: string;
  windowId: string;
  userId: string;
}

/** Reference rows, the clock row paused at `at`, and the simulator up. */
export async function seedOutboxWorld(admin: Queryable, at = '2026-09-15T14:00:00Z'): Promise<OutboxRef> {
  const ref = await seedReference(admin);
  await admin.query(
    `INSERT INTO system.demo_clock (id, demo_anchor, real_anchor, rate, paused, world_epoch, pbs_epoch, last_reset_real, last_write_real)
     VALUES (1, $1, '2026-11-01T16:00:00Z', 1, true, 1, 1, '2026-11-01T16:00:00Z', '2026-11-01T16:00:00Z')`,
    [at],
  );
  await admin.query(`INSERT INTO world.text_simulator (mode) VALUES ('up')`);
  return { branchId: ref.branchId, streetId: ref.streetId, windowId: ref.windowId, userId: ref.userId };
}

/** Pause the demo clock at `at` (the dispatcher reads it through DbClock). */
export async function setDemoClock(admin: Queryable, at: string | Instant): Promise<void> {
  await admin.query(`UPDATE system.demo_clock SET demo_anchor = $1, paused = true WHERE id = 1`, [at.toString()]);
}

export async function setSimulator(admin: Queryable, mode: SimulatorMode, opts: { customerId?: string; n?: number } = {}): Promise<void> {
  await admin.query(`UPDATE world.text_simulator SET mode = $1, customer_id = $2, n_left = $3`, [mode, opts.customerId ?? null, opts.n ?? null]);
}

let customers = 0;

export async function addCustomer(
  admin: Queryable,
  ref: OutboxRef,
  over: { name?: string; zone?: string; mobile?: string | null; textsOn?: boolean; language?: 'en' | 'es' } = {},
): Promise<string> {
  customers += 1;
  const name = over.name ?? `Customer ${customers}`;
  const r = await admin.query<{ id: string }>(
    `INSERT INTO world.customer (branch_id, name, name_search, mobile, texts_on, text_language, zone, street_id, house_number, lon, lat,
       customer_since, source, status, inbox_token)
     VALUES ($1, $2, lower($2), $3, $4, $5, $6, $7, 10, -83.0, 39.96, '2020-05-01', 'office', 'active', $8) RETURNING id`,
    [
      ref.branchId, name, over.mobile === undefined ? '(614) 555-0199' : over.mobile, over.textsOn ?? true, over.language ?? 'en',
      over.zone ?? 'America/New_York', ref.streetId, `inbox${String(customers).padStart(17, '0')}`,
    ],
  );
  return r.rows[0]!.id;
}

/** A scheduled job of the customer on `date` (8 to 10 AM in the branch zone). */
export function addJob(admin: Queryable, ref: OutboxRef, customerId: string, date = '2026-09-16', over: Record<string, unknown> = {}): Promise<number> {
  return insertJob(admin, { customerId, windowId: ref.windowId }, {
    date, window_start: `${date}T08:00:00-04:00`, window_end: `${date}T10:00:00-04:00`, ...over,
  });
}

/** Stand-in templates for every kind (test copy, not product copy: the real texts are in the catalog). */
export const testCatalog: TextCatalog = catalogTexts({
  en: {
    'text.confirmation': 'Brightwater: Your {service} visit is booked for {weekday}, {date}, {window}.',
    'text.reminder': 'Brightwater: A reminder that your visit is tomorrow, {window}.',
    'text.on_the_way': 'Brightwater: {tech} is on the way, arriving about {arrival}. Track {tech}: {mapLink}',
    'text.late': 'Brightwater: {tech} is running late, now arriving about {arrival}.',
    'text.r_reply': 'Brightwater: No problem. Pick a new time for your {weekday}, {date} visit: {rescheduleLink} or call {phone}.',
  },
  es: {
    'text.confirmation': 'Brightwater: Su visita de {service} esta reservada para {weekday}, {date}, {window}.',
    'text.reminder': 'Brightwater: Le recordamos que su visita es manana, {window}.',
    'text.on_the_way': 'Brightwater: {tech} va en camino, llega a las {arrival}. Siga a {tech}: {mapLink}',
    'text.late': 'Brightwater: {tech} va con retraso, llega a las {arrival}.',
    'text.r_reply': 'Brightwater: Elija una nueva hora para su visita del {weekday}, {date}: {rescheduleLink} o llame al {phone}.',
  },
});

/** Stand-in day labels, in place of the catalog-driven visitDayLabels of slots.ts. */
export const testDayLabels: VisitDayLabels = (date, lang) => {
  const d = Temporal.PlainDate.from(date);
  const en = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return lang === 'en'
    ? { weekday: en[d.dayOfWeek - 1]!, date: `${months[d.month - 1]!} ${d.day}` }
    : { weekday: ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'][d.dayOfWeek - 1]!, date: `${d.day} de ${months[d.month - 1]!.toLowerCase()}` };
};

export const confirmationValues = { service: 'Tune-up', weekday: 'Wed', date: 'Sep 16', window: '8-10 AM' };

/** A text's attempts as [number, at (UTC ISO), result]. */
export async function attemptsOf(db: Queryable, textId: string): Promise<[number, string, string][]> {
  const r = await db.query<{ number: number; at: Date; result: string }>(
    `SELECT number, at, result FROM world.text_attempt WHERE text_id = $1 ORDER BY number`,
    [textId],
  );
  return r.rows.map((a) => [a.number, Temporal.Instant.fromEpochMilliseconds(a.at.getTime()).toString(), a.result]);
}

export async function textRow(db: Queryable, textId: string): Promise<Record<string, unknown>> {
  const r = await db.query(`SELECT * FROM world.outbox_text WHERE id = $1`, [textId]);
  return r.rows[0] as Record<string, unknown>;
}

export async function count(db: Queryable, sql: string, values: unknown[] = []): Promise<number> {
  const r = await db.query<{ n: string }>(sql, values);
  return Number(r.rows[0]?.n);
}
