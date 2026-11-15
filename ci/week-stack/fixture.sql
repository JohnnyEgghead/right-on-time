-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The week board stack suite's fixture rows (ci/shell-stack.sh loads them after the shell suite's fixture rows, on the same stack).
-- The default stack holds the migrated schema and the shell fixture only (1 branch, 2 customers, 1 office user and 1 job on Tue,
-- Sep 15), so this adds what API-132 reads for the week of Sep 14: 12 Columbus technicians with vans and skills, the arrival
-- windows, the 2 sample peak days (Wed, Sep 16 and Fri, Sep 18, "Heat advisory", switched by Dana Ruiz), about 280 live jobs spread
-- over the technicians' days, and 1 more unassigned job. Loads of the technicians follow the Week frame's sample week
-- (mockups/pages/office-board-week.html). Needs ci/shell-stack/fixture.sql loaded first.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO world."user" (email, name, name_search, role, branch_id, language, status, slash_shortcut, sample, reviewer)
VALUES ('dana.ruiz@example.test', 'Dana Ruiz', 'dana ruiz', 'manager', 'columbus', 'en', 'active', true, true, false);

-- name, van, primary skill, installer, Saturdays, working days, jobs booked Mon to Sat
CREATE TEMP TABLE week_tech (name text, van text, skill text, installer boolean, sat text, wd int[], load int[]) ON COMMIT DROP;
INSERT INTO week_tech VALUES
  ('Marcus Bell',    '21', 'plumbing',        false, 'none',       '{1,2,3,4,5}', '{5,5,6,4,6,0}'),
  ('Jamal Carter',   '9',  'plumbing',        false, 'even_weeks', '{1,2,3,4,5}', '{4,4,5,3,5,3}'),
  ('Kevin Doyle',    '27', 'plumbing',        false, 'none',       '{1,2,3,4,5}', '{5,4,5,4,6,0}'),
  ('Greg Hoffman',   '5',  'plumbing',        false, 'even_weeks', '{1,2,3,4,5}', '{5,4,6,2,6,3}'),
  ('Dave Kowalski',  '7',  'heating_cooling', false, 'none',       '{1,2,3,4,5}', '{5,5,6,4,5,0}'),
  ('Ryan Mitchell',  '11', 'heating_cooling', false, 'even_weeks', '{1,2,3,4,5}', '{4,4,5,3,6,2}'),
  ('Ashley Nguyen',  '24', 'heating_cooling', false, 'none',       '{1,2,3,4,5}', '{5,4,5,4,6,0}'),
  ('Luis Ortega',    '18', 'heating_cooling', false, 'even_weeks', '{1,2,3,4,5}', '{5,4,6,3,5,3}'),
  ('Tom Reinhart',   '3',  'heating_cooling', false, 'none',       '{1,2,3,4,5}', '{4,4,5,2,6,0}'),
  ('Maria Santos',   '12', 'heating_cooling', false, 'even_weeks', '{1,2,3,4,5}', '{5,5,6,4,6,2}'),
  ('Brian Schaefer', '15', 'heating_cooling', false, 'none',       '{1,2,3,4,5}', '{5,5,6,3,5,0}'),
  ('Chris Yoder',    '30', 'install',         true,  'none',       '{1,2,3,4}',   '{1,1,1,1,0,0}');

INSERT INTO world."user" (email, name, name_search, role, branch_id, language, status, slash_shortcut, employee_number, sample, reviewer)
SELECT lower(replace(name, ' ', '.')) || '@example.test', name, lower(name), 'technician', 'columbus', 'en', 'active', true, '01' || lpad(van, 2, '0'), true, false
  FROM week_tech;
INSERT INTO world.van (branch_id, number, vehicle) SELECT 'columbus', van, 'Van ' || van FROM week_tech;
INSERT INTO world.technician (user_id, branch_id, name, name_in_texts, phone, primary_skill, skills, installer, van_id, shift_start, shift_end, working_days, saturdays, since)
SELECT u.id, 'columbus', w.name, split_part(w.name, ' ', 1), '(614) 555-01' || lpad(w.van, 2, '0'), w.skill, ARRAY[w.skill], w.installer, v.id,
       '08:00', '17:30', w.wd, w.sat, DATE '2020-01-01'
  FROM week_tech w
  JOIN world."user" u ON u.email = lower(replace(w.name, ' ', '.')) || '@example.test'
  JOIN world.van v ON v.number = w.van AND v.branch_id = 'columbus';

INSERT INTO world.service_type (id, screen_label_key, text_label_key, price_text_key, typical_length_key, invoice_price_cents, job_type,
                                expected_minutes, skill, bookable_online)
