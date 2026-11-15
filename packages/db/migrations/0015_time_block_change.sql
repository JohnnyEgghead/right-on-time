-- P4-BOARD (owner ruling 8ef38e83, Nov 3, 2026, "Who moved it, and when"; F-354). The block change log: 1 row per block
-- move, written by moveBlock (packages/api-server/src/office-writes/service.ts) in the move's own version-gated
-- transaction, so API-137's version_conflict can name who moved the block, their kind, the change and when, as a job's
-- conflict does from job_change (FR-DISP-6, FR-DISP-34). The table's SPECIFICATIONS section 3 row comes in the phase 4
-- doc batch. Forward-only (SD-40).
--
-- Append-only like job_change (section 3 stores table): role app may insert and read, never update or delete. No foreign
-- key to time_block: a deleted block keeps its history, as a job's history outlives nothing it names (OA-75 deletes the
-- block row only). A reset's restore leaves it empty (world_snapshot has no copy of it): the seeded blocks have no moves.
-- `from_version` and `to_version` are the gate's trail (to_version = from_version + 1); `data` holds the technician ids
-- and the times before and after, never a name.
CREATE TABLE world.time_block_change (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  block_id       uuid NOT NULL,
  at             timestamptz NOT NULL,
  actor_user_id  uuid,
  actor_kind     text NOT NULL,
  kind           text NOT NULL,
  from_version   integer NOT NULL,
  to_version     integer NOT NULL,
  data           jsonb NOT NULL,
  CONSTRAINT time_block_change_versions CHECK (to_version = from_version + 1)
);

CREATE INDEX time_block_change_block_version ON world.time_block_change (block_id, to_version);

GRANT SELECT, INSERT ON world.time_block_change TO app;
