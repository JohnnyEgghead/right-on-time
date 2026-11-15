-- SPDX-License-Identifier: AGPL-3.0-or-later
-- P6-ROUTING-MEMORY (OQ-42): the load day's legs the bake does not cover, as 1 JSON array for infra/load/route-burst.mjs.
-- infra/load/fixture.sql gives every job it adds (the Load Tech technicians' jobs) a leg copied from another baked track, so those
-- legs exist in the world only as copies: the bake routed none of their real stop pairs. Live routing (SD-49 step 2) is what would
-- answer each of them, so the burst asks the routing service for every one, from the leg's real from-point to its real to-point.
-- Run after fixture.sql, as the schema owner.
SELECT coalesce(json_agg(json_build_object(
         'branch', t.branch_id, 'fromRef', t.from_ref, 'toRef', t.to_ref,
         'from', CASE WHEN t.from_ref = 'depot' THEN json_build_array(b.depot_lon, b.depot_lat) ELSE json_build_array(fc.lon, fc.lat) END,
         'to', json_build_array(tc.lon, tc.lat)) ORDER BY t.branch_id, t.id), '[]'::json)
FROM world.van_track t
JOIN world.branch b ON b.id = t.branch_id
JOIN world.job tj ON tj.job_number::text = t.to_ref
JOIN world.customer tc ON tc.id = tj.customer_id
JOIN world.technician tt ON tt.id = tj.technician_id
LEFT JOIN world.job fj ON t.from_ref <> 'depot' AND fj.job_number::text = t.from_ref
LEFT JOIN world.customer fc ON fc.id = fj.customer_id
WHERE tj.date = '2026-09-15' AND tt.name LIKE 'Load Tech %';
