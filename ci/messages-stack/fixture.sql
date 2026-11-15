-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The messages stack suite's fixture rows, loaded after ci/shell-stack/fixture.sql (the clock row, branch columbus, the street, customers Ann Lee
-- and Anne O'Brien, job 24800, the service tune_up, the window, the office user Keisha Thompson and her session). The texts, the call list rows
-- and the jobs the suite checks are written by the suite itself, one test at a time. These are the rows they stand on:
--   the text simulator row (mode up; the suite sets All sends fail), a technician (the office write of API-28 needs a working technician for the
--   window's room), and 3 customers for the 7:15 PM booking (owner ruling 86ecd5ae, F-446): one with texts off, one with texts on and a mobile,
--   one with no mobile.
\set ON_ERROR_STOP on
BEGIN;
-- The shell fixture wrote job 24800 by number: the identity moves past it, or the first job the office creates takes the same number.
SELECT setval(pg_get_serial_sequence('world.job', 'job_number'), 24800);
INSERT INTO world.text_simulator (mode) VALUES ('up');
UPDATE world.customer SET mobile = '(614) 555-0112' WHERE id = '0192f000-0000-7000-8000-00000000c001'; -- Ann Lee: a phone to call
INSERT INTO world."user" (id, email, name, name_search, role, branch_id, language, status, slash_shortcut, sample, reviewer)
VALUES ('0192f000-0000-7000-8000-00000000d002', 'maria@example.test', 'Maria Santos', 'maria santos', 'technician', 'columbus', 'en', 'active', true, true, false);
INSERT INTO world.technician (id, user_id, branch_id, name, name_in_texts, phone, primary_skill, skills, installer, shift_start, shift_end,
                              working_days, saturdays, since)
VALUES ('0192f000-0000-7000-8000-00000000f001', '0192f000-0000-7000-8000-00000000d002', 'columbus', 'Maria Santos', 'Maria', '(614) 555-0142',
        'heating_cooling', '{heating_cooling}', false, '08:00', '17:00', '{1,2,3,4,5}', 'none', '2016-03-01');
INSERT INTO world.customer (id, branch_id, name, name_search, mobile, home_phone, texts_on, text_language, zone, street_id, house_number, lon, lat,
                            customer_since, source, status, inbox_token)
VALUES ('0192f000-0000-7000-8000-00000000c010', 'columbus', 'Tessa Offtext', 'tessa offtext', '(614) 555-0166', '(614) 555-0100', false, 'en', 'America/New_York',
        '0192f000-0000-7000-8000-00000000a001', 51, -83.0, 39.96, '2021-06-01', 'office', 'active', 'messagesstackinboxtok10'),
       ('0192f000-0000-7000-8000-00000000c011', 'columbus', 'Mia Mobile', 'mia mobile', '(614) 555-0177', NULL, true, 'en', 'America/New_York',
        '0192f000-0000-7000-8000-00000000a001', 52, -83.0, 39.96, '2021-07-01', 'office', 'active', 'messagesstackinboxtok11'),
       ('0192f000-0000-7000-8000-00000000c012', 'columbus', 'Nolan Nomobile', 'nolan nomobile', NULL, '(614) 555-0188', true, 'en', 'America/New_York',
        '0192f000-0000-7000-8000-00000000a001', 53, -83.0, 39.96, '2021-08-01', 'office', 'active', 'messagesstackinboxtok12');
COMMIT;
