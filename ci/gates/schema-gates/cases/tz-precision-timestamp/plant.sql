-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Known-bad (F-149): a precision-modified timestamp; format_type says timestamp(0) without time zone.
ALTER TABLE world.equipment ADD COLUMN serviced_at timestamp(0);
