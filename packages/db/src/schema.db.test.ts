// SPDX-License-Identifier: AGPL-3.0-or-later
// The migrated schema's guarantees, checked through the real access wall: statements run as the database roles the
// processes use (SET ROLE app / pbs), so PostgreSQL itself refuses or allows each one.
import { describe, expect, it } from 'vitest';
import { pgVersion } from './testing/provided.ts';
import { attempt, insertJob, seedReference, useMigratedDatabase } from './testing/fixture.ts';

const db = useMigratedDatabase();

describe('the empty PostgreSQL 18 database, migrated', () => {
  // why: SD-12
  it('runs on PostgreSQL 18 and holds the 5 schemas of section 2 and the 2 roles', async () => {
    expect(pgVersion()).toMatch(/^18\./);
    const s = await db.admin().query<{ nspname: string }>(
      "SELECT nspname FROM pg_namespace WHERE nspname IN ('world','world_snapshot','system','pbs','pbs_snapshot') ORDER BY 1");
    expect(s.rows.map((r) => r.nspname)).toEqual(['pbs', 'pbs_snapshot', 'system', 'world', 'world_snapshot']);
    const r = await db.admin().query<{ rolname: string; rolcanlogin: boolean }>("SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('app','pbs') ORDER BY 1");
    expect(r.rows).toEqual([{ rolname: 'app', rolcanlogin: false }, { rolname: 'pbs', rolcanlogin: false }]);
  });
});

describe('foreign keys', () => {
  // why: SD-24
  it('refuses, as role app, a job whose customer_id names no customer, and accepts it once the customer exists', async () => {
    await db.asRole('app', async (q) => {
      const ref = await seedReference(q);
      await q.query('SAVEPOINT s');
      let err: { code?: string; constraint?: string } = {};
      try {
        await insertJob(q, { ...ref, customerId: '01900000-0000-7000-8000-000000000000' });
      } catch (e) {
        err = e as typeof err;
      }
      await q.query('ROLLBACK TO SAVEPOINT s');
      expect(err.code).toBe('23503');
      expect(err.constraint).toBe('job_customer_id_fkey');
      // The same insert with a real customer succeeds, so the refusal above was the foreign key and nothing else.
      // (The refused insert already took 24800 from the sequence: sequences never roll back.)
      expect(await insertJob(q, ref)).toBeGreaterThanOrEqual(24800);
    });
  });

  // why: SD-12
  it('declares no constraint on the 5 columns that name a world row from another store', async () => {
    const r = await db.admin().query<{ col: string }>(`
      SELECT n.nspname || '.' || c.relname || '.' || a.attname AS col
        FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY(k.conkey)
       WHERE k.contype = 'f' AND n.nspname IN ('pbs', 'system')`);
    expect(r.rows.map((x) => x.col)).toEqual(['pbs.invoice_line.job_number']);
  });
});

describe('keys that carry invariants', () => {
  // why: FR-TECH-4
  it('stores a technician item key once: a second row with the same key is refused (the idempotency ledger)', async () => {
    await db.asRole('app', async (q) => {
      const ref = await seedReference(q);
      const job = await insertJob(q, ref);
      const item = `INSERT INTO world.tech_item (key, technician_id, job_number, kind, world_epoch, device_time_real,
        offset_saved_real, demo_time, since_save_ms, received_at, result)
        VALUES ('2f1a6c1e-8b7d-4c3a-9e2f-0d1c2b3a4f5e', $1, $2, 'note', 1, now(), now(), now(), 0, now(), 'applied')`;
      expect(await attempt(q, item, [ref.technicianId, job])).toBe('no error');
      expect(await attempt(q, item, [ref.technicianId, job])).toBe('23505');
    });
  });

  // why: FR-BILL-8
  it('keys pbs.invoice by job number: a second invoice for 1 job is refused, as role pbs', async () => {
    await db.asRole('pbs', async (q) => {
      const inv = `INSERT INTO pbs.invoice (job_number, received_at, how, total_cents, customer_name, done_at)
                   VALUES (24825, now(), 'received', 8900, 'Ann Lee', now())`;
      expect(await attempt(q, inv)).toBe('no error');
      expect(await attempt(q, inv)).toBe('23505');
    });
  });

  // why: FR-DISP-6, UC-02
  it('gives a job exactly 1 technician column and an integer version', async () => {
    const r = await db.admin().query<{ column_name: string; data_type: string }>(`
      SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'world' AND table_name = 'job' AND (column_name LIKE '%technician%' OR column_name = 'version')
       ORDER BY column_name`);
    expect(r.rows).toEqual([{ column_name: 'technician_id', data_type: 'uuid' }, { column_name: 'version', data_type: 'integer' }]);
  });
});

