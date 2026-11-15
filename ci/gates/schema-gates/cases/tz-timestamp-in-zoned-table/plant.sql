-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Known-bad (invariant 4): a `timestamp` column in a table that does have a zone column (job). A zone owner does not
-- make a zone-less type acceptable.
ALTER TABLE world.job ADD COLUMN legacy_at timestamp;
