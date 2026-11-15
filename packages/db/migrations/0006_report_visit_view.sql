-- P2-SCHEMA. The `report_visit` projection view of SPECIFICATIONS SD-25 (section 3 "Projection view"): never written,
-- read only by the report contracts (API-50, API-51) and the board's 7-day on-time rate (FR-REP-4, OI-25).
-- Forward-only (SD-40): a later change is CREATE OR REPLACE VIEW in a new file that only appends columns.
--
-- Rows (SD-25):
--   1. past_visit rows dated Jun 1 to Aug 30, 2026 (the generated pilot history);
--   2. seeded job rows with pilot = true, ended as done or no_one_home (Mon, Aug 31 to Mon, Sep 14);
--   3. for no-one-home counts only, live jobs with status no_one_home dated Sep 15, 2026 or later.
-- Derived columns (section 6.5): on_time = arrival at or before the window's end, null with no arrival (FR-REP-1);
-- minutes_late over late visits only (FR-REP-7); week_start = the ISO week's Monday of the local date, which is
-- already a date in the branch zone (`zone`), so no time-zone arithmetic happens here (invariant 4).

CREATE VIEW world.report_visit AS
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
   WHERE NOT j.pilot AND j.status = 'no_one_home' AND j.date >= DATE '2026-09-15'
)
SELECT source, past_visit_id, job_number, branch_id, technician_id, technician_name, customer_id, date, zone,
       (date - (extract(isodow FROM date)::integer - 1)) AS week_start,
       window_start, window_end, arrived_at, outcome,
       CASE WHEN arrived_at IS NULL THEN NULL ELSE arrived_at <= window_end END AS on_time,
       CASE WHEN arrived_at > window_end THEN extract(epoch FROM arrived_at - window_end) / 60 END AS minutes_late,
       pilot, no_one_home_only
  FROM visit;