describe('role privileges', () => {
  // why: FR-DISP-5
  it('lets app append to the history logs but never update or delete them', async () => {
    await db.asRole('app', async (q) => {
      const ref = await seedReference(q);
      const job = await insertJob(q, ref);
      expect(await attempt(q, `INSERT INTO world.job_change (job_number, at, actor_kind, kind, from_version, to_version, data)
        VALUES ($1, now(), 'office', 'created', 0, 1, '{}')`, [job])).toBe('no error');
      for (const t of ['job_change', 'tech_item', 'text_attempt', 'billing_attempt', 'user_change', 'note', 'photo', 'signature']) {
        expect(await attempt(q, `DELETE FROM world.${t}`), `DELETE ${t}`).toBe('42501');
      }
      expect(await attempt(q, `UPDATE world.job_change SET kind = 'details'`)).toBe('42501');
      expect(await attempt(q, `UPDATE world.user_change SET what = 'invited'`)).toBe('42501');
    });
  });

  // why: FR-DISP-32
  it('gives app SELECT only on membership and on the report_visit view', async () => {
    await db.asRole('app', async (q) => {
      const ref = await seedReference(q);
      expect(await attempt(q, 'SELECT * FROM world.membership')).toBe('no error');
      expect(await attempt(q, `INSERT INTO world.membership VALUES ($1, '2024-01-01', '2027-01-01', 'm.k')`, [ref.customerId])).toBe('42501');
      expect(await attempt(q, 'SELECT * FROM world.report_visit')).toBe('no error');
    });
  });

  // why: FR-BILL-4
  it('keeps pbs and world apart: app cannot read pbs, pbs cannot read world or system', async () => {
    await db.asRole('app', async (q) => {
      expect(await attempt(q, 'SELECT * FROM pbs.invoice')).toBe('42501');
      expect(await attempt(q, 'SELECT * FROM system.schema_migration')).toBe('42501');
      expect(await attempt(q, 'SELECT * FROM system.demo_clock')).toBe('no error');
    });
    await db.asRole('pbs', async (q) => {
      expect(await attempt(q, 'SELECT * FROM world.job')).toBe('42501');
      expect(await attempt(q, 'SELECT * FROM system.session')).toBe('42501');
      expect(await attempt(q, 'SELECT * FROM pbs.mode')).toBe('no error');
    });
  });
});

describe('row rules section 3 states', () => {
  // why: FR-DISP-27
  it('refuses a note that is both or neither a job note and a customer note', async () => {
    await db.asRole('app', async (q) => {
      const ref = await seedReference(q);
      const note = (job: number | null, customer: string | null) => attempt(q, `INSERT INTO world.note (job_number, customer_id,
        author_user_id, author_kind, body, entered_at, sent_at, entered_offline) VALUES ($1, $2, $3, 'office', 'x', now(), now(), false)`,
        [job, customer, ref.userId]);
      const job = await insertJob(q, ref);
      expect(await note(null, null)).toBe('23514');
      expect(await note(job, ref.customerId)).toBe('23514');
      expect(await note(job, null)).toBe('no error');
      expect(await note(null, ref.customerId)).toBe('no error');
    });
  });

  // why: FR-BOOK-6
  it('ties an arrival window capacity to its mode: null exactly on a 4-hour window', async () => {
    await db.asRole('app', async (q) => {
      await seedReference(q);
      const w = (mode: string, cap: number | null) => attempt(q, `INSERT INTO world.arrival_window (branch_id, mode, start_local,
        end_local, label_key, capacity) VALUES ('columbus', $1, '08:00', '12:00', 'w', $2)`, [mode, cap]);
      expect(await w('two_hour', null)).toBe('23514');
      expect(await w('four_hour', 10)).toBe('23514');
      expect(await w('two_hour', -1)).toBe('23514');
      expect(await w('four_hour', null)).toBe('no error');
    });
  });

  // why: SD-30
  it('holds the 1-row tables to 1 row and allows 1 open alert per type and subject', async () => {
    await db.asRole('app', async (q) => {
      expect(await attempt(q, "INSERT INTO world.text_simulator (mode) VALUES ('up')")).toBe('no error');
      expect(await attempt(q, "INSERT INTO world.text_simulator (mode) VALUES ('all_fail')")).toBe('23505');
      const alert = (state: string) => attempt(q, `INSERT INTO world.alert (type, state, at, at_real, subject, message_key,
        message_values, link_target, emailed) VALUES ('billing_retrying_long', $1, now(), now(), 'job:24825', 'k', '{}', '/x', false)`, [state]);
      expect(await alert('open')).toBe('no error');
      expect(await alert('open')).toBe('23505');
      expect(await alert('resolved')).toBe('no error');
      expect(await alert('resolved')).toBe('no error');
    });
  });
});

describe('list filter indexes (section 11.5)', () => {
  // why: NFR-01
  it('indexes every list filter the contracts name', async () => {
    const r = await db.admin().query<{ tbl: string; def: string }>(`
      SELECT n.nspname || '.' || t.relname AS tbl, pg_get_indexdef(i.indexrelid) AS def
        FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname IN ('world', 'pbs', 'system')`);
    const has = (tbl: string, lead: string) => r.rows.some((x) => x.tbl === tbl && new RegExp(`\\((${lead})[,) ]`).test(x.def));
    const wanted: [string, string][] = [
      ['world.job', 'branch_id'], ['world.job', 'technician_id'], ['world.job', 'customer_id'], ['world.job', 'service_id'],
      ['world.customer', 'name_search'], ['world.customer', 'branch_id'], ['world.customer', 'street_id'], ['world.customer', 'mobile'],
      ['world.street', 'name_search'], ['world.part', 'name_search'], ['world.outbox_text', 'due_at'], ['world.outbox_text', 'customer_id'],
      ['world.outbox_text', 'status'], ['world.call_list_entry', 'branch_id'], ['world.scheduled_event', 'due_at'],
      ['world.billing_item', 'state'], ['world.duplicate_pair', 'status'], ['world.user', 'branch_id'], ['world.user', 'role'],
      ['world.alert', 'branch_id'], ['world.job_change', 'job_number'], ['world.past_visit', 'customer_id'], ['world.pilot_call', 'branch_id'],
    ];
    expect(wanted.filter(([t, c]) => !has(t, c))).toEqual([]);
    expect(r.rows.some((x) => x.tbl === 'world.customer' && /gin \(name_search public\.gin_trgm_ops\)|gin \(name_search gin_trgm_ops\)/.test(x.def))).toBe(true);
  });
});
