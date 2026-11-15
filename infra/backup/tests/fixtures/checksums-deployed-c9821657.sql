-- SPDX-License-Identifier: AGPL-3.0-or-later
-- F-1582 test oracle, never run by the product: after these 4 header lines, infra/backup/checksums.sql as deployed before F-1579 (commit c9821657),
-- the code that made the key-only sets now in the hosted bucket. infra/backup/tests/backup.stack.test.ts computes an old-way
-- manifest with it, so the key-only-v1 method of the current checksums.sql is checked against the real old code, not itself.
-- P3-BACKUP (SPECIFICATIONS section 11.7): per-table row counts and checksums for the schemas world, pbs and system,
-- as 1 jsonb object {"<schema>.<table>": {"rows": n, "md5": "<hex>"}}. The checksum is MD5 over the primary keys in
-- key order: each key as row(...)::text, joined by newlines. A table with no primary key (system.delay_sample) uses
-- its whole rows, in their text order. Both backup.sh (inside the backup's REPEATABLE READ snapshot) and
-- restore-test.sh (in restore_check) run this same file, so the 2 sides are computed alike.
-- pg_temp: the function lives only in this session and leaves nothing in the database.
CREATE FUNCTION pg_temp.bw_checksums() RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
  t record;
  r record;
  out jsonb := '{}';
BEGIN
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
    EXECUTE format(
      'SELECT count(*) AS n, md5(coalesce(string_agg(%1$s, E''\n'' ORDER BY %2$s), '''')) AS h FROM %3$I.%4$I x',
      CASE WHEN t.keycols IS NULL THEN 'x::text' ELSE format('row(%s)::text', t.keycols) END,
      coalesce(t.keycols, 'x::text'), t.nspname, t.relname) INTO r;
    out := out || jsonb_build_object(t.nspname || '.' || t.relname, jsonb_build_object('rows', r.n, 'md5', r.h));
  END LOOP;
  RETURN out;
END
$fn$;
