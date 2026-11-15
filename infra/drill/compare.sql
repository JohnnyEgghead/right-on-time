-- SPDX-License-Identifier: AGPL-3.0-or-later
-- P8-RESTORE-DRILL: the restore test's compare (infra/backup/restore-test.sh step 4), the same text, for the restored live database
-- of a drill copy (infra/drill/restore-copy.sh). Run after checksums.sql in 1 session, with the manifest in psql variable m: 1 line
-- per table whose row count or checksum differs (or that only 1 side has), then '#tables <n>' (the manifest's table count).
-- The restored side is computed with the checksum method the manifest names (F-1582; checksums.sql): first '#method <name>',
-- and an unknown method stops the session with an error (ON_ERROR_STOP) before any line is compared.
-- infra/tests/restore-drill.test.ts fails when this body and restore-test.sh's drift apart.
SELECT '#method ' || pg_temp.bw_checksum_method(:'m'::jsonb);
WITH m AS (SELECT :'m'::jsonb->'tables' AS t), c AS (SELECT pg_temp.bw_checksums(pg_temp.bw_checksum_method(:'m'::jsonb)) AS t)
SELECT coalesce(a.k, b.k) || ': manifest ' || coalesce((a.v->>'rows') || ' rows md5 ' || (a.v->>'md5'), 'has no such table')
       || ', restored ' || coalesce((b.v->>'rows') || ' rows md5 ' || (b.v->>'md5'), 'has no such table')
  FROM jsonb_each((SELECT t FROM m)) a(k, v) FULL JOIN jsonb_each((SELECT t FROM c)) b(k, v) ON a.k = b.k
 WHERE a.v IS DISTINCT FROM b.v ORDER BY 1;
SELECT '#tables ' || count(*) FROM jsonb_object_keys(:'m'::jsonb->'tables');
