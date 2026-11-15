-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The job screens' stack suite rows (ci/tech-job-stack.sh loads them after setup; psql variables :maria, :keisha, :dana, :kevin). Setup seeded the world
-- and its people (P2-SEED); sign-in is P2-AUTH's suite and the sign-in screen P5-TWA-TODAY's, so the suite's people get their web sessions
-- as the session layer stores them (the token's sha256): the technician Maria Santos (by her technician row) and the dispatcher Keisha
-- Thompson (by email); for the photo small copy suite (P6-PHOTO-THUMBS) the manager Dana Ruiz (by email) and a second technician, Kevin
-- Doyle (by his technician row), whose reads API-175 must refuse on Maria's job. FR-AUTH-4's later visit: Harold Jenkins's Oct 20 furnace job with Maria, a copy of his Sep 15 job 24830 moved 35
-- days on (the seeded week has none), made before any phone or office touches 24830.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
SELECT sha256(convert_to(:'maria', 'UTF8')), t.user_id, 'web', 'password', true, now(), now(), now() + interval '8 hours'
  FROM world.technician t WHERE t.name = 'Maria Santos' AND t.user_id IS NOT NULL;
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
SELECT sha256(convert_to(:'keisha', 'UTF8')), u.id, 'web', 'password', false, now(), now(), now() + interval '8 hours'
  FROM world."user" u WHERE u.email = 'keisha.t@brightwater.example';
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
SELECT sha256(convert_to(:'dana', 'UTF8')), u.id, 'web', 'password', false, now(), now(), now() + interval '8 hours'
  FROM world."user" u WHERE u.email = 'dana.ruiz@brightwater.example' AND u.role = 'manager';
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
SELECT sha256(convert_to(:'kevin', 'UTF8')), t.user_id, 'web', 'password', false, now(), now(), now() + interval '8 hours'
  FROM world.technician t WHERE t.name = 'Kevin Doyle' AND t.user_id IS NOT NULL;
CREATE TEMP TABLE later_visit ON COMMIT DROP AS SELECT * FROM world.job WHERE job_number = 24830;
UPDATE later_visit SET job_number = nextval(pg_get_serial_sequence('world.job', 'job_number')), date = date + 35,
       window_start = window_start + interval '35 days', window_end = window_end + interval '35 days', version = 1;
INSERT INTO world.job SELECT * FROM later_visit;
DO $$ BEGIN
  IF (SELECT count(*) FROM system.session) <> 4 THEN RAISE EXCEPTION 'tech-job-stack fixture: a seeded person is missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM world.job j JOIN world.technician t ON t.id = j.technician_id JOIN world.customer c ON c.id = j.customer_id
                  WHERE j.job_number = 24830 AND t.name = 'Maria Santos' AND c.name = 'Harold Jenkins' AND j.date = '2026-09-15' AND j.status = 'scheduled') THEN
    RAISE EXCEPTION 'tech-job-stack fixture: job 24830 is not Maria Santos''s scheduled Sep 15 visit to Harold Jenkins';
  END IF;
  IF (SELECT count(*) FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE c.name = 'Harold Jenkins' AND j.date = '2026-10-20') <> 1 THEN
    RAISE EXCEPTION 'tech-job-stack fixture: Harold Jenkins''s Oct 20 visit is missing';
  END IF;
END $$;
COMMIT;
