// SPDX-License-Identifier: AGPL-3.0-or-later
// 1 repository module per entity (SD-2), held to the migrated schema itself: every table has exactly 1 repository,
// each repository's columns and key are the table's, its access is role app's real privileges, the committed modules
// are what the generator renders from this database, and the SQL they issue works as role app.
import { describe, expect, it } from 'vitest';
import { existingFiles, drift, readRelations, renderAll } from './cli/generate-repositories.ts';
import {
  branchRepository, jobChangeRepository, jobRepository, repositories, reportVisitRepository, streetRepository, textSimulatorRepository,
} from './repositories/index.ts';
import { attempt, seedReference, useMigratedDatabase } from './testing/fixture.ts';

const db = useMigratedDatabase();

describe('the repository set', () => {
  // why: SD-2
  it('has exactly 1 repository per table and view, with the table own columns, in order, and its primary key', async () => {
    const rels = await readRelations(db.admin());
    const byId = new Map(repositories.map((r) => [`${r.def.schema}.${r.def.table}`, r]));
    expect(repositories.length).toBe(byId.size); // no table has 2
    expect([...byId.keys()].sort()).toEqual(rels.map((r) => `${r.schema}.${r.table}`).sort());
    expect(rels.length).toBe(63); // 61 section 3 tables, the block change log (migration 0015; its section 3 row comes in the phase 4 doc batch) and the report_visit view
    for (const rel of rels) {
      const repo = byId.get(`${rel.schema}.${rel.table}`);
      expect(repo?.def.columns, rel.table).toEqual(rel.columns.map((c) => c.name));
      expect(repo?.def.key, rel.table).toEqual(rel.key);
    }
  });

  // why: FR-DISP-5, FR-DISP-32
  it('gives each repository the access role app really has: no update or delete where the database refuses them', async () => {
    const { rows } = await db.admin().query<{ id: string; ins: boolean; upd: boolean; del: boolean }>(`
      SELECT n.nspname || '.' || c.relname AS id, has_table_privilege('app', c.oid, 'INSERT') AS ins,
             has_table_privilege('app', c.oid, 'UPDATE') AS upd, has_table_privilege('app', c.oid, 'DELETE') AS del
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('world', 'system') AND c.relkind IN ('r', 'v') AND c.relname <> 'schema_migration'`);
    const access = new Map(repositories.map((r) => [`${r.def.schema}.${r.def.table}`, r.def.access]));
    for (const r of rows) {
      const expected = !r.ins ? 'read-only' : !r.upd && !r.del ? 'append-only' : r.upd && r.del ? 'mutable' : 'mixed';
      expect(access.get(r.id), r.id).toBe(expected);
    }
    expect(rows.length).toBeGreaterThan(50);
  });

  // why: SD-2
  it('matches what the generator renders from this migrated database, file for file', async () => {
    const fresh = renderAll(await readRelations(db.admin()));
    expect(drift(fresh, existingFiles())).toEqual([]);
  });
});

describe('repository SQL, as role app', () => {
  // why: SD-2
  it('inserts, reads, finds, updates and removes a mutable entity', async () => {
    await db.asRole('app', async (q) => {
      const b = await branchRepository.insert(q, { id: 'dayton', name_key: 'b.d', zone: 'America/New_York', office_phone: '(937) 555-0101',
        depot_lon: -84.19, depot_lat: 39.76, map_file: 'dayton.pmtiles' });
      expect(b.depot_lat).toBe(39.76);
      expect(await branchRepository.get(q, { id: 'dayton' })).toEqual(b);
      const [changed] = await branchRepository.update(q, { id: 'dayton' }, { office_phone: '(937) 555-0199' });
      expect(changed?.office_phone).toBe('(937) 555-0199');
      expect(await branchRepository.find(q, { zone: 'America/New_York' }, { orderBy: [['id', 'asc']] })).toHaveLength(1);
      expect(await branchRepository.remove(q, { id: 'dayton' })).toBe(1);
      expect(await branchRepository.get(q, { id: 'dayton' })).toBeNull();
    });
  });

  // why: SD-2
  it('numbers jobs from 24800, keeps a date as its local text, sends jsonb arrays as JSON, and matches null with IS NULL', async () => {
    await db.asRole('app', async (q) => {
      const ref = await seedReference(q);
      const street = await streetRepository.insert(q, { name: 'Main St', name_search: 'main st', city: 'Dayton', zip: '45402',
        branch_id: 'columbus', points: [[-84.19, 39.76], [-84.2, 39.77]] });
      expect(street.points).toEqual([[-84.19, 39.76], [-84.2, 39.77]]);
      const job = await jobRepository.insert(q, {
        customer_id: ref.customerId, branch_id: 'columbus', service_id: 'tune_up', date: '2026-09-15', zone: 'America/New_York',
        window_id: ref.windowId, window_start: new Date('2026-09-15T12:00:00Z'), window_end: new Date('2026-09-15T14:00:00Z'),
        status: 'scheduled', version: 1, expected_minutes: 60, booked_via: 'office', booked_at: new Date('2026-09-14T12:00:00Z'),
        billing_state: 'not_sent', autopilot: false, touched_by_person: false, pilot: false,
      });
      expect(job.job_number).toBeGreaterThanOrEqual(24800);
      expect(job.date).toBe('2026-09-15');
      expect(job.window_start.toISOString()).toBe('2026-09-15T12:00:00.000Z');
      expect(job.no_parts_used).toBe(false);
      expect(await jobRepository.find(q, { technician_id: null })).toHaveLength(1);
      expect(await reportVisitRepository.find(q)).toEqual([]);
    });
  });

  // why: FR-DISP-5
  it('appends history but its repository has no update or remove, and the database refuses them anyway', async () => {
    await db.asRole('app', async (q) => {
      const ref = await seedReference(q);
      const job = await q.query<{ job_number: number }>(`INSERT INTO world.job (customer_id, branch_id, service_id, date, zone, window_id,
        window_start, window_end, status, version, expected_minutes, booked_via, booked_at, billing_state, autopilot, touched_by_person, pilot)
        VALUES ($1, 'columbus', 'tune_up', '2026-09-15', 'America/New_York', $2, now(), now(), 'scheduled', 1, 60, 'office', now(),
        'not_sent', false, false, false) RETURNING job_number`, [ref.customerId, ref.windowId]);
      const row = await jobChangeRepository.insert(q, { job_number: job.rows[0]?.job_number ?? 0, at: new Date('2026-09-15T11:00:00Z'),
        actor_kind: 'office', kind: 'created', from_version: 0, to_version: 1, data: { key: 'job.created' } });
      expect(row.data).toEqual({ key: 'job.created' });
      expect('update' in jobChangeRepository).toBe(false);
      expect('remove' in jobChangeRepository).toBe(false);
      expect(await attempt(q, 'UPDATE world.job_change SET kind = $1', ['details'])).toBe('42501');
    });
  });

  // why: SD-2
  it('refuses an unknown column before any SQL is sent, and an update that names no row', async () => {
    await db.asRole('app', async (q) => {
      await expect(branchRepository.find(q, { ['id; DROP TABLE world.job' as 'id']: 'x' })).rejects.toThrow(/has no column id; DROP/);
      await expect(branchRepository.update(q, {}, { zone: 'UTC' })).rejects.toThrow(/names no row/);
      // A 1-row table may be updated without naming its row.
      await textSimulatorRepository.insert(q, { mode: 'up' });
      expect((await textSimulatorRepository.update(q, {}, { mode: 'all_fail' }))[0]?.mode).toBe('all_fail');
    });
  });
});
