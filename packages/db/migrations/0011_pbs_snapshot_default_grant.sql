-- W16-INTEGRATION (F-359). pbs reads its day-start snapshot at a reset (SD-12: POST /reset restores pbs from
-- pbs_snapshot). Setup writes that snapshot after the migrations (packages/setup/src/snapshot.ts writeSnapshot,
-- CREATE TABLE AS, as the owner login that also runs the migrations), so 0007's GRANT ... ON ALL TABLES never reached
-- those tables and pbs's reset answered 500 snapshot_unreadable. Forward-only (SD-40).
--
-- 1. Every table the owner login creates in pbs_snapshot from now on is readable by pbs (default privileges belong to
--    the role that runs this file, which is the role that runs setup).
-- 2. Any pbs_snapshot table already there (a stack set up before this migration) gets the same grant.
-- pbs gets SELECT only: it restores from the snapshot and never writes it (FR-BILL-4: its own schemas only).

ALTER DEFAULT PRIVILEGES IN SCHEMA pbs_snapshot GRANT SELECT ON TABLES TO pbs;
GRANT SELECT ON ALL TABLES IN SCHEMA pbs_snapshot TO pbs;
