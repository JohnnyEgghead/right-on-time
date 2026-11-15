-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The Technicians page stack suite's fixture rows (ci/shell-stack.sh loads them after the customers suite's fixture rows, on the same stack, before the clock
-- banner suite, which jumps the clock). The default stack holds the migrated schema and the shell fixture, then the earlier suites' rows; this adds what API-31
-- reads: 2 technicians (their names sort last, so the earlier suites' rows keep their places) each with a van, one with a phone app that is waiting to send and
-- one job on the way today, a manager with a session, 4 customers and 5 jobs: 2 booked for Mon, Sep 21 with the first technician and 2 for Tue, Sep 22 with
-- the second (the suite records time off over them once per engine, so each engine has its own pair). Then 2 technicians who are off on Tuesdays, 1 job each on
-- Mon, Sep 21 (the hours editor's case, 1 technician per engine) and the first one's own session (the real API-162 report); the Dayton branch, for Add
-- technician to another branch; and 1 open alert, which the bell must count on this page.
-- Needs ci/shell-stack/fixture.sql loaded first (the street, the arrival window b001 and the clock row) and ci/jobs-stack/fixture.sql (the service types).
-- psql variables: :token_manager, :token_tech (the first technician's own session, for the role check), :token_sync (Zoe Zuber's own session, for API-162).
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO world."user" (id, email, name, name_search, role, branch_id, language, status, slash_shortcut, employee_number, sample, reviewer)
VALUES ('0192f000-0000-7000-8000-00000000d201', 'zack.zeller@example.test', 'Zack Zeller', 'zack zeller', 'technician', 'columbus', 'en', 'active', true, '0201', true, false),
       ('0192f000-0000-7000-8000-00000000d202', 'zara.zinn@example.test', 'Zara Zinn', 'zara zinn', 'technician', 'columbus', 'en', 'active', true, '0202', true, false),
       ('0192f000-0000-7000-8000-00000000d204', 'zoe.zuber@example.test', 'Zoe Zuber', 'zoe zuber', 'technician', 'columbus', 'en', 'active', true, '0204', true, false),
       ('0192f000-0000-7000-8000-00000000d205', 'zeke.zuber@example.test', 'Zeke Zuber', 'zeke zuber', 'technician', 'columbus', 'en', 'active', true, '0205', true, false);
INSERT INTO world."user" (id, email, name, name_search, role, branch_id, language, status, slash_shortcut, sample, reviewer)
VALUES ('0192f000-0000-7000-8000-00000000d203', 'technicians.manager@example.test', 'Tess Mangold', 'tess mangold', 'manager', 'columbus', 'en', 'active', true, true, false);
INSERT INTO world.van (id, branch_id, number, vehicle)
VALUES ('0192f000-0000-7000-8000-00000000e201', 'columbus', 'T1', 'Van T1'), ('0192f000-0000-7000-8000-00000000e202', 'columbus', 'T2', 'Van T2'),
       ('0192f000-0000-7000-8000-00000000e203', 'columbus', 'T3', 'Van T3'), ('0192f000-0000-7000-8000-00000000e204', 'columbus', 'T4', 'Van T4');
INSERT INTO world.technician (id, user_id, branch_id, name, name_in_texts, phone, primary_skill, skills, installer, van_id, shift_start, shift_end, working_days, saturdays, since)
VALUES ('0192f000-0000-7000-8000-00000000f201', '0192f000-0000-7000-8000-00000000d201', 'columbus', 'Zack Zeller', 'Zack', '(614) 555-0196', 'heating_cooling', ARRAY['heating_cooling'], false,
        '0192f000-0000-7000-8000-00000000e201', '08:00', '17:30', '{1,2,3,4,5}', 'none', DATE '2019-03-04'),
       ('0192f000-0000-7000-8000-00000000f202', '0192f000-0000-7000-8000-00000000d202', 'columbus', 'Zara Zinn', 'Zara', '(614) 555-0197', 'plumbing', ARRAY['plumbing'], false,
        '0192f000-0000-7000-8000-00000000e202', '07:30', '18:00', '{1,2,3,4}', 'even_weeks', DATE '2021-08-16'),
       ('0192f000-0000-7000-8000-00000000f204', '0192f000-0000-7000-8000-00000000d204', 'columbus', 'Zoe Zuber', 'Zoe', '(614) 555-0194', 'heating_cooling', ARRAY['heating_cooling'], false,
        '0192f000-0000-7000-8000-00000000e203', '08:00', '17:30', '{1,3,5}', 'none', DATE '2022-02-14'),
       ('0192f000-0000-7000-8000-00000000f205', '0192f000-0000-7000-8000-00000000d205', 'columbus', 'Zeke Zuber', 'Zeke', '(614) 555-0193', 'heating_cooling', ARRAY['heating_cooling'], false,
        '0192f000-0000-7000-8000-00000000e204', '08:00', '17:30', '{1,3,5}', 'none', DATE '2022-02-14');

-- The first technician's web app last reported at 10:22 AM, with 3 items waiting to send (API-162's row, which API-31 reads back).
INSERT INTO world.app_sync_report (technician_id, app, last_sync_real, waiting_count, device, version, reported_at)
VALUES ('0192f000-0000-7000-8000-00000000f201', 'web', TIMESTAMPTZ '2026-09-15T14:22:00Z', 3, 'Safari on iPhone', '1.0.1', TIMESTAMPTZ '2026-09-15T14:22:30Z');

INSERT INTO world.customer (id, branch_id, name, name_search, mobile, home_phone, texts_on, text_language, zone, street_id, house_number, lon, lat,
                            customer_since, source, status, inbox_token)
VALUES ('0192f000-0000-7000-8000-00000000c201', 'columbus', 'Imogen Pratt', 'imogen pratt', NULL, NULL, false, 'en', 'America/New_York',
        '0192f000-0000-7000-8000-00000000a001', 201, -83.0, 39.96, '2020-05-01', 'office', 'active', 'techstackinboxtoken01'),
       ('0192f000-0000-7000-8000-00000000c202', 'columbus', 'Bram Okafor', 'bram okafor', NULL, NULL, false, 'en', 'America/New_York',
        '0192f000-0000-7000-8000-00000000a001', 202, -83.0, 39.96, '2020-05-01', 'office', 'active', 'techstackinboxtoken02'),
       ('0192f000-0000-7000-8000-00000000c203', 'columbus', 'Nell Vance', 'nell vance', NULL, NULL, false, 'en', 'America/New_York',
        '0192f000-0000-7000-8000-00000000a001', 203, -83.0, 39.96, '2020-05-01', 'office', 'active', 'techstackinboxtoken03'),
       ('0192f000-0000-7000-8000-00000000c204', 'columbus', 'Otis Lund', 'otis lund', NULL, NULL, false, 'en', 'America/New_York',
        '0192f000-0000-7000-8000-00000000a001', 204, -83.0, 39.96, '2020-05-01', 'office', 'active', 'techstackinboxtoken04');

-- number, customer, service, day, window start, window end, technician, status
INSERT INTO world.job (job_number, customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, technician_id, status, version,
                       expected_minutes, booked_via, booked_at, booked_by, billing_state, on_the_way_at, autopilot, touched_by_person, pilot)
SELECT j.n, j.c::uuid, 'columbus', j.service, j.day::date, 'America/New_York', '0192f000-0000-7000-8000-00000000b001',
       (j.day::date + j.wstart::time) AT TIME ZONE 'America/New_York', (j.day::date + j.wend::time) AT TIME ZONE 'America/New_York',
       j.tech::uuid, j.status, 1, 60, 'office', TIMESTAMPTZ '2026-09-10T12:00:00Z', '0192f000-0000-7000-8000-00000000d001', 'not_sent',
       CASE WHEN j.status = 'on_the_way' THEN TIMESTAMPTZ '2026-09-15T14:30:00Z' ELSE NULL END, false, false, false
  FROM (VALUES
    (27001, '0192f000-0000-7000-8000-00000000c201', 'furnace_tune_up', '2026-09-21', '10:00', '12:00', '0192f000-0000-7000-8000-00000000f201', 'scheduled'),
    (27002, '0192f000-0000-7000-8000-00000000c202', 'ac_tune_up',      '2026-09-21', '14:00', '16:00', '0192f000-0000-7000-8000-00000000f201', 'scheduled'),
    (27003, '0192f000-0000-7000-8000-00000000c203', 'water_heater',    '2026-09-22', '10:00', '12:00', '0192f000-0000-7000-8000-00000000f202', 'scheduled'),
    (27004, '0192f000-0000-7000-8000-00000000c204', 'water_heater',    '2026-09-22', '14:00', '16:00', '0192f000-0000-7000-8000-00000000f202', 'scheduled'),
    (27005, '0192f000-0000-7000-8000-00000000c201', 'furnace_tune_up', '2026-09-15', '12:00', '14:00', '0192f000-0000-7000-8000-00000000f201', 'on_the_way'),
    (27006, '0192f000-0000-7000-8000-00000000c203', 'furnace_tune_up', '2026-09-21', '10:00', '12:00', '0192f000-0000-7000-8000-00000000f204', 'scheduled'),
    (27007, '0192f000-0000-7000-8000-00000000c204', 'furnace_tune_up', '2026-09-21', '10:00', '12:00', '0192f000-0000-7000-8000-00000000f205', 'scheduled')
  ) AS j(n, c, service, day, wstart, wend, tech, status);

INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
VALUES (sha256(convert_to(:'token_manager', 'UTF8')), '0192f000-0000-7000-8000-00000000d203', 'web', 'password', false, now(), now(), now() + interval '8 hours'),
       (sha256(convert_to(:'token_tech', 'UTF8')), '0192f000-0000-7000-8000-00000000d201', 'web', 'password', false, now(), now(), now() + interval '8 hours'),
       (sha256(convert_to(:'token_sync', 'UTF8')), '0192f000-0000-7000-8000-00000000d204', 'web', 'password', false, now(), now(), now() + interval '8 hours');

-- Another branch for Add technician (the shell fixture holds Columbus only).
INSERT INTO world.branch (id, name_key, zone, office_phone, depot_lon, depot_lat, map_file)
VALUES ('dayton', 'branch.dayton', 'America/New_York', '(937) 555-0101', -84.19, 39.76, 'dayton.pmtiles');
INSERT INTO world.arrival_window (id, branch_id, mode, start_local, end_local, label_key, capacity)
VALUES ('0192f000-0000-7000-8000-00000000b201', 'dayton', 'two_hour', '08:00', '10:00', 'w.8', 12);

-- 1 open alert of demo today, whose count the bell shows on this page as on every office page (FR-DISP-12).
INSERT INTO world.alert (type, state, branch_id, at, at_real, subject, message_key, message_values, link_target, emailed)
VALUES ('text_gave_up', 'open', 'columbus', TIMESTAMPTZ '2026-09-15T14:00:00Z', now(), 'technicians-stack', 'alert.text_gave_up', '{}', '/office/messages', false);

COMMIT;
