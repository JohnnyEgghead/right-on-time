-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The Jobs list stack suite's fixture rows (ci/shell-stack.sh loads them after the shell suite's fixture rows, on the same stack, before the
-- week board's). The default stack holds the migrated schema and the shell fixture only (1 branch, 2 customers, 1 office user and job 24800,
-- which has no technician), so this adds what API-133 reads for Sep 15: 2 technicians, 6 customers, 11 jobs (with job 24800: 3 with no
-- technician today, 2 assigned open jobs, 2 done jobs, 3 later days, 1 far day, 1 past day), a manager and a technician each with a session.
-- The technicians' names sort last, so the week board suite's rows keep their places; the job numbers sit above the week fixture's.
-- Needs ci/shell-stack/fixture.sql loaded first. psql variables: :token_manager, :token_tech.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO world."user" (id, email, name, name_search, role, branch_id, language, status, slash_shortcut, employee_number, sample, reviewer)
VALUES ('0192f000-0000-7000-8000-00000000d101', 'zed.zimmer@example.test', 'Zed Zimmer', 'zed zimmer', 'technician', 'columbus', 'en', 'active', true, '0198', true, false),
       ('0192f000-0000-7000-8000-00000000d102', 'zoe.zook@example.test', 'Zoe Zook', 'zoe zook', 'technician', 'columbus', 'en', 'active', true, '0199', true, false);
INSERT INTO world."user" (id, email, name, name_search, role, branch_id, language, status, slash_shortcut, sample, reviewer)
VALUES ('0192f000-0000-7000-8000-00000000d103', 'jobs.manager@example.test', 'Dana Ruiz', 'dana ruiz', 'manager', 'columbus', 'en', 'active', true, true, false);
INSERT INTO world.van (id, branch_id, number, vehicle)
VALUES ('0192f000-0000-7000-8000-00000000e101', 'columbus', 'J1', 'Van J1'), ('0192f000-0000-7000-8000-00000000e102', 'columbus', 'J2', 'Van J2');
INSERT INTO world.technician (id, user_id, branch_id, name, name_in_texts, phone, primary_skill, skills, installer, van_id, shift_start, shift_end, working_days, saturdays, since)
VALUES ('0192f000-0000-7000-8000-00000000f101', '0192f000-0000-7000-8000-00000000d101', 'columbus', 'Zed Zimmer', 'Zed', '(614) 555-0198', 'heating_cooling', ARRAY['heating_cooling'], false,
        '0192f000-0000-7000-8000-00000000e101', '08:00', '17:30', '{1,2,3,4,5}', 'none', DATE '2020-01-01'),
       ('0192f000-0000-7000-8000-00000000f102', '0192f000-0000-7000-8000-00000000d102', 'columbus', 'Zoe Zook', 'Zoe', '(614) 555-0199', 'heating_cooling', ARRAY['heating_cooling'], false,
        '0192f000-0000-7000-8000-00000000e102', '08:00', '17:30', '{1,2,3,4,5}', 'none', DATE '2020-01-01');

INSERT INTO world.service_type (id, screen_label_key, text_label_key, price_text_key, typical_length_key, invoice_price_cents, job_type, expected_minutes, skill, bookable_online)
VALUES ('ac_tune_up', 's.k', 'service.ac_tune_up.text', 'p.k', 'l.k', 8900, 'maintenance', 60, 'heating_cooling', true),
       ('furnace_tune_up', 's.k', 'service.furnace_tune_up.text', 'p.k', 'l.k', 8900, 'maintenance', 60, 'heating_cooling', true),
       ('water_heater', 's.k', 'service.water_heater.text', 'p.k', 'l.k', 0, 'repair', 90, 'plumbing', true);
