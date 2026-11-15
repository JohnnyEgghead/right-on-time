-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Known-bad (P2-SCHEMA acceptance): a column section 3 has and the database does not.
ALTER TABLE world.job DROP COLUMN problem;
