-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The clock banner suite's rows (ci/shell-stack.sh loads them after ci/shell-stack/fixture.sql; psql variable :token, the
-- manager's own session token, made fresh by the script). 1 manager, Dana Ruiz, with 1 web session, so the suite can
-- move the clock as a person (API-12 is managers only). The shell fixture's clock row is confirmed (pbs_epoch =
-- world_epoch) and running, so a jump is accepted at once.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO world."user" (id, email, name, name_search, role, branch_id, language, status, slash_shortcut, sample, reviewer)
VALUES ('0192f000-0000-7000-8000-00000000d002', 'dana@example.test', 'Dana Ruiz', 'dana ruiz', 'manager', 'columbus', 'en', 'active', true, true, false);
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
VALUES (sha256(convert_to(:'token', 'UTF8')), '0192f000-0000-7000-8000-00000000d002', 'web', 'password', false, now(), now(),
        now() + interval '8 hours');
COMMIT;
