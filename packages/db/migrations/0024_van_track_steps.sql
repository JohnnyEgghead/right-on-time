-- P6-ROUTE-BAKE (SPECIFICATIONS v0.13 section 3 `van_track.steps`, SD-49, section 6.10; FR-TECH-5; owner ruling Nov 9, 2026, F-1233).
-- Forward-only (SD-40).
-- van_track.steps: jsonb, the track's turn-by-turn steps in driving order, an array of SD-49's step objects
-- {kind, direction, heading, road, exit, side, at, distanceMeters}, the names API-104 answers. Setup's loader writes it from the
-- baked tracks file; P6-LIVE-ROUTING's live client writes it for a live row, by the same step mapping (packages/maps/src/steps.ts).
-- NOT NULL with the default '[]': a row always has a list. The default is what a row written before this migration holds, and
-- what the reset (0014, system.restore_world, columns by name) restores from a snapshot taken before it, so neither breaks; such a
-- world answers no steps until a fresh setup loads the new tracks file. Every writer from this migration on writes the steps.
-- The CHECK keeps the shape a reader iterates: an array. The step objects' fields are checked where they are made (the mapping
-- refuses a route that breaks SD-49's guarantees) and by the real-file test over the tracks file, not per row here.
-- Safe on a live database: PostgreSQL adds a column with a constant default without rewriting the table. No grant changes (the
-- grants are on the table, 0007).
ALTER TABLE world.van_track ADD COLUMN steps jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE world.van_track
  ADD CONSTRAINT van_track_steps_array CHECK (jsonb_typeof(steps) = 'array');
