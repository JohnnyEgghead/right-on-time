// SPDX-License-Identifier: AGPL-3.0-or-later
// The reference half of the seed (SPECIFICATIONS D-3, BUILD_PLAN P2-SEED): branches, the street list, services and
// prices, the fixed parts list, vans, staff and technician users with sample passwords, technicians, arrival windows,
// the sample peak days and the 1 clock row. It writes no row that references a customer (the generator, the import and
// the world seed come after it, in foreign-key order).
//
// Idempotent: every row has a natural key and an existing row is left as it is (no update), so running it twice on an
// empty migrated database leaves identical rows. The caller owns the transaction (setup passes its client). Not
// exported from the @bw/db index: it reads the generator's roster file and, with a street list, the verified list.
import { createHash } from 'node:crypto';
import type { Queryable } from '../client.ts';
import { foldStreetName } from '../fold.ts';
import { hashPassword, samplePassword } from '../passwords.ts';
import { loadStreetList, type StreetListRow } from '../street-list.ts';
import {
  BRANCHES, CLOCK_START, COLUMBUS_CAPACITIES, FOUR_HOUR_WINDOWS, PARTS, EXTRA_USERS, PEAK_DAYS, REVIEWER, SERVICES, STAFF,
  TECHNICIAN_DAY_CAPACITY, TWO_HOUR_WINDOWS, USER_CHANGES, planTechnicians, readRoster, type TechnicianPlan,
} from './reference-data.ts';

/** SD-29: an invite link is good for 7 demo days (the same figure as the accounts handler's INVITE_HOURS). */
const INVITE_HOURS = 7 * 24;

export interface SeedOptions {
  /** SAMPLE_PASSWORD_SEED (SD-9): each sample person's password derives from it and their email. */
  sampleSeed: string;
  /** REVIEWER_PASSWORD: the reviewer account exists only when this is set (HC-05, FR-IOS-5). */
  reviewerPassword?: string | undefined;
  /** The real instant the clock row is anchored to (the caller reads it through the time seam). */
  anchorReal: Date;
  /** The bundled street list; loaded only while world.street is empty. */
  streetList?: readonly StreetListRow[] | undefined;
  /** The technician roster; default: packages/generator/technicians.json. */
  roster?: TechnicianPlan[] | undefined;
}

export interface SeedResult {
  streetsLoaded: number;
  usersAdded: number;
  clockWritten: boolean;
}

const hhmm = (h: number) => `${String(h).padStart(2, '0')}:00`;
const ids = async (db: Queryable, sql: string, values: unknown[] = []) => (await db.query<{ k: string; id: string }>(sql, values)).rows;

