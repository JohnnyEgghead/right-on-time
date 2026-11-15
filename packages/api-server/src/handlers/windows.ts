// SPDX-License-Identifier: AGPL-3.0-or-later
// The arrival windows page's reads and writes (UI-SPECIFICATION 12.2 API-90, API-91, API-155; SPECIFICATIONS section 5.3 step 5,
// section 6.1 "Day mode switch", "Window capacity edits", "Switch record"; FR-BOOK-2, FR-BOOK-8, FR-BOOK-17, FR-BOOK-18, UC-13).
// The read draws the day from the same capacity functions the writes and the week board call (@bw/domain: worksOn,
// technicianDayCapacity, offeredWindows), so a number on this page cannot differ from what a write enforces. The 2 writes take the
// booking-day locks (section 5.3) before they read what they decide on, and publish settings.changed (EVT-09) as every settings
// writer does, so the day board, the week board and an open copy of this page re-read.
import { SETTINGS_DAYS_MAX, type bookingSettings, type setDayMode, type setWindowLimits } from '@bw/api';
import { publishEvent } from '@bw/db';
import {
  DAY_CAPACITY, dayKind, isLive, offeredWindows, technicianDayCapacity, worksOn, type DayMode, type TechnicianFacts,
} from '@bw/domain';
import { QUIET_END, QUIET_START, REMINDER_TIME } from '@bw/outbox';
import { Temporal, toWire } from '@bw/time';
import type { z } from 'zod';
import { lockBookingDays } from '../office-writes/locks.ts';
import { OFFICE_HORIZON_DAYS } from '../office-writes/service.ts';
import type { ApiResult, Handler, Tx } from '../types.ts';
import { ONLINE_CUTOFF_LOCAL } from './board-week.ts';

type Out<T extends { response: z.ZodType }> = z.infer<T['response']>;
type In<T extends { request: z.ZodType }> = z.infer<T['request']>;
type Settings = Out<typeof bookingSettings>;
type Day = Settings['days'][number];

const hhmm = (t: string): string => t.slice(0, 5);
const instant = (d: Date): Temporal.Instant => Temporal.Instant.fromEpochMilliseconds(d.getTime());
const dateOf = (n: Temporal.Instant, zone: string): string => n.toZonedDateTimeISO(zone).toPlainDate().toString();
const addDays = (date: string, n: number): string => Temporal.PlainDate.from(date).add({ days: n }).toString();
const dayCount = (from: string, to: string): number => Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to), { largestUnit: 'days' }).days + 1;

interface WindowRow { id: string; mode: DayMode; start_local: string; end_local: string; capacity: number | null }
interface TechRow {
  id: string; installer: boolean; working_days: number[]; saturdays: TechnicianFacts['saturdays']; time_off: { from: string; to: string }[];
}

async function branchZone(tx: Tx, branch: string): Promise<string | null> {
  return (await tx.query<{ zone: string }>('SELECT zone FROM world.branch WHERE id = $1', [branch])).rows[0]?.zone ?? null;
}

const windowsOf = async (tx: Tx, branch: string): Promise<WindowRow[]> =>
  (await tx.query<WindowRow>(
    'SELECT id, mode, start_local::text AS start_local, end_local::text AS end_local, capacity FROM world.arrival_window WHERE branch_id = $1 ORDER BY start_local, mode', [branch])).rows;

const span = (w: WindowRow) => ({ start: hhmm(w.start_local), end: hhmm(w.end_local) });

async function techniciansOf(tx: Tx, branch: string): Promise<TechnicianFacts[]> {
  const r = await tx.query<TechRow>(
    `SELECT t.id, t.installer, t.working_days, t.saturdays,
            coalesce((SELECT json_agg(json_build_object('from', o.from_date, 'to', o.to_date)) FROM world.time_off o WHERE o.technician_id = t.id), '[]'::json) AS time_off
       FROM world.technician t WHERE t.branch_id = $1`, [branch]);
  return r.rows.map((t) => ({ id: t.id, installer: t.installer, workingDays: t.working_days, saturdays: t.saturdays, timeOff: t.time_off }));
}

