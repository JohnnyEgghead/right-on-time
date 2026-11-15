-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Known-bad (F-149): timestamptz(3) in a table with no declared zone; format_type says timestamp(3) with time zone.
ALTER TABLE world.equipment ADD COLUMN serviced_at timestamptz(3);
