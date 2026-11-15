-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The P5-TWA-MAP-ME stack suite's sessions (ci/mapme-stack.sh loads them after setup; psql variables :maria, :mariaout1 to :mariaout4, :keisha, :dana).
-- Setup seeded the world and its people (P2-SEED); sign-in is P2-AUTH's own suite and the sign-in screen P5-TWA-TODAY's, so the suite's people get
-- their web sessions as the session layer stores them (the token's sha256): the technician Maria Santos (by her technician row, as the phone's web
-- app is signed in; 1 session for the screens and 1 for each engine's 2 sign-out cases, each of which ends its own), the dispatcher Keisha Thompson (who moves
-- Maria's jobs) and the manager Dana Ruiz (who moves the demo clock), each by email or technician row, never by a fixed id.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
SELECT sha256(convert_to(v.token, 'UTF8')), t.user_id, 'web', 'password', true, now(), now(), now() + interval '8 hours'
  FROM (VALUES (:'maria'), (:'mariaout1'), (:'mariaout2'), (:'mariaout3'), (:'mariaout4')) AS v(token)
  CROSS JOIN world.technician t WHERE t.name = 'Maria Santos' AND t.user_id IS NOT NULL;
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
SELECT sha256(convert_to(t.token, 'UTF8')), u.id, 'web', 'password', false, now(), now(), now() + interval '8 hours'
  FROM (VALUES (:'dana', 'dana.ruiz@brightwater.example'), (:'keisha', 'keisha.t@brightwater.example')) AS t(token, email)
  JOIN world."user" u ON u.email = t.email;
DO $$ BEGIN
  IF (SELECT count(*) FROM system.session) <> 7 THEN RAISE EXCEPTION 'mapme-stack fixture: a seeded person is missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM world.job j JOIN world.technician t ON t.id = j.technician_id
                  WHERE t.name = 'Maria Santos' AND j.date = '2026-09-15') THEN
    RAISE EXCEPTION 'mapme-stack fixture: Maria Santos has no jobs on Sep 15';
  END IF;
  -- F-1550: the seed starts the past pilot days (F-1541, Aug 31 to Sep 14); the suite's sign-in must start Sep 15, so none is started on that day.
  IF (SELECT count(*) FROM world.technician_day WHERE date = '2026-09-15') <> 0 THEN
    RAISE EXCEPTION 'mapme-stack fixture: a technician day on Sep 15 is already started';
  END IF;
END $$;
COMMIT;
