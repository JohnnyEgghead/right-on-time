-- P2-SEED (F-151, F-153). SPECIFICATIONS v0.6 section 3: user gains name and name_search; technician.user_id,
-- customer.inbox_token and job.booking_token (where set) are unique. Forward-only (SD-40).

-- user.name and name_search: NOT NULL, no default after this migration. The temporary default lets the ADD succeed on a
-- database that already holds user rows; the seed and the invite paths write the real values.
ALTER TABLE world."user"
  ADD COLUMN name        text NOT NULL DEFAULT '',
  ADD COLUMN name_search text NOT NULL DEFAULT '';
ALTER TABLE world."user"
  ALTER COLUMN name DROP DEFAULT,
  ALTER COLUMN name_search DROP DEFAULT;

-- API-149's search matches name_search by substring, as the customer list does (0005).
CREATE INDEX user_name_search_trgm ON world."user" USING gin (name_search public.gin_trgm_ops);

-- At most 1 technician per user (the user 1 to 0..1 technician line of section 3's sketch). The unique constraint
-- serves every lookup the plain index technician_user (0005) served, so that index goes.
ALTER TABLE world.technician ADD CONSTRAINT technician_user_id_key UNIQUE (user_id);
DROP INDEX world.technician_user;

-- API-120 finds the customer by inbox_token, API-114 the job by booking_token. A unique constraint on a nullable column
-- allows many nulls, so every job without an online booking stays valid.
ALTER TABLE world.customer ADD CONSTRAINT customer_inbox_token_key UNIQUE (inbox_token);
DROP INDEX world.customer_inbox_token;
ALTER TABLE world.job ADD CONSTRAINT job_booking_token_key UNIQUE (booking_token);
DROP INDEX world.job_booking_token;
