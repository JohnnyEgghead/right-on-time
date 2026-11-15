-- SPDX-License-Identifier: AGPL-3.0-or-later
-- P6-ROUTING-MEMORY (OQ-42; F-1305): the pairs infra/load/route-unrouted.mjs reads, as 1 line "<technician id> <fromJob> <toJob> <baked
-- fromJob> <baked toJob>". The unrouted pair runs from a technician's last job of the load day back to the first, which no row covers (no
-- day runs backward); the baked pair is 2 of the same technician's jobs that a row joins (from_ref, to_ref). The technician is the first,
-- by id, who has both. Run after fixture.sql, as the schema owner: psql -tA -F ' ' -f route-unrouted.sql
WITH day AS (
  SELECT j.technician_id, j.branch_id, j.job_number,
         row_number() OVER (PARTITION BY j.technician_id ORDER BY j.window_start, j.job_number) AS n,
         count(*) OVER (PARTITION BY j.technician_id) AS jobs
    FROM world.job j
   WHERE j.date = '2026-09-15' AND j.status <> 'canceled' AND j.technician_id IS NOT NULL
), pairs AS (
  SELECT f.technician_id,
         l.job_number AS from_job, f.job_number AS to_job,
         (SELECT a.job_number FROM day a JOIN day b ON b.technician_id = a.technician_id AND b.n = a.n + 1
            JOIN world.van_track t ON t.branch_id = a.branch_id AND t.from_ref = a.job_number::text AND t.to_ref = b.job_number::text
           WHERE a.technician_id = f.technician_id ORDER BY a.n LIMIT 1) AS baked_from
    FROM day f JOIN day l ON l.technician_id = f.technician_id AND l.n = l.jobs
   WHERE f.n = 1 AND f.jobs >= 3
     AND NOT EXISTS (SELECT 1 FROM world.van_track t WHERE t.branch_id = f.branch_id AND t.from_ref = l.job_number::text AND t.to_ref = f.job_number::text)
)
SELECT p.technician_id, p.from_job, p.to_job, p.baked_from,
       (SELECT b.job_number FROM day a JOIN day b ON b.technician_id = a.technician_id AND b.n = a.n + 1
         WHERE a.technician_id = p.technician_id AND a.job_number = p.baked_from)
  FROM pairs p
 WHERE p.baked_from IS NOT NULL
 ORDER BY p.technician_id
 LIMIT 1;
