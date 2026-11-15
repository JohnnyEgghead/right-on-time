-- Phase 4 doc batch (F-864; SPECIFICATIONS section 3 "Nullability and keys": an `actor_user_id` column references user.id).
-- Migration 0015 made world.time_block_change without the key that rule expects, so schema-doc-parity would fail once the
-- table's section 3 row lands. This adds it. The column stays nullable, as in 0015 and the column table (null for an actor
-- who is not an office user). `block_id` stays a plain value with no key: a deleted block keeps its history.
--
-- Safe on a live database: the table is small and append-only, and the key takes only a short lock on it and on world.user.
-- moveBlock writes the signed-in office user's id, so a row whose actor_user_id names no user row is not expected. If one
-- exists (a user row removed before this key), the key cannot be added with it as it stands. The row is kept, never deleted:
-- its actor_user_id becomes null (the column's own "no office user" value) and the id it held is kept in data as
-- unresolved_actor_user_id, so the history still says who the writer named. Nothing is changed when every id resolves.
-- No trigger or grant change: the table's grant (SELECT, INSERT to app, 0015) is on the table, not the column, and a key
-- adds no privilege. Forward-only (SD-40).
UPDATE world.time_block_change c
   SET actor_user_id = NULL,
       data = c.data || jsonb_build_object('unresolved_actor_user_id', c.actor_user_id)
 WHERE c.actor_user_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM world."user" u WHERE u.id = c.actor_user_id);

ALTER TABLE world.time_block_change
  ADD CONSTRAINT time_block_change_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES world."user" (id);
