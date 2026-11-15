-- P3-REPLAY (SPECIFICATIONS SD-12; F-150 replay half, F-323 reset half). Forward-only (SD-40).
-- The world half of a reset: lock every `world` table, truncate, insert from `world_snapshot`, reset the sequences, and
-- refresh the planner statistics of the tables it refilled. The clock half (epoch + 1, the mover, the clock_move row)
-- is the caller's, in the same transaction (packages/db/src/world-reset.ts).
--
-- Why a SECURITY DEFINER function (F-150): section 3 gives role app no TRUNCATE, no read of world_snapshot and no write
-- to membership, and the reset runs in the web process (API-14) and the worker (idle and nightly resets), both members
-- of app. The function runs as its owner, the schema owner login that runs the migrations and setup (SD-12), so app
-- gets exactly 1 new power: EXECUTE on this function, which restores the day-start snapshot and nothing else. Its
-- search_path is pinned and every name in it is schema-qualified.
--
-- Order of the inserts: foreign keys inside world are not deferrable (0004), so a table is filled only after every
-- table it references; a table's references to itself are checked at the end of its 1 INSERT ... SELECT. A cycle
-- between 2 tables is refused by name rather than half-restored.
-- Columns: by name, the ones world and the snapshot share, so a column a later migration added to a world table takes
-- its default instead of breaking the reset. A world table with no snapshot table stays empty.
-- Sequences: TRUNCATE ... RESTART IDENTITY puts each identity back to its start; each is then set past the largest
-- restored value (the job number sequence: the snapshot's jobs keep their numbers and the next job follows them).
-- Statistics (F-323, the F-314 trap): a bulk load into just-emptied tables leaves stale planner statistics, and with
-- autovacuum off or slow the next queries plan for empty tables. ANALYZE runs on each refilled table inside the
-- transaction (it sees the transaction's own rows), so its statistics commit with the reset.
CREATE FUNCTION system.restore_world() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  tables text[];
  done text[] := '{}';
  pending text[];
  t text;
  cols text;
  moved boolean;
  seq record;
BEGIN
  SELECT coalesce(array_agg(c.relname::text ORDER BY c.relname), '{}') INTO tables
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'world' AND c.relkind IN ('r', 'p');
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'world_snapshot' AND c.relkind IN ('r', 'p')) THEN
    RAISE EXCEPTION 'world_snapshot holds no tables: setup has not written the day-start snapshot (SD-12)'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  EXECUTE 'LOCK TABLE ' || (SELECT string_agg(format('world.%I', x), ', ') FROM unnest(tables) x) || ' IN ACCESS EXCLUSIVE MODE';
  EXECUTE 'TRUNCATE ' || (SELECT string_agg(format('world.%I', x), ', ') FROM unnest(tables) x) || ' RESTART IDENTITY';

  pending := tables;
  WHILE cardinality(pending) > 0 LOOP
    moved := false;
    FOREACH t IN ARRAY pending LOOP
      -- Ready when every world table it references (other than itself) is already filled.
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint k
          JOIN pg_class src ON src.oid = k.conrelid JOIN pg_namespace sn ON sn.oid = src.relnamespace
          JOIN pg_class ref ON ref.oid = k.confrelid JOIN pg_namespace rn ON rn.oid = ref.relnamespace
         WHERE k.contype = 'f' AND sn.nspname = 'world' AND src.relname = t AND rn.nspname = 'world'
           AND ref.relname <> t AND NOT (ref.relname = ANY(done))
      ) THEN
        SELECT string_agg(format('%I', w.attname), ', ' ORDER BY w.attnum) INTO cols
          FROM pg_attribute w
          JOIN pg_attribute s ON s.attname = w.attname AND s.attnum > 0 AND NOT s.attisdropped
           AND s.attrelid = (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                              WHERE n.nspname = 'world_snapshot' AND c.relname = t AND c.relkind IN ('r', 'p'))
         WHERE w.attrelid = format('world.%I', t)::regclass AND w.attnum > 0 AND NOT w.attisdropped
           AND w.attgenerated = '';
        IF cols IS NOT NULL THEN
          EXECUTE format('INSERT INTO world.%I (%s) OVERRIDING SYSTEM VALUE SELECT %s FROM world_snapshot.%I', t, cols, cols, t);
        END IF;
        done := done || t;
        pending := array_remove(pending, t);
        moved := true;
      END IF;
    END LOOP;
    IF NOT moved THEN
      RAISE EXCEPTION 'world tables % reference each other in a cycle; the reset cannot order their inserts', pending
        USING ERRCODE = 'invalid_table_definition';
    END IF;
  END LOOP;

  FOR seq IN
    SELECT a.attrelid::regclass AS tbl, a.attname AS col, pg_get_serial_sequence(format('world.%I', c.relname), a.attname) AS name
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'world' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
       AND pg_get_serial_sequence(format('world.%I', c.relname), a.attname) IS NOT NULL
  LOOP
    EXECUTE format('SELECT setval(%L, max(%I)) FROM %s HAVING max(%I) IS NOT NULL', seq.name, seq.col, seq.tbl, seq.col);
  END LOOP;

  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ANALYZE world.%I', t);
  END LOOP;
  RETURN cardinality(tables);
END;
$$;

REVOKE ALL ON FUNCTION system.restore_world() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system.restore_world() TO app;
