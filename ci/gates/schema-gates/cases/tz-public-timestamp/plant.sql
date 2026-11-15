-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Known-bad (F-149): a timestamp column in a table in public, outside the 5 stores.
CREATE TABLE public.stray (at timestamp);