export async function seedReference(db: Queryable, opts: SeedOptions): Promise<SeedResult> {
  const technicians = opts.roster ?? planTechnicians(readRoster());

  // 1. Branches: Columbus, Dayton and Springfield, each with its depot, office phone and map file (section 3 branch; FR-MAP-1, FR-DISP-20).
  for (const b of BRANCHES) {
    await db.query(
      `INSERT INTO world.branch (id, name_key, zone, office_phone, depot_lon, depot_lat, map_file)
       VALUES ($1, $2, $7, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [b.id, `branch.${b.id}`, b.phone, b.lon, b.lat, `${b.id}.pmtiles`, b.zone],
    );
  }

  // 2. The street list (SD-23), only into an empty table.
  let streetsLoaded = 0;
  if (opts.streetList && opts.streetList.length > 0) {
    const have = await db.query<{ n: string }>('SELECT count(*) AS n FROM world.street');
    if (Number(have.rows[0]?.n ?? 0) === 0) streetsLoaded = await loadStreetList(db, opts.streetList);
  }

  // 3. Services and prices (SD-20; the $0.00 line of OI-24 is invoice_price_cents 0).
  for (const s of SERVICES) {
    await db.query(
      `INSERT INTO world.service_type (id, screen_label_key, text_label_key, price_text_key, typical_length_key,
                                       invoice_price_cents, job_type, expected_minutes, skill, bookable_online)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
      [s.id, `service.${s.id}.screen`, `service.${s.id}.text`, `service.${s.id}.price`, `service.${s.id}.length`,
        s.cents, s.jobType, s.minutes, s.skill, s.online],
    );
  }

  // 4. The parts catalog (OA-54; F-339): the 10 mockup parts and the generated rest, about 1,240, searched by name or code.
  //    The generator rule is disclosed beside the list in reference-data.ts. One statement; a second run changes nothing.
  //    F-440: a part row a database already holds takes the list's name and price (a row that already matches is not touched).
  //    That reaches only a database whose setup stopped after this step, or a repeat seed in a test. It never reaches a world that
  //    finished setup: setup stops on it (world_not_fresh, packages/setup/src/pipeline.ts assertFresh), and the nightly reset refills
  //    world.part from world_snapshot. Such a world takes the corrected rows only when its database is recreated and set up again:
  //    infra/deploy/reset-world.sh (F-1801).
  await db.query(
    `INSERT INTO world.part AS p (code, name, name_search, price_cents)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[])
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, name_search = EXCLUDED.name_search, price_cents = EXCLUDED.price_cents
      WHERE (p.name, p.name_search, p.price_cents) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.name_search, EXCLUDED.price_cents)`,
    [PARTS.map((p) => p.code), PARTS.map((p) => p.name), PARTS.map((p) => foldStreetName(`${p.name} ${p.code}`)), PARTS.map((p) => p.cents)],
  );

  // 5. Vans: 1 per technician, no natural key in the table, so look before inserting.
  for (const t of technicians) {
    await db.query(
      `INSERT INTO world.van (branch_id, number, vehicle)
       SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM world.van WHERE branch_id = $1 AND number = $2)`,
      [t.branch, t.vanNumber, t.vehicle],
    );
  }

  // 6. Users (sample passwords hashed by scrypt, SD-9). Existing emails are left alone and not rehashed.
  const existing = new Set((await db.query<{ email: string }>('SELECT email::text AS email FROM world."user"')).rows.map((r) => r.email));
  interface UserPlan {
    email: string; name: string; role: string; branch: string; language: string; title: string | null;
    employee: string | null; password: string | null; sample: boolean; reviewer: boolean; off: boolean; status: string;
  }
  const plans: UserPlan[] = [
    ...STAFF.map((s) => ({
      email: s.email, name: s.name, role: s.role, branch: s.branch, language: s.language, title: s.title, employee: null,
      password: samplePassword(opts.sampleSeed, s.email), sample: true, reviewer: false, off: s.off === true,
      status: s.off === true ? 'turned_off' : 'active',
    })),
    ...technicians.map((t) => ({
      email: t.email, name: t.name, role: 'technician', branch: t.branch, language: t.language, title: null, employee: t.employeeNumber,
      password: t.status === 'invited' ? null : samplePassword(opts.sampleSeed, t.email), sample: true, reviewer: false, off: false,
      status: t.status,
    })),
    // Technician users with no technician row (no past visits). An Invited user has no password hash (SPECIFICATIONS: null while Invited).
    ...EXTRA_USERS.map((x) => ({
      email: x.email, name: x.name, role: 'technician', branch: x.branch, language: x.language, title: null, employee: null,
      password: x.status === 'invited' ? null : samplePassword(opts.sampleSeed, x.email), sample: true, reviewer: false, off: false,
      status: x.status,
    })),
  ];
  if (opts.reviewerPassword) {
    plans.push({
      email: REVIEWER.email, name: REVIEWER.name, role: 'technician', branch: REVIEWER.branch, language: 'en', title: null, employee: null,
      password: opts.reviewerPassword, sample: false, reviewer: true, off: false, status: 'active',
    });
  }
  const fresh = plans.filter((p) => !existing.has(p.email));
  const hashes = await Promise.all(fresh.map((p) => (p.password === null ? Promise.resolve(null) : hashPassword(p.password))));
  for (const [i, p] of fresh.entries()) {
    await db.query(
      `INSERT INTO world."user" (email, name, name_search, password_hash, role, branch_id, language, status, status_before_off,
                                 employee_number, title, sample, reviewer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (email) DO NOTHING`,
      [p.email, p.name, foldStreetName(p.name), hashes[i], p.role, p.branch, p.language, p.status,
        p.off ? 'active' : null, p.employee, p.title, p.sample, p.reviewer],
    );
  }

  // 6b. The open invites of the Invited users (F-273; the approved users page: Derek Simmons "Invite sent Sep 14", the link good 7 demo days, SD-29):
  //     1 unused password_token each, so Resend invite has a link to retire. The hash is derived from the seed and the email, never a token anyone
  //     was shown (only a hash is stored); a second run finds the same hash and adds nothing.
  for (const p of plans.filter((x) => x.status === 'invited')) {
    await db.query(
      `INSERT INTO world.password_token (token_hash, user_id, kind, expires_at)
       SELECT $1, u.id, 'invite', TIMESTAMPTZ '2026-09-14 14:10-04' + make_interval(hours => $3) FROM world."user" u WHERE u.email = $2
       ON CONFLICT (token_hash) DO NOTHING`,
      [createHash('sha256').update(`invite:${opts.sampleSeed}:${p.email}`).digest(), p.email, INVITE_HOURS],
    );
  }

  // 7. Technicians (FR-DISP-15, FR-DISP-33): the user and the van are found by their natural keys.
  const users = new Map((await ids(db, 'SELECT email::text AS k, id FROM world."user"')).map((r) => [r.k, r.id]));
  const vans = new Map((await ids(db, `SELECT branch_id || '/' || number AS k, id FROM world.van`)).map((r) => [r.k, r.id]));
  for (const t of technicians) {
    await db.query(
      `INSERT INTO world.technician (user_id, branch_id, name, name_in_texts, phone, primary_skill, skills, installer, van_id,
                                     shift_start, shift_end, working_days, saturdays, since)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (user_id) DO NOTHING`,
      [users.get(t.email), t.branch, t.name, t.nameInTexts, t.phone, t.primarySkill, t.skills, t.installer,
        vans.get(`${t.branch}/${t.vanNumber}`), t.shiftStart, t.shiftEnd, t.workingDays, t.saturdays, t.since],
    );
  }

  // 7b. The users page's Recent changes as user_change rows (append-only, no natural key: look before inserting).
  for (const c of USER_CHANGES) {
    await db.query(
      `INSERT INTO world.user_change (user_id, what, "by", at)
       SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM world.user_change WHERE user_id = $1 AND what = $2 AND at = $4)`,
      [users.get(c.email), c.what, users.get(c.byEmail), c.at],
    );
  }

  // 8. Arrival windows with their capacities as per-window settings (FR-BOOK-5, FR-BOOK-6, FR-BOOK-7).
  for (const b of BRANCHES) {
    const wholeDay = technicians.filter((t) => t.branch === b.id).length * TECHNICIAN_DAY_CAPACITY;
    const rows: [string, number, number, number | null][] = [
      ...TWO_HOUR_WINDOWS.map(([s, e], i): [string, number, number, number | null] => ['two_hour', s, e, b.id === 'columbus' ? (COLUMBUS_CAPACITIES[i] ?? 0) : wholeDay]),
      ...FOUR_HOUR_WINDOWS.map(([s, e]): [string, number, number, number | null] => ['four_hour', s, e, null]),
    ];
    for (const [mode, s, e, capacity] of rows) {
      await db.query(
        `INSERT INTO world.arrival_window (branch_id, mode, start_local, end_local, label_key, capacity)
         SELECT $1, $2, $3, $4, $5, $6
          WHERE NOT EXISTS (SELECT 1 FROM world.arrival_window WHERE branch_id = $1 AND mode = $2 AND start_local = $3)`,
        [b.id, mode, hhmm(s), hhmm(e), `window.${mode}.${hhmm(s).slice(0, 2)}`, capacity],
      );
    }
  }

  // 9. The sample peak days (OA-29 row 18), switched by the manager who runs all 3 branches.
  const switcher = users.get(STAFF[0]?.email ?? '');
  for (const date of PEAK_DAYS.dates) {
    await db.query(
      `INSERT INTO world.day_mode (branch_id, date, mode, reason, switched_by, switched_at)
       VALUES ($1, $2, 'four_hour', $3, $4, $5) ON CONFLICT (branch_id, date) DO NOTHING`,
      [PEAK_DAYS.branch, date, PEAK_DAYS.reason, switcher, PEAK_DAYS.switchedAt],
    );
  }

  // 10. The 1 clock row at world epoch 1, only when absent (owner ruling c025a9ec; D11).
  const clock = await db.query(
    `INSERT INTO system.demo_clock (id, demo_anchor, real_anchor, rate, paused, world_epoch, pbs_epoch, last_reset_real, last_write_real)
     VALUES (1, $1, $2, 1, true, 1, 1, $2, $2) ON CONFLICT (id) DO NOTHING`,
    [CLOCK_START, opts.anchorReal],
  );

  return { streetsLoaded, usersAdded: fresh.length, clockWritten: (clock.rowCount ?? 0) > 0 };
}