VALUES ('heating_or_ac_fix', 's.k', 'service.heating_or_ac_fix.text', 'p.k', 'l.k', 0, 'repair', 90, 'heating_cooling', true),
       ('sump_pump_install', 's.k', 'service.sump_pump_install.text', 'p.k', 'l.k', 0, 'install', 240, 'install', false);
-- F-917: text_label_key is a shipped catalog key (a confirmation's {service} slot reads it on a stack, which has no test catalog).

INSERT INTO world.arrival_window (branch_id, mode, start_local, end_local, label_key, capacity)
VALUES ('columbus', 'two_hour', '10:00', '12:00', 'w.10', 12), ('columbus', 'two_hour', '12:00', '14:00', 'w.12', 12),
       ('columbus', 'two_hour', '14:00', '16:00', 'w.14', 12), ('columbus', 'two_hour', '16:00', '18:00', 'w.16', 12),
       ('columbus', 'four_hour', '08:00', '12:00', 'w.f8', NULL), ('columbus', 'four_hour', '10:00', '14:00', 'w.f10', NULL),
       ('columbus', 'four_hour', '12:00', '16:00', 'w.f12', NULL), ('columbus', 'four_hour', '14:00', '18:00', 'w.f14', NULL);

INSERT INTO world.day_mode (branch_id, date, mode, reason, switched_by, switched_at)
SELECT 'columbus', d, 'four_hour', 'Heat advisory', (SELECT id FROM world."user" WHERE email = 'dana.ruiz@example.test'), TIMESTAMPTZ '2026-09-14T20:10:00Z'
  FROM unnest(ARRAY[DATE '2026-09-16', DATE '2026-09-18']) AS d;

-- The jobs: each technician-day books its load, spread over the day's windows in turn (5 two-hour windows or 4 four-hour ones),
-- so no window passes SD-27's per-window limit. An installer's jobs are installs.
-- The shell fixture wrote job 24800 by number; the identity counter has not seen it, so move it past.
SELECT setval(pg_get_serial_sequence('world.job', 'job_number'), 24800);
CREATE TEMP TABLE week_win ON COMMIT DROP AS
  SELECT id, mode, start_local, end_local, row_number() OVER (PARTITION BY mode ORDER BY start_local) - 1 AS idx FROM world.arrival_window WHERE branch_id = 'columbus';
INSERT INTO world.job (customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, technician_id, status, version,
                       expected_minutes, booked_via, booked_at, billing_state, autopilot, touched_by_person, pilot)
SELECT CASE WHEN k % 2 = 0 THEN '0192f000-0000-7000-8000-00000000c001'::uuid ELSE '0192f000-0000-7000-8000-00000000c002'::uuid END,
       'columbus', CASE WHEN w.installer THEN 'sump_pump_install' ELSE 'heating_or_ac_fix' END, day, 'America/New_York', win.id,
       (day + win.start_local) AT TIME ZONE 'America/New_York', (day + win.end_local) AT TIME ZONE 'America/New_York', t.id, 'scheduled', 1,
       CASE WHEN w.installer THEN 240 ELSE 90 END, 'office', TIMESTAMPTZ '2026-09-10T12:00:00Z', 'not_sent', false, false, false
  FROM week_tech w
  JOIN world.technician t ON t.name = w.name
  CROSS JOIN LATERAL generate_series(0, 5) AS d(i)
  CROSS JOIN LATERAL (SELECT DATE '2026-09-14' + d.i AS day) AS dd
  CROSS JOIN LATERAL generate_series(1, w.load[d.i + 1]) AS g(k)
  JOIN week_win win ON win.mode = CASE WHEN d.i IN (2, 4) THEN 'four_hour' ELSE 'two_hour' END
                   AND win.idx = (g.k - 1) % CASE WHEN d.i IN (2, 4) THEN 4 ELSE 5 END;

-- 1 more job with no technician, on Thu, Sep 17 (the shell fixture's job 24800 is the Tue one).
INSERT INTO world.job (customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, status, version,
                       expected_minutes, booked_via, booked_at, billing_state, autopilot, touched_by_person, pilot)
SELECT '0192f000-0000-7000-8000-00000000c002', 'columbus', 'heating_or_ac_fix', DATE '2026-09-17', 'America/New_York', id,
       (DATE '2026-09-17' + start_local) AT TIME ZONE 'America/New_York', (DATE '2026-09-17' + end_local) AT TIME ZONE 'America/New_York',
       'scheduled', 1, 90, 'office', TIMESTAMPTZ '2026-09-10T12:00:00Z', 'not_sent', false, false, false
  FROM week_win WHERE mode = 'two_hour' AND idx = 1;

COMMIT;
