-- P10-BOOKING-KEY (SPECIFICATIONS v0.23 section 3 `job.booking_key`, section 6.1 Booking write; FR-BOOK-1; plan v0.63 D-34; F-2011 K-01,
-- F-2040). Forward-only (SD-40).
-- job.booking_key: the booking page's key for 1 draft (API-113 bookingKey, a UUID v4 string). A repeated Confirm of the draft sends it
-- again, and bookOnline answers the job that holds it instead of booking a second visit. Null for every job the online page did not
-- book (office, seed) and for every job booked before this migration.
-- The unique constraint is what settles 2 sends of 1 key that race onto different days (2 booking-day rows, so no lock serializes them):
-- the second insert waits on the first, then fails on job_booking_key_key, and bookOnline rolls it back and answers as a repeat. Its
-- index also serves the key lookup. A unique constraint on a nullable column allows many nulls, as job_booking_token_key does (0009).
-- Safe on a live database: adding a nullable column with no default rewrites no row. The reset (0014, system.restore_world, columns by
-- name) restores a snapshot taken before this migration with the column null. No grant changes (the grants are on the table, 0007).
ALTER TABLE world.job ADD COLUMN booking_key text;
ALTER TABLE world.job ADD CONSTRAINT job_booking_key_key UNIQUE (booking_key);
