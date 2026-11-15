// SPDX-License-Identifier: AGPL-3.0-or-later
// API-132 Board week (UI-SPECIFICATION 12.2; SPECIFICATIONS section 6.1 "Week board", SD-27; FR-DISP-23, FR-BOOK-5, FR-BOOK-9,
// FR-BOOK-18, UC-15): Monday to Saturday of one branch's week for SCR-OFC-34. Read only, in the call's transaction, from the
// same capacity functions the writes and the booking read call (@bw/domain: worksOn, technicianDayCapacity, dayRoom,
// windowRoom), so a cell's capacity cannot differ from what a write enforces.
//
//   cell     booked = the technician's live jobs that day (blocks never count); capacity = SD-27's per-technician capacity;
//            state day_off when the technician does not work the date (no shift day, time off, no Saturday that week)
//   day      booked = every cell's booked plus the day's Unassigned jobs; capacity = the working technicians' capacity
//   online   per day from today: 0 once the online cutoff passed or the day is not offered, else the smaller of dayRoom and
//            the sum of windowRoom over the offered windows (no online service has skill install, so installers never count)
import type { boardWeek } from '@bw/api';
import {
  areaName, dayKind, dayRoom, isLive, offeredWindows, technicianDayCapacity, windowRoom, worksOn,
  type DayKind, type DayMode, type TechnicianFacts,
} from '@bw/domain';
import { atLocal, Temporal, toWire } from '@bw/time';
import type { z } from 'zod';
import type { Handler } from '../types.ts';

type WeekAnswer = z.infer<typeof boardWeek.response>;

/** The online channel stops offering a day at this local time on the day before it (SPECIFICATIONS 6.1 "Online cutoff", FR-BOOK-9). */
export const ONLINE_CUTOFF_LOCAL = '17:00';

interface TechRow {
  id: string; name: string; van: string | null; skills: string[]; primary_skill: string; installer: boolean;
  working_days: number[]; saturdays: TechnicianFacts['saturdays']; time_off: { from: string; to: string }[];
}
interface JobRow {
  job_number: number; date: string; technician_id: string | null; status: string; window_id: string; window_start: Date; window_end: Date;
  install: boolean; customer: string; city: string; zip: string; service_id: string;
}
interface WindowRow { id: string; mode: DayMode; start_local: string; end_local: string; capacity: number | null }
interface ModeRow { date: string; mode: DayMode; reason: string; switched_by_name: string | null; switched_at: Date }

const instant = (d: Date): Temporal.Instant => Temporal.Instant.fromEpochMilliseconds(d.getTime());
const hhmm = (t: string): string => t.slice(0, 5);

