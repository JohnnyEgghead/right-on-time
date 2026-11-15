-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Known-bad (F-149): a domain over timestamp (no time zone).
CREATE DOMAIN public.stamp AS timestamp;
ALTER TABLE world.equipment ADD COLUMN serviced_at public.stamp;
