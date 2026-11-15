// SPDX-License-Identifier: AGPL-3.0-or-later
// The report_visit projection view (SD-25): which rows it holds and the derived columns the reports read.
import { describe, expect, it } from 'vitest';
import { insertJob, seedReference, useMigratedDatabase } from './testing/fixture.ts';

const db = useMigratedDatabase();

interface ReportRow {
  source: string; past_visit_id: string | null; job_number: number | null; branch_id: string; technician_name: string | null;
  date: string; week_start: string; on_time: boolean | null; minutes_late: string | null; outcome: string; pilot: boolean; no_one_home_only: boolean;
}

describe('report_visit (SD-25)', () => {
  // why: FR-REP-4 and SC-02 the population is the pilot's ended visits plus the live visits finished or recorded as No one home, from Sep 15 only
  it('holds pilot past visits of Jun 1 to Aug 30, pilot jobs that ended, and live ended jobs from Sep 15 only', async () => {
    await db.asRole('app', async (q) => {
      const ref = await seedReference(q);
      const visit = (date: string, arrived: string | null, outcome: string) => q.query(`INSERT INTO world.past_visit
        (customer_id, technician_name, technician_id, date, zone, window_start, window_end, arrived_at, outcome, service_text, source_ref)
        VALUES ($1, 'Maria Santos', $2, $3::date, 'America/New_York', ($3::text || 'T08:00:00-04:00')::timestamptz,
                ($3::text || 'T10:00:00-04:00')::timestamptz, $4, $5, 'Tune-up', 'old-1')`, [ref.customerId, ref.technicianId, date, arrived, outcome]);
      await visit('2026-05-31', '2026-05-31T09:00:00-04:00', 'done'); // before the window: out
      await visit('2026-06-01', '2026-06-01T09:59:00-04:00', 'done'); // in, on time
      await visit('2026-08-30', '2026-08-30T10:30:00-04:00', 'done'); // in, 30 minutes late
      await visit('2026-08-31', '2026-08-31T09:00:00-04:00', 'done'); // after the window: out (a job from Aug 31, SD-24)
      const pilotDone = await insertJob(q, ref, { date: '2026-09-08', pilot: true, status: 'done', technician_id: ref.technicianId,
        window_start: '2026-09-08T08:00:00-04:00', window_end: '2026-09-08T10:00:00-04:00', arrived_at: '2026-09-08T10:00:00-04:00' });
      await insertJob(q, ref, { date: '2026-09-09', pilot: true, status: 'canceled' }); // a pilot job that never ended: out
      const liveNoOne = await insertJob(q, ref, { date: '2026-09-15', status: 'no_one_home' });
      await insertJob(q, ref, { date: '2026-09-14', status: 'no_one_home' }); // live, before Sep 15: out
      await insertJob(q, ref, { date: '2026-09-14', status: 'done' }); // live, before Sep 15: out
      const liveDone = await insertJob(q, ref, { date: '2026-09-16', status: 'done' }); // live and finished: in, for the no-one-home denominator only (SC-02)
      await insertJob(q, ref, { date: '2026-09-16', status: 'canceled' }); // live and never finished: out
      await insertJob(q, ref, { date: '2026-09-16', status: 'scheduled' }); // live and not ended: out

      const rows = (await q.query<ReportRow>('SELECT * FROM world.report_visit ORDER BY date')).rows;
      expect(rows.map((r) => [r.source, r.date, r.outcome, r.pilot, r.no_one_home_only])).toEqual([
        ['past_visit', '2026-06-01', 'done', true, false],
        ['past_visit', '2026-08-30', 'done', true, false],
        ['job', '2026-09-08', 'done', true, false],
        ['job', '2026-09-15', 'no_one_home', false, true],
        ['job', '2026-09-16', 'done', false, true],
      ]);
      expect(rows[2]?.job_number).toBe(pilotDone);
      expect(rows[2]?.technician_name).toBe('Maria Santos');
      expect(rows[3]?.job_number).toBe(liveNoOne);
      expect(rows[4]?.job_number).toBe(liveDone);
      expect(rows.every((r) => r.branch_id === 'columbus')).toBe(true);
    });
  });

  // why: FR-REP-1
  it('derives on time (arrival at or before the window end), minutes late and the ISO week Monday', async () => {
    await db.asRole('app', async (q) => {
      const ref = await seedReference(q);
      const visit = (date: string, arrived: string | null, outcome: string) => q.query(`INSERT INTO world.past_visit
        (customer_id, technician_name, date, zone, window_start, window_end, arrived_at, outcome, service_text, source_ref)
        VALUES ($1, 'Kevin Doyle', $2::date, 'America/New_York', ($2::text || 'T08:00:00-04:00')::timestamptz,
                ($2::text || 'T10:00:00-04:00')::timestamptz, $3, $4, 'Repair', 'old-2')`, [ref.customerId, date, arrived, outcome]);
      await visit('2026-07-13', '2026-07-13T10:00:00-04:00', 'done'); // a Monday, exactly at the window end: on time
      await visit('2026-07-19', '2026-07-19T10:45:30-04:00', 'done'); // a Sunday, 45.5 minutes late
      await visit('2026-07-15', null, 'no_one_home'); // no arrival: not counted on time or late
      const rows = (await q.query<ReportRow>('SELECT * FROM world.report_visit ORDER BY date')).rows;
      expect(rows.map((r) => [r.date, r.week_start, r.on_time, r.minutes_late === null ? null : Number(r.minutes_late)])).toEqual([
        ['2026-07-13', '2026-07-13', true, null],
        ['2026-07-15', '2026-07-13', null, null],
        ['2026-07-19', '2026-07-13', false, 45.5],
      ]);
    });
  });
});