/** The days from..to as the calendar shows them (CTL-OFC-12-03, -11), read in the caller's transaction. */
async function daysOf(tx: Tx, branch: string, zone: string, from: string, to: string, windows: WindowRow[]): Promise<Day[]> {
  const techs = await techniciansOf(tx, branch);
  const jobs = (await tx.query<{ date: string; status: string; customer_id: string; window_mode: DayMode }>(
    `SELECT j.date::text AS date, j.status, j.customer_id, w.mode AS window_mode
       FROM world.job j JOIN world.arrival_window w ON w.id = j.window_id
      WHERE j.branch_id = $1 AND j.date BETWEEN $2::date AND $3::date`, [branch, from, to])).rows.filter((j) => isLive(j.status));
  const modes = new Map((await tx.query<{ date: string; mode: DayMode; reason: string; name: string | null; switched_at: Date }>(
    `SELECT d.date::text AS date, d.mode, d.reason, u.name, d.switched_at
       FROM world.day_mode d LEFT JOIN world."user" u ON u.id = d.switched_by
      WHERE d.branch_id = $1 AND d.date BETWEEN $2::date AND $3::date`, [branch, from, to])).rows.map((m) => [m.date, m]));
  const facts = windows.map((w) => ({ ...w, startLocal: w.start_local }));

  const days: Day[] = [];
  for (let i = 0; i < dayCount(from, to); i += 1) {
    const date = addDays(from, i);
    const row = modes.get(date);
    const mode: DayMode = row?.mode ?? 'two_hour';
    const kind = dayKind(date, mode);
    const working = techs.filter((t) => worksOn(t, date));
    const mine = jobs.filter((j) => j.date === date);
    const booked = mine.length;
    // FR-BOOK-10: a Sunday is always closed, a Saturday only when no technician works it.
    const closed = kind === 'sunday' || (kind === 'saturday' && working.length === 0);
    const four = !closed && kind === 'four_hour';
    days.push({
      date,
      mode: closed ? 'closed' : four ? 'four_hour' : 'two_hour',
      booked,
      capacity: closed ? 0 : working.reduce((n, t) => n + technicianDayCapacity(t, kind), 0),
      // CTL-OFC-24-01: the customers already booked into a 2-hour window (a customer with 2 visits that day counts once), who keep their
      // windows (FR-BOOK-8). A customer booked into a 4-hour window after the switch is not one of them (F-751).
      bookedCount: new Set(mine.filter((j) => j.window_mode === 'two_hour').map((j) => j.customer_id)).size,
      windows: closed ? [] : offeredWindows(facts, kind).map(span),
      reason: four ? (row?.reason ?? null) : null,
      switchedBy: four ? (row?.name ?? null) : null,
      switchedAt: four && row ? toWire(instant(row.switched_at), zone) : null,
    });
  }
  return days;
}

/** API-90: the branch's windows with their limits and today's bookings, the fixed rules, and the days from..to. */
export const bookingSettingsHandler: Handler<Settings> = async (req, tx) => {
  const p = req.params as In<typeof bookingSettings>;
  const zone = await branchZone(tx, p.branchId);
  if (!zone) return { ok: false, status: 404, code: 'not_found' };
  const today = dateOf(req.demoNow, zone);
  if ((p.from === undefined) !== (p.to === undefined)) return { ok: false, status: 422, code: 'validation_failed' };
  // No range: the 2 weeks the calendar draws, from the Monday of the week that holds today (CTL-OFC-12-11).
  const from = p.from ?? addDays(today, 1 - Temporal.PlainDate.from(today).dayOfWeek);
  const to = p.to ?? addDays(from, 13);
  if (to < from || dayCount(from, to) > SETTINGS_DAYS_MAX) return { ok: false, status: 422, code: 'validation_failed' };
  const windows = await windowsOf(tx, p.branchId);
  const days = await daysOf(tx, p.branchId, zone, from, to, windows);

  const todays = await tx.query<{ window_id: string; n: string }>(
    `SELECT window_id, count(*) AS n FROM world.job WHERE branch_id = $1 AND date = $2::date AND status <> 'canceled' GROUP BY window_id`, [p.branchId, today]);
  const bookedIn = new Map(todays.rows.map((r) => [r.window_id, Number(r.n)]));
  const working = (await techniciansOf(tx, p.branchId)).filter((t) => worksOn(t, today)).length;

  return {
    ok: true,
    status: 200,
    data: {
      branch: p.branchId,
      today,
      windows: windows.filter((w) => w.mode === 'two_hour').map((w) => ({
        windowId: w.id, ...span(w), technicians: working, limit: w.capacity ?? 0, bookedToday: bookedIn.get(w.id) ?? 0,
      })),
      rules: {
        onlineCutoff: ONLINE_CUTOFF_LOCAL, reminder: REMINDER_TIME, quietFrom: QUIET_START, quietTo: QUIET_END,
        capacities: { twoHour: DAY_CAPACITY.two_hour, fourHour: DAY_CAPACITY.four_hour, saturday: DAY_CAPACITY.saturday },
      },
      twoHourWindows: windows.filter((w) => w.mode === 'two_hour').map(span),
      fourHourWindows: windows.filter((w) => w.mode === 'four_hour').map(span),
      days,
    },
  };
};

/**
 * API-91: upsert the day's day_mode row under the booking-day lock (section 5.3 step 3). A day that has a booking keeps it: a job holds
 * its own window (FR-BOOK-8), so nothing about a job is written here. Switching a day that already uses 2-hour windows back to
 * 2-hour windows changes nothing and publishes nothing.
 */
