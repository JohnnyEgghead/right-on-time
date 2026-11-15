-- W23 closing pass (F-826; FR-TEXT-2, SPECIFICATIONS section 6.4: the planner writes 1 text.reminder event per job). A job has at
-- most 1 DUE reminder event. The planner read for an open event and then inserted, under no lock, so 2 writers at once could
-- each find none and both insert. It now writes with ON CONFLICT on this index (planReminder, packages/outbox/src/triggers.ts),
-- so the second writer waits for the first and moves the first's row.
--
-- Partial on state = 'due': a reminder that has run stays as its record, and a visit moved after that run gets a new due event
-- (F-446, F-653), so a job can hold 1 done event and 1 due event. Partial, so section 3's column table is unchanged
-- (schema-doc-parity reads only whole-column unique indexes); the SPECIFICATIONS sentence comes in the phase 4 doc batch.
--
-- The seed plans 1 event per scheduled job, so the world_snapshot rows a reset restores already hold. A live database could hold
-- a double from before F-824's fix (a zone edit planned a second one): the planner kept the first in (due_at, id) order, so that
-- row stays and any other due row ends skipped, as an event the planner no longer wants does. Forward-only (SD-40).
UPDATE world.scheduled_event e
   SET state = 'skipped', run_at = e.due_at, result = 'reminder_not_planned'
 WHERE e.kind = 'text.reminder' AND e.state = 'due'
   AND e.id <> (SELECT f.id FROM world.scheduled_event f
                 WHERE f.kind = 'text.reminder' AND f.state = 'due' AND f.subject = e.subject
                 ORDER BY f.due_at, f.id LIMIT 1);

CREATE UNIQUE INDEX scheduled_event_reminder_once ON world.scheduled_event (subject)
  WHERE kind = 'text.reminder' AND state = 'due';
