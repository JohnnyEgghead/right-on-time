-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Known-bad (P2-SCHEMA acceptance): a column the database has and section 3 does not.
ALTER TABLE world.customer ADD COLUMN nickname text;
