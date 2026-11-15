-- P5-TWA-OUTBOX (F-562; SPECIFICATIONS section 5.1 step 10, UI-SPECIFICATION 4.5 rule 10; owner ruling 546d6f1e, "Send to the
-- dispatcher"). Forward-only (SD-40).
-- An item the server refuses for a reason the phone cannot fix is listed for the dispatcher like a flagged item, so it leaves
-- the phone. A not_found item for a job number the world does not hold (and a validation_failed one from a future world
-- epoch for such a number) had no job for its rows to name: offline_conflict.job_number and tech_item.job_number reference
-- world.job (0002, 0004), so the server answered it and stored nothing, and the dispatcher never saw it.
-- The design call (F-562): a nullable job reference on both rows, not a separate list. The flagged items list stays 1 table
-- read by API-20 and the alert rule, so the dispatcher sees the item exactly as any flagged item, with Mark handled; the
-- number the phone sent stays in the row's message_values (`job`), which the list already renders. The ledger row is
-- written too, so a resend of the key answers duplicate with the stored message and lists nothing twice (invariant 1).
-- Both foreign keys stay: a set job_number still names a real job. A null one is allowed only for these 2 refusals: the
-- CHECK constraints below hold it to the flagged answer of not_found or validation_failed, so no other row can drop its job.
-- SPECIFICATIONS section 3's `job_number` rows of tech_item and offline_conflict change in the doc batch (BUILD_PLAN
-- P5-TWA-OUTBOX); until then ci/gates/schema-gates/checks.ts lists these 2 nullability lines as pending, by name.
-- Safe on a live database: dropping NOT NULL rewrites nothing; each CHECK is validated against rows that all hold a job.
-- No grant changes (the grants are on the tables, 0007).
ALTER TABLE world.tech_item ALTER COLUMN job_number DROP NOT NULL;
ALTER TABLE world.tech_item
  ADD CONSTRAINT tech_item_job_number_only_unlisted_refusal CHECK (
    job_number IS NOT NULL
    OR (result = 'flagged' AND message_key IN ('tech.item.flagged.not_found', 'tech.item.flagged.validation_failed'))
  );

ALTER TABLE world.offline_conflict ALTER COLUMN job_number DROP NOT NULL;
ALTER TABLE world.offline_conflict
  ADD CONSTRAINT offline_conflict_job_number_only_unlisted_refusal CHECK (
    job_number IS NOT NULL
    OR (message_key IN ('offline.flag.not_found', 'offline.flag.validation_failed') AND message_values ? 'job')
  );