export const setDayModeHandler: Handler<Out<typeof setDayMode>> = async (req, tx) => {
  if (req.caller.kind !== 'staff') return { ok: false, status: 401, code: 'unauthenticated' };
  const p = req.params as In<typeof setDayMode>;
  const zone = await branchZone(tx, p.branchId);
  if (!zone) return { ok: false, status: 404, code: 'not_found' };
  const weekday = Temporal.PlainDate.from(p.date).dayOfWeek;
  if (p.date < dateOf(req.demoNow, zone)) return { ok: false, status: 409, code: 'day_past' };
  if (weekday === 7) return { ok: false, status: 409, code: 'day_closed' };
  if (weekday === 6 && p.mode === 'four_hour') return { ok: false, status: 409, code: 'rule_refused', detail: { key: 'rule.saturdayHalfDay' } };
  const reason = p.reason?.trim() ?? '';
  if (p.mode === 'four_hour' && reason === '') return { ok: false, status: 422, code: 'validation_failed' };

  await lockBookingDays(tx, [{ branch: p.branchId, date: p.date }]);
  const had = (await tx.query('SELECT 1 FROM world.day_mode WHERE branch_id = $1 AND date = $2::date', [p.branchId, p.date])).rows[0];
  if (p.mode === 'four_hour' || had) {
    await tx.query(
      `INSERT INTO world.day_mode (branch_id, date, mode, reason, switched_by, switched_at) VALUES ($1, $2::date, $3, $4, $5, $6)
       ON CONFLICT (branch_id, date) DO UPDATE SET mode = EXCLUDED.mode, reason = EXCLUDED.reason, switched_by = EXCLUDED.switched_by, switched_at = EXCLUDED.switched_at`,
      [p.branchId, p.date, p.mode, p.mode === 'four_hour' ? reason : '', req.caller.userId, req.demoNow.toString()]);
    await publishEvent(tx, 'settings.changed', { kind: 'day_mode', branch: p.branchId, date: p.date });
  }
  const [day] = await daysOf(tx, p.branchId, zone, p.date, p.date, await windowsOf(tx, p.branchId));
  return { ok: true, status: 200, data: { day: day! } };
};

/**
 * API-155: the 2-hour windows' limits (FR-BOOK-17, section 5.3 step 5). The booking-day locks of every upcoming day in the horizon
 * are taken first, then each new limit is checked against the most bookings that window holds on any of those days: below it, the
 * whole save is refused and nothing is written (capacity_below_bookings names the window, the day and the count).
 */
export const setWindowLimitsHandler: Handler<Out<typeof setWindowLimits>> = async (req, tx) => {
  if (req.caller.kind !== 'staff') return { ok: false, status: 401, code: 'unauthenticated' };
  const p = req.params as In<typeof setWindowLimits>;
  const zone = await branchZone(tx, p.branchId);
  if (!zone) return { ok: false, status: 404, code: 'not_found' };
  const windows = (await windowsOf(tx, p.branchId)).filter((w) => w.mode === 'two_hour');
  const byId = new Map(windows.map((w) => [w.id, w]));
  const ids = p.limits.map((l) => l.windowId);
  // A window that is not this branch's 2-hour window (a 4-hour window has no limit) or named twice is a malformed save.
  if (ids.some((id) => !byId.has(id)) || new Set(ids).size !== ids.length) return { ok: false, status: 422, code: 'validation_failed' };

  const today = dateOf(req.demoNow, zone);
  const horizon = addDays(today, OFFICE_HORIZON_DAYS);
  await lockBookingDays(tx, Array.from({ length: OFFICE_HORIZON_DAYS + 1 }, (_, i) => ({ branch: p.branchId, date: addDays(today, i) })));
  const held = await tx.query<{ window_id: string; date: string; n: string }>(
    `SELECT window_id, date::text AS date, count(*) AS n FROM world.job
      WHERE branch_id = $1 AND date BETWEEN $2::date AND $3::date AND status <> 'canceled' AND window_id = ANY($4::uuid[])
      GROUP BY window_id, date`, [p.branchId, today, horizon, ids]);
  for (const w of windows) {
    const limit = p.limits.find((l) => l.windowId === w.id)?.limit;
    if (limit === undefined) continue;
    // The day with the most bookings in the window, the earliest on a tie: the number the capacity cannot go below.
    const worst = held.rows.filter((h) => h.window_id === w.id).sort((a, b) => Number(b.n) - Number(a.n) || (a.date < b.date ? -1 : 1))[0];
    if (worst && Number(worst.n) > limit) {
      return { ok: false, status: 409, code: 'capacity_below_bookings', detail: { windowId: w.id, ...span(w), date: worst.date, bookings: Number(worst.n) } } satisfies ApiResult<never>;
    }
  }
  for (const l of p.limits) await tx.query('UPDATE world.arrival_window SET capacity = $2 WHERE id = $1', [l.windowId, l.limit]);
  await publishEvent(tx, 'settings.changed', { kind: 'window_limits', branch: p.branchId });
  return {
    ok: true,
    status: 200,
    data: { windows: (await windowsOf(tx, p.branchId)).filter((w) => w.mode === 'two_hour').map((w) => ({ windowId: w.id, ...span(w), limit: w.capacity ?? 0 })) },
  };
};
