-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The shell stack suite's fixture rows (ci/shell-stack.sh loads them once the stack is up; psql variable :token).
-- The default stack holds the migrated schema and no rows: setup's epoch-1 clock row and the sample data are P2-SEED's,
-- and sign-in is P2-AUTH's. So the suite writes, as setup and sign-in will:
--   the clock row (demo time Tue, Sep 15, 10:41 AM EDT at the moment of loading, running at rate 1),
--   1 branch, 1 street, 2 customers and 1 job for the search, and
--   1 office user with 1 web session whose token the suite sets as its bw_session cookie.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO system.demo_clock (id, demo_anchor, real_anchor, rate, paused, world_epoch, pbs_epoch, last_reset_real, last_write_real)
VALUES (1, '2026-09-15T14:41:00Z', now(), 1, false, 1, 1, now(), now());
INSERT INTO world.branch (id, name_key, zone, office_phone, depot_lon, depot_lat, map_file)
VALUES ('columbus', 'branch.columbus', 'America/New_York', '(614) 555-0100', -83.0, 39.96, 'columbus.pmtiles');
INSERT INTO world.street (id, name, name_search, city, zip, branch_id, points)
VALUES ('0192f000-0000-7000-8000-00000000a001', 'High St', 'high st', 'Columbus', '43215', 'columbus', '[[-83.0, 39.96]]');
INSERT INTO world.customer (id, branch_id, name, name_search, texts_on, text_language, zone, street_id, house_number, lon, lat,
                            customer_since, source, status, inbox_token)
VALUES ('0192f000-0000-7000-8000-00000000c001', 'columbus', 'Ann Lee', 'ann lee', true, 'en', 'America/New_York',
        '0192f000-0000-7000-8000-00000000a001', 12, -83.0, 39.96, '2020-05-01', 'office', 'active', 'shellstackinboxtoken01'),
       ('0192f000-0000-7000-8000-00000000c002', 'columbus', 'Anne O''Brien', 'anne obrien', true, 'en', 'America/New_York',
        '0192f000-0000-7000-8000-00000000a001', 40, -83.0, 39.96, '2021-03-01', 'office', 'active', 'shellstackinboxtoken02');
-- F-917: text_label_key is a shipped catalog key. The web and the worker render texts from the shipped catalogs (no test catalog on a
-- stack), and since P4-NEWJOB API-28 and API-24 send the confirmation, whose {service} slot reads this key: a placeholder key made the
-- messages suite's API-28 answer 500 ("the en catalog has no key t.k").
INSERT INTO world.service_type (id, screen_label_key, text_label_key, price_text_key, typical_length_key, invoice_price_cents, job_type,
                                expected_minutes, skill, bookable_online)
VALUES ('tune_up', 's.k', 'service.furnace_tune_up.text', 'p.k', 'l.k', 8900, 'maintenance', 60, 'heating_cooling', true);
INSERT INTO world.arrival_window (id, branch_id, mode, start_local, end_local, label_key, capacity)
VALUES ('0192f000-0000-7000-8000-00000000b001', 'columbus', 'two_hour', '08:00', '10:00', 'w.8', 12);
INSERT INTO world.job (job_number, customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, status, version,
                       expected_minutes, booked_via, booked_at, billing_state, autopilot, touched_by_person, pilot)
VALUES (24800, '0192f000-0000-7000-8000-00000000c001', 'columbus', 'tune_up', '2026-09-15', 'America/New_York',
        '0192f000-0000-7000-8000-00000000b001', '2026-09-15T08:00:00-04:00', '2026-09-15T10:00:00-04:00', 'scheduled', 1, 60,
        'office', '2026-09-14T12:00:00Z', 'not_sent', false, false, false);
INSERT INTO world."user" (id, email, name, name_search, role, branch_id, language, status, slash_shortcut, sample, reviewer)
VALUES ('0192f000-0000-7000-8000-00000000d001', 'keisha@example.test', 'Keisha Thompson', 'keisha thompson', 'office', 'columbus', 'en', 'active', true, true, false);
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
VALUES (sha256(convert_to(:'token', 'UTF8')), '0192f000-0000-7000-8000-00000000d001', 'web', 'password', false, now(), now(),
        now() + interval '8 hours');
COMMIT;
