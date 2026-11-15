-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Known-bad (section 3 Time rule): a timestamptz column in a table that names no zone (no zone column, no registry
-- entry). The type alone is not enough: its local reading needs a zone owner.
ALTER TABLE world.van ADD COLUMN bought_at timestamptz;
