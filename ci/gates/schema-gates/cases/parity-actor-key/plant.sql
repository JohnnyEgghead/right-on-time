-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Known-bad (F-864, section 3 Nullability and keys): time_block_change.actor_user_id loses its foreign key to world.user.id.
ALTER TABLE world.time_block_change DROP CONSTRAINT time_block_change_actor_user_id_fkey;
