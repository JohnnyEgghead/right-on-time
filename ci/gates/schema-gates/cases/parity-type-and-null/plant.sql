-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Known-bad (section 3 "Nullability and keys"): parity compares types and nullability, not only names.
-- The integer job version (D15) widened to bigint, and a nullable column made NOT NULL.
ALTER TABLE world.job ALTER COLUMN version TYPE bigint;
ALTER TABLE world.job ALTER COLUMN problem SET NOT NULL;
