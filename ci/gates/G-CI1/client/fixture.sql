-- SPDX-License-Identifier: AGPL-3.0-or-later
-- G-CI1 client cases' sessions (ci/outbox-stack.sh loads them after setup; psql variables :maria, :keisha).
-- Setup seeded the world and its people (P2-SEED); sign-in is P2-AUTH's own suite and the sign-in screen P5-TWA-TODAY's, so the
-- suite's people get their web sessions as the session layer stores them (the token's sha256): the technician Maria Santos (by her
-- technician row, as the phone's web app is signed in) and the dispatcher Keisha Thompson (by email), never by a fixed id.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
SELECT sha256(convert_to(:'maria', 'UTF8')), t.user_id, 'web', 'password', true, now(), now(), now() + interval '8 hours'
  FROM world.technician t WHERE t.name = 'Maria Santos' AND t.user_id IS NOT NULL;
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
SELECT sha256(convert_to(:'keisha', 'UTF8')), u.id, 'web', 'password', false, now(), now(), now() + interval '8 hours'
  FROM world."user" u WHERE u.email = 'keisha.t@brightwater.example';
DO $$ BEGIN
  IF (SELECT count(*) FROM system.session) <> 2 THEN RAISE EXCEPTION 'outbox-stack fixture: a seeded person is missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM world.job j JOIN world.technician t ON t.id = j.technician_id WHERE j.job_number = 24830 AND t.name = 'Maria Santos') THEN
    RAISE EXCEPTION 'outbox-stack fixture: job 24830 is not Maria Santos''s';
  END IF;
  IF EXISTS (SELECT 1 FROM world.job WHERE job_number = 999999) THEN RAISE EXCEPTION 'outbox-stack fixture: job 999999 exists'; END IF;
END $$;
COMMIT;
