-- P3-IMPORT-WORKER (F-323 part 1). The worker executes the office's import runs (SPECIFICATIONS section 2 "Import
-- runner"; @bw/import runPendingImport). A real run bulk-loads an empty world in 1 transaction, and until autoanalyze
-- reaches the tables the planner may still hold the counts of an autovacuum that ran while that transaction was open
-- (0 rows over hundreds of pages: the F-314 trap, 190 s joins). Setup ANALYZEs them as the schema owner; the worker's
-- login gets MAINTAIN on the same 7 tables so it can ANALYZE them after its real run commits. Only bw_worker: web and
-- pbs never load in bulk, so role app keeps exactly 0007's privileges. Forward-only (SD-40).
GRANT MAINTAIN ON world.customer, world.past_visit, world.equipment, world.import_problem_row, world.duplicate_pair, world."merge",
  world.import_run TO bw_worker;
