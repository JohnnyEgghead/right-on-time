-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Known-bad (F-149): an array of timestamp (no time zone).
ALTER TABLE world.equipment ADD COLUMN serviced_at timestamp[];
