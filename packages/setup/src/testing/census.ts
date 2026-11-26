// SPDX-License-Identifier: AGPL-3.0-or-later
// The chain census as it reads the written world (owner answer 36d87aec, F-513): the consecutive scripted visits of each
// technician-day, in the order of the day's plan (SD-15), from the seeded autopilot.step rows. Read by setup.db.test.ts
// (the fresh setup, on the baked tracks only when MAPS_DIR is set) and ci/board-stack/board.stack.ts (the stack's setup,
// the real tracks). `source` is the events table to read.
export const chainCensusSql = (source = 'world.scheduled_event'): string => `
  WITH step AS (
    SELECT (payload->>'jobNumber')::int AS n, payload->>'step' AS step, due_at FROM ${source} WHERE kind = 'autopilot.step'
  ), visit AS (
    SELECT j.technician_id, j.date, j.window_start, j.booked_at, j.job_number,
           (SELECT due_at FROM step s WHERE s.n = j.job_number AND s.step = 'on_my_way') AS on_my_way,
           (SELECT due_at FROM step s WHERE s.n = j.job_number AND s.step = 'arrived') AS arrived,
           (SELECT due_at FROM step s WHERE s.n = j.job_number AND s.step IN ('finished', 'no_one_home')) AS ended
      FROM world.job j WHERE j.job_number IN (SELECT n FROM step)
  ), pair AS (
    SELECT on_my_way, arrived,
           lag(ended) OVER (PARTITION BY technician_id, date ORDER BY window_start, booked_at, job_number) AS before_end
      FROM visit
  )
  SELECT count(*)::int AS pairs,
         count(*) FILTER (WHERE on_my_way < before_end)::int AS left_during_visit,
         count(*) FILTER (WHERE arrived < before_end)::int AS on_site_at_two
    FROM pair WHERE before_end IS NOT NULL`;
