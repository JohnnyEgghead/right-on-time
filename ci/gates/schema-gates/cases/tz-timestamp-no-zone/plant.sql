-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Known-bad (P2-SCHEMA acceptance): a `timestamp` column (no time zone) in a table with no zone column and no
-- zone-registry entry (equipment stores no time today).
ALTER TABLE world.equipment ADD COLUMN serviced_at timestamp;
