-- P2-SEED (F-334 to F-338). SPECIFICATIONS v0.7 section 3: past_visit gains work_done; user_change, system.access_code and
-- system.delay_sample gain a uuid primary key id; outbox_text.link_token references link_token.token. Forward-only (SD-40).
-- Grants (0007) are table-level, so the new columns need none.

-- past_visit.work_done: text null, the old system's work-done cell (an empty cell stays null).
ALTER TABLE world.past_visit ADD COLUMN work_done text;

-- The Identifiers rule: uuidv7() keys. The volatile default fills every existing row with its own id on ADD COLUMN.
ALTER TABLE world.user_change ADD COLUMN id uuid PRIMARY KEY DEFAULT uuidv7();
ALTER TABLE system.access_code ADD COLUMN id uuid PRIMARY KEY DEFAULT uuidv7();
ALTER TABLE system.delay_sample ADD COLUMN id uuid PRIMARY KEY DEFAULT uuidv7();

-- outbox_text.link_token (nullable) names the live token the text carries. Not deferrable, like the other world keys (0004).
ALTER TABLE world.outbox_text
  ADD CONSTRAINT outbox_text_link_token_fkey FOREIGN KEY (link_token) REFERENCES world.link_token (token);
