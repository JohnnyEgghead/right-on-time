-- SPDX-License-Identifier: AGPL-3.0-or-later
-- P3-BACKUP (SPECIFICATIONS section 11.7): per-table row counts and checksums for the schemas world, pbs and system,
-- as 1 jsonb object {"<schema>.<table>": {"rows": n, "md5": "<hex>"}}. backup.sh (inside the backup's REPEATABLE READ
-- snapshot), restore-test.sh (in restore_check) and the drill's restore-copy.sh run this same file, so the sides are
-- computed alike. pg_temp: the functions live only in this session and leave nothing in the database.
--
-- Checksum methods (F-1582). A manifest names the method its checksums were made with in its field checksum_method; a
-- manifest with no such field was made by the code before F-1579 and is key-only-v1. A checker computes the restored
-- side with the method the manifest names (pg_temp.bw_checksum_method) and stops on a method it does not know.
--   key-only-v1  MD5 over the primary keys in key order: each key as row(...)::text, joined by newlines. A table with no
--                primary key (system.delay_sample) uses its whole rows, in their text order. In the session's own
--                settings, as the code before F-1579 ran it. Kept so the sets made before F-1579 check clean until they
--                expire; it sees a changed key or row count, not a changed value outside a key.
--   full-row-v2  MD5 over the whole rows, every column (F-1579: a changed value outside a key must fail the compare as a
--                changed key does): each row as its row text (x::text, the columns in table order), joined by newlines, in
--                primary key order; a table with no primary key orders its rows by that text, in the C collation.
--                pg_temp.bw_checksums_full_row's SET clauses fix, for its own call only, every setting a row's text depends
--                on (time zone, date and interval style, float digits, bytea form), so the 2 sides agree whatever their
--                sessions set. New backups write this method (pg_temp.bw_checksum_method_written).

-- The method new backups write.
CREATE FUNCTION pg_temp.bw_checksum_method_written() RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT 'full-row-v2' $fn$;

-- The method a manifest names: key-only-v1 when it has no checksum_method field; an error on any other value this file does not know.
CREATE FUNCTION pg_temp.bw_checksum_method(m jsonb) RETURNS text LANGUAGE plpgsql AS $fn$
DECLARE
  v text := CASE WHEN m ? 'checksum_method' THEN m->>'checksum_method' ELSE 'key-only-v1' END;
BEGIN
  IF v IS NULL OR v NOT IN ('key-only-v1', 'full-row-v2') THEN
    RAISE EXCEPTION 'unknown checksum method % in the manifest: this code knows key-only-v1 (a manifest with no checksum_method) and full-row-v2',
      coalesce('"' || v || '"', 'null');
  END IF;
  RETURN v;
END
$fn$;

-- The loop over every table, hashing and ordering as the method says. No settings of its own: key-only-v1 runs it as the
-- code before F-1579 did; full-row-v2 runs it through pg_temp.bw_checksums_full_row only.
CREATE FUNCTION pg_temp.bw_table_checksums(method text) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
  t record;
  r record;
  hashed text;
  ord text;
  out jsonb := '{}';
BEGIN
  IF method IS NULL OR method NOT IN ('key-only-v1', 'full-row-v2') THEN
    RAISE EXCEPTION 'unknown checksum method %', coalesce('"' || method || '"', 'null');
  END IF;
  FOR t IN
    SELECT n.nspname, c.relname,
           (SELECT string_agg(format('x.%I', a.attname), ', ' ORDER BY k.ord)
              FROM pg_index i
              CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
             WHERE i.indrelid = c.oid AND i.indisprimary) AS keycols
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('world', 'pbs', 'system') AND c.relkind IN ('r', 'p') AND NOT c.relispartition
     ORDER BY n.nspname, c.relname
  LOOP
    IF method = 'key-only-v1' THEN
      hashed := CASE WHEN t.keycols IS NULL THEN 'x::text' ELSE format('row(%s)::text', t.keycols) END;
      ord := coalesce(t.keycols, 'x::text');
    ELSE
      hashed := 'x::text';
      ord := coalesce(t.keycols, 'x::text COLLATE "C"');
    END IF;
    EXECUTE format(
      'SELECT count(*) AS n, md5(coalesce(string_agg(%1$s, E''\n'' ORDER BY %2$s), '''')) AS h FROM %3$I.%4$I x',
      hashed, ord, t.nspname, t.relname) INTO r;
    out := out || jsonb_build_object(t.nspname || '.' || t.relname, jsonb_build_object('rows', r.n, 'md5', r.h));
  END LOOP;
  RETURN out;
END
$fn$;

CREATE FUNCTION pg_temp.bw_checksums_full_row() RETURNS jsonb LANGUAGE sql
  SET "TimeZone" = 'UTC' SET "DateStyle" = 'ISO, YMD' SET "IntervalStyle" = 'postgres' SET extra_float_digits = 1
  SET bytea_output = 'hex'
AS $fn$ SELECT pg_temp.bw_table_checksums('full-row-v2') $fn$;

-- The checksums by the method named: pg_temp.bw_checksum_method's value (a checker) or pg_temp.bw_checksum_method_written's (a backup).
CREATE FUNCTION pg_temp.bw_checksums(method text) RETURNS jsonb LANGUAGE plpgsql AS $fn$
BEGIN
  IF method = 'full-row-v2' THEN RETURN pg_temp.bw_checksums_full_row(); END IF;
  RETURN pg_temp.bw_table_checksums(method);
END
$fn$;
