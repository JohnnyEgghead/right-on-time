-- P2-SCHEMA. Privileges of the 2 database roles (SPECIFICATIONS section 2 boundaries, section 3 stores).
-- Forward-only (SD-40). A later migration that adds a table grants its own privileges in the same file.
--
--   app  world (via repositories) and system; no UPDATE or DELETE on the 8 append-only history logs; SELECT only on
--        membership (FR-DISP-32) and on the report_visit view; nothing on pbs, pbs_snapshot or world_snapshot.
--   pbs  its own schemas pbs and pbs_snapshot only (FR-BILL-4); nothing in world or system.
-- Not granted here (reported as a spec gap): TRUNCATE and the snapshot reads a reset needs (SD-12), since section 3
-- gives app no UPDATE or DELETE on the append-only logs and SELECT only on membership. The reset task names its role.

GRANT USAGE ON SCHEMA world, system TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA world TO app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA world TO app;

REVOKE UPDATE, DELETE ON
  world.job_change, world.tech_item, world.text_attempt, world.billing_attempt,
  world.user_change, world.note, world.photo, world.signature
FROM app;

REVOKE INSERT, UPDATE, DELETE ON world.membership, world.report_visit FROM app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA system TO app;
REVOKE ALL ON system.schema_migration FROM app;

GRANT USAGE ON SCHEMA pbs, pbs_snapshot TO pbs;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pbs TO pbs;
