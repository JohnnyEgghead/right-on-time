-- SPDX-License-Identifier: AGPL-3.0-or-later
-- P3-BACKUP (SPECIFICATIONS section 11.7): the import rows of a restored database, compared with the FR-IMP-6
-- targets (REQUIREMENTS "Import target counts"; infra/tests/backup.test.ts keeps the numbers below equal to that
-- table). Rows with source = import (equipment and past visits have no source column, so a row is an imported one when the
-- day-start copy in world_snapshot holds its id, F-391: a piece of equipment a visitor adds (API-141) is not in that copy), the real run's problem rows, and its pairs. Merges keep rows, so a visitor's
-- merge changes none of these counts (a pair's status changes, never its kind). Run in restore_check by
-- restore-test.sh; prints 1 line per item: name|target|actual.
WITH real_run AS (
  SELECT id FROM world.import_run WHERE kind = 'real' AND status = 'done'
), problems AS (
  SELECT p.* FROM world.import_problem_row p WHERE p.run_id IN (SELECT id FROM real_run)
), pairs AS (
  SELECT d.* FROM world.duplicate_pair d WHERE d.run_id IN (SELECT id FROM real_run)
), actual(item, target, n) AS (
  VALUES
    ('real import runs', 1, (SELECT count(*) FROM real_run)),
    ('customers imported', 18400, (SELECT count(*) FROM world.customer WHERE source = 'import')),
    ('customers imported and flagged', 488, (SELECT count(DISTINCT flagged_entity_id) FROM problems
                                             WHERE reason IN ('missing_zip', 'bad_phone', 'customer_name_blank'))),
    ('service visits imported', 95870, (SELECT count(*) FROM world.past_visit v WHERE EXISTS (SELECT 1 FROM world_snapshot.past_visit s WHERE s.id = v.id))),
    ('equipment imported', 30904, (SELECT count(*) FROM world.equipment e WHERE EXISTS (SELECT 1 FROM world_snapshot.equipment s WHERE s.id = e.id))),
    ('problem rows', 1184, (SELECT count(*) FROM problems)),
    ('problem rows: visit with no customer', 418, (SELECT count(*) FROM problems WHERE reason = 'visit_no_customer')),
    ('problem rows: missing ZIP code', 214, (SELECT count(*) FROM problems WHERE reason = 'missing_zip')),
    ('problem rows: bad phone number', 187, (SELECT count(*) FROM problems WHERE reason = 'bad_phone')),
    ('problem rows: visit date not readable', 124, (SELECT count(*) FROM problems WHERE reason = 'visit_date_unreadable')),
    ('problem rows: equipment with no address', 154, (SELECT count(*) FROM problems WHERE reason = 'equipment_no_address')),
    ('problem rows: customer name blank', 87, (SELECT count(*) FROM problems WHERE reason = 'customer_name_blank')),
    ('likely duplicates', 1240, (SELECT count(*) FROM pairs)),
    ('likely duplicates: exact', 812, (SELECT count(*) FROM pairs WHERE kind = 'exact')),
    ('likely duplicates: listed for the office', 428, (SELECT count(*) FROM pairs WHERE kind <> 'exact'))
)
SELECT item || '|' || target || '|' || n FROM actual;
