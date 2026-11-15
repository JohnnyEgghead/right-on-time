-- P4-CLOSE (F-896; P4-LOAD finding). Forward-only (SD-40).
-- system.delay_sample had an index on emitted_real only (0005), but 3 readers filter on acked_real: API-172's per-post prune
-- (packages/api-server/src/handlers/health.ts), the health page's window read (health-page.ts) and the worker's alert rule
-- (apps/worker/src/alerts/rules.ts). Each scanned the whole table, which grows for 24 hours (22,002 rows before the load day's
-- run 1, 73,826 after run 5). This adds the index they filter on. It holds no data of its own, adds no column and changes no
-- grant, so section 3's column table needs no line. A plain CREATE INDEX is safe here: the table holds at most 24 hours of
-- samples and the build takes a short lock on it, and the reset leaves the table alone.
CREATE INDEX delay_sample_acked ON system.delay_sample (acked_real);