-- F-917: text_label_key is a shipped catalog key (a confirmation's {service} slot reads it on a stack, which has no test catalog).

INSERT INTO world.customer (id, branch_id, name, name_search, mobile, home_phone, texts_on, text_language, zone, street_id, house_number, lon, lat,
                            customer_since, source, status, inbox_token)
VALUES ('0192f000-0000-7000-8000-00000000c101', 'columbus', 'Hendricks Quill', 'hendricks quill', '+16145550142', '(614) 555-0177', false, 'en', 'America/New_York',
        '0192f000-0000-7000-8000-00000000a001', 101, -83.0, 39.96, '2020-05-01', 'office', 'active', 'jobsstackinboxtoken01'),
       ('0192f000-0000-7000-8000-00000000c102', 'columbus', 'Priya Nair', 'priya nair', NULL, NULL, false, 'en', 'America/New_York',
        '0192f000-0000-7000-8000-00000000a001', 102, -83.0, 39.96, '2020-05-01', 'office', 'active', 'jobsstackinboxtoken02'),
       ('0192f000-0000-7000-8000-00000000c103', 'columbus', 'Omar Haddad', 'omar haddad', NULL, NULL, false, 'en', 'America/New_York',
        '0192f000-0000-7000-8000-00000000a001', 103, -83.0, 39.96, '2020-05-01', 'office', 'active', 'jobsstackinboxtoken03'),
       ('0192f000-0000-7000-8000-00000000c104', 'columbus', 'Lena Fischer', 'lena fischer', NULL, NULL, false, 'en', 'America/New_York',
        '0192f000-0000-7000-8000-00000000a001', 104, -83.0, 39.96, '2020-05-01', 'office', 'active', 'jobsstackinboxtoken04'),
       ('0192f000-0000-7000-8000-00000000c105', 'columbus', 'Tomas Reyes', 'tomas reyes', NULL, NULL, false, 'en', 'America/New_York',
        '0192f000-0000-7000-8000-00000000a001', 105, -83.0, 39.96, '2020-05-01', 'office', 'active', 'jobsstackinboxtoken05'),
       ('0192f000-0000-7000-8000-00000000c106', 'columbus', 'Grace Whitfield', 'grace whitfield', NULL, NULL, false, 'en', 'America/New_York',
        '0192f000-0000-7000-8000-00000000a001', 106, -83.0, 39.96, '2020-05-01', 'office', 'active', 'jobsstackinboxtoken06');

-- Job 24800 (the shell fixture's, no technician) was booked by the office user: the Booked by column names her.
UPDATE world.job SET booked_by = '0192f000-0000-7000-8000-00000000d001' WHERE job_number = 24800;

-- number, customer, service, day, window start, window end, technician, status, booked via, booked by, billing state, ended at
INSERT INTO world.job (job_number, customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, technician_id, status, version,
                       expected_minutes, booked_via, booked_at, booked_by, billing_state, ended_at, autopilot, touched_by_person, pilot)
SELECT j.n, j.c::uuid, 'columbus', j.service, j.day::date, 'America/New_York', '0192f000-0000-7000-8000-00000000b001',
       (j.day::date + j.wstart::time) AT TIME ZONE 'America/New_York', (j.day::date + j.wend::time) AT TIME ZONE 'America/New_York',
       j.tech::uuid, j.status, 1, 60, j.via, TIMESTAMPTZ '2026-09-10T12:00:00Z', j.by::uuid, j.billing,
       CASE WHEN j.ended IS NULL THEN NULL ELSE (j.day::date + j.ended::time) AT TIME ZONE 'America/New_York' END, false, false, false
  FROM (VALUES
    (26001, '0192f000-0000-7000-8000-00000000c101', 'water_heater',    '2026-09-15', '12:00', '14:00', NULL,                                    'scheduled', 'office', '0192f000-0000-7000-8000-00000000d001', 'not_sent',       NULL),
    (26002, '0192f000-0000-7000-8000-00000000c102', 'ac_tune_up',      '2026-09-15', '14:00', '16:00', NULL,                                    'scheduled', 'online', NULL,                                   'not_sent',       NULL),
    (26003, '0192f000-0000-7000-8000-00000000c103', 'furnace_tune_up', '2026-09-15', '12:00', '14:00', '0192f000-0000-7000-8000-00000000f101', 'scheduled', 'online', NULL,                                   'not_sent',       NULL),
    (26004, '0192f000-0000-7000-8000-00000000c104', 'ac_tune_up',      '2026-09-15', '14:00', '16:00', '0192f000-0000-7000-8000-00000000f102', 'scheduled', 'office', '0192f000-0000-7000-8000-00000000d001', 'not_sent',       NULL),
    (26005, '0192f000-0000-7000-8000-00000000c105', 'furnace_tune_up', '2026-09-15', '08:00', '10:00', '0192f000-0000-7000-8000-00000000f101', 'done',      'seed',   NULL,                                   'in_billing',     '09:40'),
    (26006, '0192f000-0000-7000-8000-00000000c106', 'water_heater',    '2026-09-15', '08:00', '10:00', '0192f000-0000-7000-8000-00000000f102', 'done',      'online', NULL,                                   'retrying',       '09:35'),
    (26007, '0192f000-0000-7000-8000-00000000c103', 'ac_tune_up',      '2026-09-16', '10:00', '12:00', '0192f000-0000-7000-8000-00000000f101', 'scheduled', 'online', NULL,                                   'not_sent',       NULL),
    (26008, '0192f000-0000-7000-8000-00000000c104', 'furnace_tune_up', '2026-09-17', '10:00', '12:00', '0192f000-0000-7000-8000-00000000f102', 'scheduled', 'office', '0192f000-0000-7000-8000-00000000d001', 'not_sent',       NULL),
    (26009, '0192f000-0000-7000-8000-00000000c105', 'water_heater',    '2026-09-22', '10:00', '12:00', '0192f000-0000-7000-8000-00000000f101', 'scheduled', 'online', NULL,                                   'not_sent',       NULL),
    (26010, '0192f000-0000-7000-8000-00000000c106', 'ac_tune_up',      '2026-09-12', '10:00', '12:00', '0192f000-0000-7000-8000-00000000f102', 'done',      'online', NULL,                                   'waiting_person', '11:30')
  ) AS j(n, c, service, day, wstart, wend, tech, status, via, by, billing, ended);

INSERT INTO world.billing_item (job_number, state, tries, last_try_at, next_try_at, left_at, left_how)
VALUES (26005, 'in_billing', 1, TIMESTAMPTZ '2026-09-15T13:44:00Z', NULL, TIMESTAMPTZ '2026-09-15T13:44:00Z', 'automatic_retry'),
       (26006, 'retrying', 2, TIMESTAMPTZ '2026-09-15T14:20:00Z', TIMESTAMPTZ '2026-09-15T14:35:00Z', NULL, NULL),
       (26010, 'waiting_person', 1, TIMESTAMPTZ '2026-09-12T15:40:00Z', NULL, NULL, NULL);

INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
VALUES (sha256(convert_to(:'token_manager', 'UTF8')), '0192f000-0000-7000-8000-00000000d103', 'web', 'password', false, now(), now(), now() + interval '8 hours'),
       (sha256(convert_to(:'token_tech', 'UTF8')), '0192f000-0000-7000-8000-00000000d101', 'web', 'password', false, now(), now(), now() + interval '8 hours');

COMMIT;
