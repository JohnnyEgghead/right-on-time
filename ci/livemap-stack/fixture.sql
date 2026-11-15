-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The live map stack suite's sessions (ci/livemap-stack.sh loads them after setup; psql variables :keisha, :dana, :techseed).
-- Setup seeded the world and its people (P2-SEED); sign-in is P2-AUTH's own suite, so the suite's people get their web
-- sessions as the session layer stores them (the token's sha256): a dispatcher (Keisha Thompson, office) and a manager (Dana
-- Ruiz), by email, and every Columbus technician, whose token is the base64url sha256 of :techseed followed by the technician's
-- user id (a session token's own shape: 32 bytes, base64url; the suite
-- sends a technician's On my way through API-102 as that technician, the phone's own call).
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
SELECT sha256(convert_to(t.token, 'UTF8')), u.id, 'web', 'password', false, now(), now(), now() + interval '8 hours'
  FROM (VALUES (:'keisha', 'keisha.t@brightwater.example'), (:'dana', 'dana.ruiz@brightwater.example')) AS t(token, email)
  JOIN world."user" u ON u.email = t.email;
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
SELECT sha256(convert_to(translate(rtrim(encode(sha256(convert_to(:'techseed' || t.user_id::text, 'UTF8')), 'base64'), '='), '+/', '-_'), 'UTF8')),
       t.user_id, 'web', 'password', false, now(), now(), now() + interval '8 hours'
  FROM world.technician t WHERE t.branch_id = 'columbus' AND t.user_id IS NOT NULL;
DO $$ BEGIN
  IF (SELECT count(*) FROM system.session) < 5 THEN RAISE EXCEPTION 'job-stack fixture: a seeded person is missing'; END IF;
END $$;
COMMIT;
