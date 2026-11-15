-- SPDX-License-Identifier: AGPL-3.0-or-later
-- P4-LOAD: open the load day's sessions and print the load script's world file (packages/testkit/src/load/plan.ts LoadWorld) as 1 JSON
-- line. Sign-in is P2-AUTH's own suite, so each person's web session is written as the session layer stores it (the token's sha256), as
-- the stack suites do. The tokens exist only on the throwaway stack and in the world file, which stays outside the repo.
-- Run as the schema owner after fixture.sql: psql -tA -f sessions.sql > world.json
-- The jobs come from world_snapshot, the world API-14 restores before every run, so a world file made after a run holds the
-- jobs as each run starts, not as the last run left them.
\set ON_ERROR_STOP on
\set QUIET on
BEGIN;
CREATE TEMP TABLE load_session ON COMMIT DROP AS
  -- A token is 32 random bytes in base64url (43 characters, sessions.ts); 2 random UUIDs through sha256 make 32 bytes.
  SELECT u.id AS user_id, u.role,
         rtrim(translate(encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'base64'), '+/', '-_'), '=') AS token
    FROM world."user" u
   WHERE u.email LIKE 'load.dispatcher.%' OR u.email = 'dana.ruiz@brightwater.example'
      OR u.id IN (SELECT user_id FROM world.technician);
-- The manager's session is used only at each run's start (reset and clock), so a run longer than its 30 minute idle limit
-- (sessions.ts lifetimes) would sign it out: it keeps signed in. Every other session is in use all run long.
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
  SELECT sha256(convert_to(token, 'UTF8')), user_id, 'web', 'password', role = 'manager', now(), now(), now() + interval '12 hours' FROM load_session;
SELECT json_build_object(
  'managerToken', (SELECT s.token FROM load_session s WHERE s.role = 'manager'),
  'dispatchers', (SELECT json_agg(json_build_object('id', u.id, 'branch', u.branch_id, 'token', s.token) ORDER BY u.email)
                    FROM load_session s JOIN world."user" u ON u.id = s.user_id WHERE s.role = 'office'),
  'technicians', (SELECT json_agg(json_build_object('id', t.id, 'branch', t.branch_id, 'token', s.token) ORDER BY t.id)
                    FROM load_session s JOIN world.technician t ON t.user_id = s.user_id),
  'jobs', (SELECT json_agg(json_build_object('jobNumber', j.job_number, 'branch', j.branch_id, 'technicianId', j.technician_id, 'version', j.version,
                                             'plannedMs', (extract(epoch FROM j.planned_arrival) * 1000)::bigint, 'expectedMinutes', j.expected_minutes) ORDER BY j.job_number)
             FROM world_snapshot.job j WHERE j.date = '2026-09-15' AND j.status <> 'canceled'));
COMMIT;
