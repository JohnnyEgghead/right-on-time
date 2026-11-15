-- P4-MESSAGES fix pass (F-653, F-651). A visit has at most 1 reminder call row per call date (FR-TEXT-13: the call list
-- row of a customer with no mobile or texts off, reason no_mobile or texts_off). Before this, a reschedule the same
-- evening after the reminder event had fired planned a 2nd at-once event, and its fire wrote a 2nd row for the same job
-- and call_date, so the call list showed the customer twice (1 row with the old outcome). The writers (fireReminder and
-- API-38's first outcome on a listed visit, packages/outbox/src/call-list.ts) insert with ON CONFLICT DO NOTHING; this
-- index is the rule for every writer. Rows for a failed text (text_gave_up, added_by_office) are keyed by text_id and
-- stay outside it: a visit can be on the list for a reminder and for a failed text.
--
-- Partial, so section 3's column table is unchanged (schema-doc-parity reads only whole-column unique indexes); the
-- SPECIFICATIONS sentence comes in the phase 4 doc batch (F-446's row). No existing database holds a duplicate: the
-- writer that could make one existed only on the unmerged P4-MESSAGES branch. Forward-only (SD-40).
CREATE UNIQUE INDEX call_list_entry_reminder_once ON world.call_list_entry (job_number, call_date)
  WHERE reason IN ('no_mobile', 'texts_off');
