-- P2-SCHEMA. The 5 schemas and 2 database roles of SPECIFICATIONS section 2 (boundaries) and section 3 (stores).
-- Forward-only (SD-40): never edit this file after it is applied anywhere; add a new numbered file instead.
-- The migration runner (packages/db/src/migrate.ts) creates schema `system` and its ledger before any file runs.

-- Extensions: citext for user.email and email_message.to_address; pg_trgm for the name_search trigram indexes.
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE SCHEMA world;          -- every visitor-changeable record; restored from world_snapshot on reset (SD-12)
CREATE SCHEMA world_snapshot; -- the day-start world, copied once at the end of setup (CREATE TABLE ... AS SELECT)
CREATE SCHEMA pbs;            -- the pretend billing system, role pbs only (FR-BILL-4)
CREATE SCHEMA pbs_snapshot;   -- pbs's day-start copy

-- Roles are cluster-wide, so 2 databases on 1 server may create them at the same moment: tolerate either error.
-- NOLOGIN here; the deployment gives each role its login (a later task), the schema only its privileges.
DO $$
BEGIN
  BEGIN
    CREATE ROLE app NOLOGIN;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  BEGIN
    CREATE ROLE pbs NOLOGIN;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
END
$$;
