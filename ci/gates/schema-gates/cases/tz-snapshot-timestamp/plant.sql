-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Known-bad (F-149): a day-start copy in world_snapshot that gained a timestamp (no time zone) column.
CREATE TABLE world_snapshot.equipment AS SELECT * FROM world.equipment;
ALTER TABLE world_snapshot.equipment ADD COLUMN stamp timestamp;
