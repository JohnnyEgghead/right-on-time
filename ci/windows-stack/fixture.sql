-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The windows stack suite's sessions (ci/windows-stack.sh loads them after setup; psql variables :dana, :keisha).
-- Setup seeded the world and its people (P2-SEED); sign-in is P2-AUTH's own suite, so the suite's people get their web sessions as the
-- session layer stores them (the token's sha256): the manager Dana Ruiz (the one who switched the sample peak days) and the dispatcher Keisha
-- Thompson (the arrival windows page is for office staff and managers), each by email, never by a fixed id.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
SELECT sha256(convert_to(t.token, 'UTF8')), u.id, 'web', 'password', false, now(), now(), now() + interval '8 hours'
  FROM (VALUES (:'dana', 'dana.ruiz@brightwater.example'), (:'keisha', 'keisha.t@brightwater.example')) AS t(token, email)
  JOIN world."user" u ON u.email = t.email;
DO $$ BEGIN
  IF (SELECT count(*) FROM system.session) < 2 THEN RAISE EXCEPTION 'windows-stack fixture: a seeded person is missing'; END IF;
  IF (SELECT count(*) FROM world.arrival_window WHERE branch_id = 'columbus' AND mode = 'two_hour') <> 5 THEN RAISE EXCEPTION 'windows-stack fixture: Columbus has not 5 two-hour windows'; END IF;
  IF (SELECT count(*) FROM world.day_mode WHERE branch_id = 'columbus' AND mode = 'four_hour') < 2 THEN RAISE EXCEPTION 'windows-stack fixture: the seed wrote no sample peak days'; END IF;
END $$;
COMMIT;