export const boardWeekHandler: Handler<WeekAnswer> = async (req, tx) => {
  const { branch, week } = req.params as { branch: string; week: string };
  const b = await tx.query<{ zone: string }>('SELECT zone FROM world.branch WHERE id = $1', [branch]);
  const zone = b.rows[0]?.zone;
  if (!zone) return { ok: false, status: 404, code: 'not_found' };

  const monday = Temporal.PlainDate.from(week);
  const dates = Array.from({ length: 6 }, (_, i) => monday.add({ days: i }).toString());
  const today = req.demoNow.toZonedDateTimeISO(zone).toPlainDate().toString();

  const techs = await tx.query<TechRow>(
    `SELECT t.id, t.name, v.number AS van, t.skills, t.primary_skill, t.installer, t.working_days, t.saturdays,
            coalesce((SELECT json_agg(json_build_object('from', o.from_date, 'to', o.to_date)) FROM world.time_off o
                       WHERE o.technician_id = t.id), '[]'::json) AS time_off
       FROM world.technician t LEFT JOIN world.van v ON v.id = t.van_id
      WHERE t.branch_id = $1
      ORDER BY substring(t.name from '[^ ]+$'), t.name, t.id`, [branch]);
  const jobs = await tx.query<JobRow>(
    `SELECT j.job_number, j.date::text AS date, j.technician_id, j.status, j.window_id, j.window_start, j.window_end,
            s.skill = 'install' AS install, c.name AS customer, st.city, st.zip, j.service_id
       FROM world.job j
       JOIN world.service_type s ON s.id = j.service_id
       JOIN world.customer c ON c.id = j.customer_id
       JOIN world.street st ON st.id = c.street_id
      WHERE j.branch_id = $1 AND j.date BETWEEN $2::date AND $3::date
      ORDER BY j.date, j.window_start, j.job_number`, [branch, dates[0], dates[5]]);
  const windows = await tx.query<WindowRow>(
    'SELECT id, mode, start_local::text AS start_local, end_local::text AS end_local, capacity FROM world.arrival_window WHERE branch_id = $1', [branch]);
  const modes = await tx.query<ModeRow>(
    `SELECT d.date::text AS date, d.mode, d.reason, u.name AS switched_by_name, d.switched_at
       FROM world.day_mode d LEFT JOIN world."user" u ON u.id = d.switched_by
      WHERE d.branch_id = $1 AND d.date BETWEEN $2::date AND $3::date`, [branch, dates[0], dates[5]]);

  const facts: (TechRow & TechnicianFacts)[] = techs.rows.map((t) => ({ ...t, workingDays: t.working_days, timeOff: t.time_off }));
  const live = jobs.rows.filter((j) => isLive(j.status));
  const modeOf = new Map(modes.rows.map((m) => [m.date, m]));

  const days: WeekAnswer['days'] = [];
  const cellsByTech = new Map<string, WeekAnswer['technicians'][number]['cells']>(facts.map((t) => [t.id, []]));
  const unassigned: WeekAnswer['unassigned'] = [];

  for (const date of dates) {
    const row = modeOf.get(date);
    const mode: DayMode = row?.mode ?? 'two_hour';
    const kind: DayKind = dayKind(date, mode);
    const dayJobs = live.filter((j) => j.date === date);
    let booked = 0;
    let capacity = 0;
    for (const t of facts) {
      const mine = dayJobs.filter((j) => j.technician_id === t.id);
      const works = worksOn(t, date);
      const cap = works ? technicianDayCapacity(t, kind) : 0;
      cellsByTech.get(t.id)!.push({
        date, booked: mine.length, capacity: cap, installs: mine.filter((j) => j.install).length,
        state: !works ? 'day_off' : mine.length >= cap ? 'full' : 'has_room',
      });
      if (works) {
        booked += mine.length;
        capacity += cap;
      }
    }
    const none = dayJobs.filter((j) => j.technician_id === null).length;
    unassigned.push({ date, count: none });

    // FR-BOOK-9, SD-27: what the booking site still accepts that day.
    let openOnline = 0;
    if (date >= today && kind !== 'sunday') {
      const cutoff = atLocal(monday.add({ days: dates.indexOf(date) - 1 }).toString(), ONLINE_CUTOFF_LOCAL, zone, 'compatible');
      if (req.demoNow.epochMilliseconds < cutoff.epochMilliseconds) {
        const room = dayRoom({
          kind, working: facts.filter((t) => worksOn(t, date)), serviceIsInstall: false, liveJobs: dayJobs.map((j) => ({ install: j.install })),
        });
        const sum = offeredWindows(windows.rows.map((w) => ({ ...w, startLocal: w.start_local })), kind)
          .reduce((n, w) => n + windowRoom({ windowCapacity: w.capacity, windowLiveJobs: dayJobs.filter((j) => j.window_id === w.id).length, dayRoom: room }), 0);
        openOnline = Math.min(room, sum);
      }
    }

    const offered = offeredWindows(windows.rows.map((w) => ({ ...w, startLocal: w.start_local })), kind);
    const ends = offered.map((w) => hhmm(w.end_local)).sort();
    const starts = offered.map((w) => hhmm(w.start_local)).sort();
    days.push({
      date, mode, booked: booked + none, capacity, peak: mode === 'four_hour', openOnline,
      span: kind === 'saturday' && starts.length > 0 ? { start: starts[0]!, end: ends[ends.length - 1]! } : null,
      unassigned: none,
      reason: mode === 'four_hour' ? (row?.reason ?? null) : null,
      switchedBy: mode === 'four_hour' ? (row?.switched_by_name ?? null) : null,
      switchedAt: mode === 'four_hour' && row ? toWire(instant(row.switched_at), zone) : null,
    });
  }

  return {
    ok: true,
    status: 200,
    data: {
      branch, week, today, days,
      fourHourWindows: windows.rows.filter((w) => w.mode === 'four_hour').map((w) => ({ start: hhmm(w.start_local), end: hhmm(w.end_local) }))
        .sort((a, b) => (a.start < b.start ? -1 : 1)),
      technicians: facts.map((t) => ({
        id: t.id, name: t.name, van: t.van, skills: t.skills, primarySkill: t.primary_skill, installer: t.installer, cells: cellsByTech.get(t.id)!,
      })),
      unassigned,
      unassignedJobs: live.filter((j) => j.technician_id === null).map((j) => ({
        jobNumber: j.job_number, day: j.date, customer: j.customer, area: areaName(j.city, j.zip), service: j.service_id,
        window: { start: toWire(instant(j.window_start), zone), end: toWire(instant(j.window_end), zone) },
      })),
    },
  };
};
