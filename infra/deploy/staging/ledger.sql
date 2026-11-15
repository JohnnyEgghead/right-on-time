-- SPDX-License-Identifier: AGPL-3.0-or-later
-- G-IPHONE-WEB: the server's ledger for the scripted iPhone run, as 1 line of JSON for infra/deploy/staging/ledger-check.ts.
-- The run works Harold Jenkins's 10 AM-12 PM job on Tue, Sep 15, 2026, Maria Santos's (the visitor's job: no autopilot step ever touches
-- it, SPECIFICATIONS SD-21), so every ledger row on that job comes from the phone. Read-only. Run as the schema owner:
--   psql -q -t -A -U brightwater -d brightwater -v ON_ERROR_STOP=1 -f ledger.sql
-- items: every world.tech_item row (the idempotency ledger, SPECIFICATIONS section 3) on the job, in arrival order, with what each
-- kind left in its own table: a note's world.note rows under its key (and whether the server judged it entered offline, FR-DEMO-9),
-- a photo's world.photo rows under its key. A note or photo the server never got has no row; one that arrived twice under 2 keys has 2.
WITH job AS (
  SELECT j.job_number
    FROM world.job j
    JOIN world.customer c ON c.id = j.customer_id
    JOIN world.technician t ON t.id = j.technician_id
   WHERE c.name = 'Harold Jenkins' AND t.name = 'Maria Santos' AND j.date = DATE '2026-09-15'
)
SELECT json_build_object(
  'jobs', COALESCE((SELECT json_agg(job_number ORDER BY job_number) FROM job), '[]'::json),
  'items', COALESCE((
    SELECT json_agg(json_build_object(
             'key', i.key,
             'kind', i.kind,
             'jobNumber', i.job_number,
             'result', i.result,
             'technician', t.name,
             'deviceTimeReal', to_char(i.device_time_real AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'receivedAtDemo', to_char(i.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'noteRows', (SELECT count(*) FROM world.note n WHERE n.item_key = i.key),
             'noteOffline', (SELECT bool_and(n.entered_offline) FROM world.note n WHERE n.item_key = i.key),
             'noteText', (SELECT min(n.body) FROM world.note n WHERE n.item_key = i.key),
             'photoRows', (SELECT count(*) FROM world.photo p WHERE p.key = i.key),
             'photoBytes', (SELECT min(p.bytes) FROM world.photo p WHERE p.key = i.key)
           ) ORDER BY i.received_at, i.device_time_real, i.key)
      FROM world.tech_item i
      LEFT JOIN world.technician t ON t.id = i.technician_id
     WHERE i.job_number IN (SELECT job_number FROM job)
  ), '[]'::json)
);
