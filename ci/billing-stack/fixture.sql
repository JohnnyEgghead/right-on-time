-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The billing stack suite's fixture rows, loaded after ci/shell-stack/fixture.sql (the clock row, branch columbus, the street, customer
-- Ann Lee, the office user Keisha Thompson and her session). The jobs themselves are seeded by the suite, one test at a time, so each
-- sends while the pretend billing system is in the mode that test sets. These are the rows they stand on:
--   a Comfort Club member (Whitaker) for the sample invoice of SD-20 ($132.65), a technician, the service ac_tune_up at $89.00, and 2 parts.
--   (F-594) branch Dayton with a street, a customer and a window, and a Dayton office user (Dana Ruiz) with 1 web session whose token
--   the suite sets as its Dayton cookie (psql -v dayton_token): the list must follow the top bar's branch and a Dayton user's own branch.
\set ON_ERROR_STOP on
BEGIN;
-- pbs starts at epoch 0 and takes the world's epoch from a reset (SD-12); the shell fixture's clock row is epoch 1, and a send at another epoch answers wrong_epoch.
UPDATE pbs.mode SET epoch = 1;
INSERT INTO world.customer (id, branch_id, name, name_search, texts_on, text_language, zone, street_id, house_number, lon, lat,
                            customer_since, source, status, inbox_token)
VALUES ('0192f000-0000-7000-8000-00000000c003', 'columbus', 'Whitaker', 'whitaker', true, 'en', 'America/New_York',
        '0192f000-0000-7000-8000-00000000a001', 44, -83.0, 39.96, '2019-04-01', 'office', 'active', 'billingstackinboxtok03');
INSERT INTO world.membership (customer_id, since, renews, benefits_key)
VALUES ('0192f000-0000-7000-8000-00000000c003', '2024-04-01', '2027-04-01', 'membership.benefits');
INSERT INTO world.service_type (id, screen_label_key, text_label_key, price_text_key, typical_length_key, invoice_price_cents, job_type,
                                expected_minutes, skill, bookable_online)
VALUES ('ac_tune_up', 's.k', 'service.ac_tune_up.text', 'p.k', 'l.k', 8900, 'maintenance', 60, 'heating_cooling', true);
INSERT INTO world."user" (id, email, name, name_search, role, branch_id, language, status, slash_shortcut, sample, reviewer)
VALUES ('0192f000-0000-7000-8000-00000000d002', 'maria@example.test', 'Maria Santos', 'maria santos', 'technician', 'columbus', 'en', 'active', true, true, false);
INSERT INTO world.technician (id, user_id, branch_id, name, name_in_texts, phone, primary_skill, skills, installer, shift_start, shift_end,
                              working_days, saturdays, since)
VALUES ('0192f000-0000-7000-8000-00000000f001', '0192f000-0000-7000-8000-00000000d002', 'columbus', 'Maria Santos', 'Maria', '(614) 555-0142',
        'heating_cooling', '{heating_cooling}', false, '08:00', '17:00', '{1,2,3,4,5}', 'none', '2016-03-01');
INSERT INTO world.part (id, code, name, name_search, price_cents)
VALUES ('0192f000-0000-7000-8000-00000000e001', 'CAP-455', 'Run capacitor 45/5 MFD', 'run capacitor 45/5 mfd', 3800),
       ('0192f000-0000-7000-8000-00000000e002', 'FLT-16251', 'Furnace filter 16x25x1 MERV 8', 'furnace filter 16x25x1 merv 8', 950);
INSERT INTO world.branch (id, name_key, zone, office_phone, depot_lon, depot_lat, map_file)
VALUES ('dayton', 'branch.dayton', 'America/New_York', '(937) 555-0101', -84.19, 39.76, 'dayton.pmtiles');
INSERT INTO world.street (id, name, name_search, city, zip, branch_id, points)
VALUES ('0192f000-0000-7000-8000-00000000a002', 'Main St', 'main st', 'Dayton', '45402', 'dayton', '[[-84.19, 39.76]]');
INSERT INTO world.customer (id, branch_id, name, name_search, texts_on, text_language, zone, street_id, house_number, lon, lat,
                            customer_since, source, status, inbox_token)
VALUES ('0192f000-0000-7000-8000-00000000c004', 'dayton', 'Omar Haddad', 'omar haddad', true, 'en', 'America/New_York',
        '0192f000-0000-7000-8000-00000000a002', 18, -84.19, 39.76, '2022-02-01', 'office', 'active', 'billingstackinboxtok04');
INSERT INTO world.arrival_window (id, branch_id, mode, start_local, end_local, label_key, capacity)
VALUES ('0192f000-0000-7000-8000-00000000b002', 'dayton', 'two_hour', '08:00', '10:00', 'w.8', 12);
INSERT INTO world."user" (id, email, name, name_search, role, branch_id, language, status, slash_shortcut, sample, reviewer)
VALUES ('0192f000-0000-7000-8000-00000000d003', 'dana@example.test', 'Dana Ruiz', 'dana ruiz', 'office', 'dayton', 'en', 'active', true, true, false);
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
VALUES (sha256(convert_to(:'dayton_token', 'UTF8')), '0192f000-0000-7000-8000-00000000d003', 'web', 'password', false, now(), now(),
        now() + interval '8 hours');
COMMIT;
