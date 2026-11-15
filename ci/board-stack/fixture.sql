-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The board stack suite's sessions (ci/board-stack.sh loads them after setup; psql variables :keisha, :ana, :dana, :tech).
-- Setup seeded the world and its people (P2-SEED); sign-in is P2-AUTH's own suite, so the suite's people get their web
-- sessions as the session layer stores them (the token's sha256): 2 dispatchers (Keisha Thompson, Ana Gutierrez, office),
-- a manager (Dana Ruiz) and a technician (Maria Santos), each by email or name, never by a fixed id.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
SELECT sha256(convert_to(t.token, 'UTF8')), u.id, 'web', 'password', false, now(), now(), now() + interval '8 hours'
  FROM (VALUES (:'keisha', 'keisha.t@brightwater.example'), (:'ana', 'ana.gutierrez@brightwater.example'),
               (:'dana', 'dana.ruiz@brightwater.example')) AS t(token, email)
  JOIN world."user" u ON u.email = t.email;
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
SELECT sha256(convert_to(:'tech', 'UTF8')), t.user_id, 'web', 'password', false, now(), now(), now() + interval '8 hours'
  FROM world.technician t WHERE t.name = 'Maria Santos';
DO $$ BEGIN
  IF (SELECT count(*) FROM system.session) < 4 THEN RAISE EXCEPTION 'board-stack fixture: a seeded person is missing'; END IF;
END $$;
COMMIT;
