-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The customers stack suite's rows (ci/shell-stack.sh loads them after the shell suite's and the week board suite's fixture rows, on the
-- same stack; psql variable :token, the manager's own session token, made fresh by the script). The default stack holds the shell fixture
-- (1 branch, 1 street, 2 customers, 1 office user with a session) and the week fixture; this adds a manager with her own session (so the
-- Customers item is opened as each role FR-AUTH-1 allows), 2 more streets, the 3 customers the search acceptance names, and a member with
-- a visit booked.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO world."user" (id, email, name, name_search, role, branch_id, language, status, slash_shortcut, sample, reviewer)
VALUES ('0192f000-0000-7000-8000-00000000d0a1', 'customers.manager@example.test', 'Priya Nair', 'priya nair', 'manager', 'columbus', 'en', 'active', true, true, false);
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
VALUES (sha256(convert_to(:'token', 'UTF8')), '0192f000-0000-7000-8000-00000000d0a1', 'web', 'password', false, now(), now(), now() + interval '8 hours');

INSERT INTO world.street (id, name, name_search, city, zip, branch_id, points) VALUES
  ('0192f000-0000-7000-8000-00000000a0a1', 'Calumet St', 'calumet st', 'Clintonville', '43202', 'columbus', '[[-83.02, 40.05], [-83.021, 40.051]]'),
  ('0192f000-0000-7000-8000-00000000a0a2', 'Kenwick Rd', 'kenwick rd', 'Upper Arlington', '43221', 'columbus', '[[-83.06, 40.03]]');

INSERT INTO world.customer (id, branch_id, name, name_search, mobile, texts_on, text_language, zone, street_id, house_number, lon, lat,
                            customer_since, source, status, inbox_token) VALUES
  ('0192f000-0000-7000-8000-00000000c0a1', 'columbus', 'Sean O''Brien', 'sean obrien', '+16145550163', true, 'en', 'America/New_York',
   '0192f000-0000-7000-8000-00000000a0a1', 2291, -83.02, 40.05, '2017-04-02', 'import', 'active', 'custstackinboxtoken01'),
  ('0192f000-0000-7000-8000-00000000c0a2', 'columbus', 'Kathleen O''Brien-Miller', 'kathleen obrien miller', '+16145550187', true, 'en', 'America/New_York',
   '0192f000-0000-7000-8000-00000000a0a2', 57, -83.06, 40.03, '2021-06-14', 'import', 'active', 'custstackinboxtoken02'),
  ('0192f000-0000-7000-8000-00000000c0a3', 'columbus', 'Kathy OBrien', 'kathy obrien', NULL, false, 'en', 'America/New_York',
   '0192f000-0000-7000-8000-00000000a0a2', 112, -83.06, 40.03, '2022-01-10', 'import', 'active', 'custstackinboxtoken03');
INSERT INTO world.membership (customer_id, since, renews, benefits_key)
VALUES ('0192f000-0000-7000-8000-00000000c0a1', '2019-03-01', '2027-03-01', 'comfort_club');
INSERT INTO world.job (job_number, customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, status, version,
                       expected_minutes, booked_via, booked_at, billing_state, autopilot, touched_by_person, pilot)
VALUES (29999, '0192f000-0000-7000-8000-00000000c0a1', 'columbus', 'tune_up', '2026-09-17', 'America/New_York',
        '0192f000-0000-7000-8000-00000000b001', '2026-09-17T08:00:00-04:00', '2026-09-17T10:00:00-04:00', 'scheduled', 1, 60,
        'office', '2026-09-14T12:00:00Z', 'not_sent', false, false, false);
-- F-695: a done job with 2 work-done lines, so the customer page's What was done cell is drawn from a technician's finish (API-35).
INSERT INTO world.job (job_number, customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, status, version,
                       expected_minutes, booked_via, booked_at, billing_state, autopilot, touched_by_person, pilot)
VALUES (29998, '0192f000-0000-7000-8000-00000000c0a1', 'columbus', 'tune_up', '2026-09-10', 'America/New_York',
        '0192f000-0000-7000-8000-00000000b001', '2026-09-10T08:00:00-04:00', '2026-09-10T10:00:00-04:00', 'done', 1, 60,
        'office', '2026-09-08T12:00:00Z', 'not_sent', false, false, false);
INSERT INTO world.work_done_line (job_number, seq, text) VALUES (29998, 1, 'Replaced the run capacitor'), (29998, 2, 'Cleaned the condenser coil');
COMMIT;
