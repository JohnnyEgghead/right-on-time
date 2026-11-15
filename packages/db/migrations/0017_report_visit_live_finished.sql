-- P4-REPORTS fix pass (F-736). REQUIREMENTS SC-02's no-one-home population is the completed visits of the simulated pilot data
-- "together with the live visits that were finished or recorded as No one home" (OA-58), and REQUIREMENTS outranks SD-25 (the MD-5 rule).
-- Row 3 of the view (migration 0006) now holds both kinds of live visit dated Sep 15, 2026 or later, each with no_one_home_only = true:
--   no_one_home  counts in the no-one-home count and its denominator, as before (FR-REP-2);
--   done         counts in that denominator and nowhere else: on time, minutes late, the per-day figure, the visits the page lists, the
--                by-technician table and the export all leave it out (API-50, API-51 in handlers/reports.ts; the board's rate in handlers/board.ts).
-- Forward-only (SD-40): CREATE OR REPLACE VIEW with migration 0006's column list, order and types, nothing dropped. Grants stay with the view.

CREATE OR REPLACE VIEW world.report_visit AS
WITH visit AS (
  SELECT 'past_visit'::text AS source, pv.id AS past_visit_id, NULL::integer AS job_number, c.branch_id,
         pv.technician_id, pv.technician_name, pv.customer_id, pv.date, pv.zone, pv.window_start, pv.window_end,
         pv.arrived_at, pv.outcome, true AS pilot, false AS no_one_home_only
    FROM world.past_visit pv
    JOIN world.customer c ON c.id = pv.customer_id
   WHERE pv.date BETWEEN DATE '2026-06-01' AND DATE '2026-08-30'
  UNION ALL
  SELECT 'job', NULL::uuid, j.job_number, j.branch_id, j.technician_id, t.name, j.customer_id, j.date, j.zone,
         j.window_start, j.window_end, j.arrived_at, j.status, true, false
    FROM world.job j
    LEFT JOIN world.technician t ON t.id = j.technician_id
   WHERE j.pilot AND j.status IN ('done', 'no_one_home')
  UNION ALL
  SELECT 'job', NULL::uuid, j.job_number, j.branch_id, j.technician_id, t.name, j.customer_id, j.date, j.zone,
         j.window_start, j.window_end, j.arrived_at, j.status, false, true
    FROM world.job j
    LEFT JOIN world.technician t ON t.id = j.technician_id
   WHERE NOT j.pilot AND j.status IN ('done', 'no_one_home') AND j.date >= DATE '2026-09-15'
)
SELECT source, past_visit_id, job_number, branch_id, technician_id, technician_name, customer_id, date, zone,
       (date - (extract(isodow FROM date)::integer - 1)) AS week_start,
       window_start, window_end, arrived_at, outcome,
       CASE WHEN arrived_at IS NULL THEN NULL ELSE arrived_at <= window_end END AS on_time,
       CASE WHEN arrived_at > window_end THEN extract(epoch FROM arrived_at - window_end) / 60 END AS minutes_late,
       pilot, no_one_home_only
  FROM visit;
