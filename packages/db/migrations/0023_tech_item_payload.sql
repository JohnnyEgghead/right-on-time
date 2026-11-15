-- P5-CLOSE (F-1139; SPECIFICATIONS section 3 tech_item.payload, section 5.1 steps 8 and 10, API-20; owner ruling c4aa4366, Nov 9,
-- 2026, "Keep and show it"). Forward-only (SD-40).
-- A flagged item (or one refused for a reason the phone cannot fix, listed for the dispatcher like a flagged item) used to lose what the
-- technician entered: the server answered flagged and kept the message only, so the dispatcher could not re-enter the work without
-- calling the technician. The ledger row now keeps the entry in `payload`: a finish's parts, No parts used, labor minutes and
-- work-done lines, or a note's text, as API-102 carried them. It is written with the row (the ledger is append-only for role app, 0007,
-- so there is no later UPDATE) and only for a flagged answer; every other result, and a status item, leaves it null.
-- Safe on a live database: adding a nullable column with no default rewrites nothing. No grant changes (the grants are on the table, 0007).
ALTER TABLE world.tech_item ADD COLUMN payload jsonb;
ALTER TABLE world.tech_item
  ADD CONSTRAINT tech_item_payload_only_flagged CHECK (payload IS NULL OR result = 'flagged');
