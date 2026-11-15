-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The P6-ROUTE-BAKE stack suite's sessions (ci/route-bake-stack.sh loads them after setup; psql variables :maria and :dana).
-- Setup seeded the world and its people (P2-SEED); sign-in is P2-AUTH's own suite, so the suite's 2 people get their web sessions as the
-- session layer stores them (the token's sha256): the technician Maria Santos (by her technician row, as the phone's web app is signed in)
-- and the manager Dana Ruiz (who moves, pauses and resets the demo clock), each by technician row or email, never by a fixed id.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
SELECT sha256(convert_to(:'maria', 'UTF8')), t.user_id, 'web', 'password', true, now(), now(), now() + interval '8 hours'
  FROM world.technician t WHERE t.name = 'Maria Santos' AND t.user_id IS NOT NULL;
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
SELECT sha256(convert_to(:'dana', 'UTF8')), u.id, 'web', 'password', false, now(), now(), now() + interval '8 hours'
  FROM world."user" u WHERE u.email = 'dana.ruiz@brightwater.example';
DO $$ BEGIN
  IF (SELECT count(*) FROM system.session) <> 2 THEN RAISE EXCEPTION 'route-bake-stack fixture: a seeded person is missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM world.job j JOIN world.technician t ON t.id = j.technician_id
                  WHERE t.name = 'Maria Santos' AND j.date = '2026-09-15') THEN
    RAISE EXCEPTION 'route-bake-stack fixture: Maria Santos has no jobs on Sep 15';
  END IF;
END $$;
COMMIT;
