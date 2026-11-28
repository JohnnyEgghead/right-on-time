// SPDX-License-Identifier: AGPL-3.0-or-later
// The office executor's attempts and its event (P3-IMPORT-WORKER; F-266) on PostgreSQL 18, as bw_web (role app):
//   - EVT-08 import.run.changed leaves with the run id only, at each stage and percent change and at the finish (done
//     or failed), never without a change;
//   - a run whose executor dies (its connections are cut mid-run, as a killed process's are) stays running, is executed
//     again at the next pick-up, and after 3 such attempts ends failed (attempts_exhausted) with no 4th; a new request
//     is then accepted (owner ruling dc73cb08: "3 tries, then fail");
//   - an export source that refuses (generator_manifest) ends the run failed with that code, never running.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUS_CHANNEL, createClient, createPool, decodeNotification, type Queryable } from '@bw/db';
import { useMigratedDatabase } from '../../db/src/testing/fixture.ts';
import { ImportRunFailed, MAX_RUN_ATTEMPTS, requestImportRun, runPendingImport, type RunKind } from './runner.ts';
import { generatedWorld, seedReference, webPool } from './testing/world.ts';

const db = useMigratedDatabase();
let pool: ReturnType<typeof webPool>;
let listener: ReturnType<typeof createClient>;
const files = generatedWorld().files;
const demoClock = () => new Date('2026-09-15T14:00:00Z');
/** Every bus notification since the listener started. */
const heard: { name: string; ids: Record<string, string | number> }[] = [];

async function request(kind: RunKind): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const id = await requestImportRun(c as unknown as Queryable, { kind, bySetup: false, byUser: null, at: demoClock() });
    await c.query('COMMIT');
    return id;
  } finally {
    c.release();
  }
}
const row = async (id: string) => (await db.admin().query<{ status: string; stage: string; percent: number; report: Record<string, unknown> | null }>(
  'SELECT status, stage, percent, report FROM world.import_run WHERE id = $1', [id])).rows[0];
const eventsFor = (id: string) => heard.filter((e) => e.name === 'import.run.changed' && e.ids.runId === id);
/** Poll every 20 ms, at most `tries` times (no wall clock in a test: section 4.2). */
const until = async (ok: () => Promise<boolean>, what: string, tries = 3_000) => {
  for (let i = 0; !(await ok()); i++) {
    if (i >= tries) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const settle = () => new Promise((r) => setTimeout(r, 300));

beforeAll(async () => {
  await seedReference(db.admin());
  pool = webPool(db.url());
  listener = createClient({ connectionString: db.url() });
  await listener.connect();
  listener.on('notification', (m) => {
    const e = m.channel === BUS_CHANNEL ? decodeNotification(m.payload) : null;
    if (e) heard.push(e);
  });
  await listener.query(`LISTEN ${BUS_CHANNEL}`);
});
afterAll(async () => {
  await listener?.end();
  await pool?.end();
});

describe('EVT-08 import.run.changed (UI-SPECIFICATION 12.3; CTL-OFC-13-05)', () => {
  // why: FR-IMP-1
  it('is sent with the run id only at each stage and percent change and at the done finish', async () => {
    const id = await request('dry_run');
    const before = heard.length;
    const out = await runPendingImport(pool, { files, clock: demoClock });
    await settle();
    expect(out?.runId).toBe(id);
    const mine = eventsFor(id);
    // ids only (D1): exactly the run id
    for (const e of mine) expect(e.ids).toEqual({ runId: id });
    // validate 10, match 20, write 30, at least 1 write percent, the finish
    expect(mine.length).toBeGreaterThanOrEqual(5);
    // no other event left during the run
    expect(heard.slice(before).every((e) => e.name === 'import.run.changed' && e.ids.runId === id)).toBe(true);
    expect((await row(id))?.status).toBe('done');
  });

  // why: FR-IMP-1
  it('sends 1 event per change: the count equals the distinct stage and percent states the run wrote, plus the finish', async () => {
    const id = await request('dry_run');
    // Every UPDATE of the row's stage or percent, as the database saw it, through a trigger that keeps them in a table.
    await db.admin().query(`CREATE TABLE public.seen_state (n serial, stage text, percent int, status text);
      GRANT INSERT ON public.seen_state TO app; GRANT USAGE ON SEQUENCE public.seen_state_n_seq TO app;
      CREATE FUNCTION public.seen_state() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF (NEW.stage, NEW.percent, NEW.status) IS DISTINCT FROM (OLD.stage, OLD.percent, OLD.status) THEN
        INSERT INTO public.seen_state (stage, percent, status) VALUES (NEW.stage, NEW.percent, NEW.status); END IF; RETURN NEW; END $$;
      CREATE TRIGGER seen_state AFTER UPDATE ON world.import_run FOR EACH ROW EXECUTE FUNCTION public.seen_state();`);
    try {
      await runPendingImport(pool, { files, clock: demoClock });
      await settle();
      const states = await db.admin().query<{ n: number }>('SELECT count(*)::int AS n FROM public.seen_state');
      expect(eventsFor(id).length).toBe(states.rows[0]?.n);
    } finally {
      await db.admin().query('DROP TRIGGER seen_state ON world.import_run; DROP FUNCTION public.seen_state(); DROP TABLE public.seen_state;');
    }
  });

  // why: FR-IMP-1
  it('is sent when a run ends failed: a refused export ends the run failed with that code, never running', async () => {
    const id = await request('dry_run');
    const refused = Object.assign(new Error('the generated files differ from the committed manifest: customers.csv sha256'), { code: 'generator_manifest' });
    const err = await runPendingImport(pool, { files: () => { throw refused; }, clock: demoClock }).catch((e: unknown) => e);
    await settle();
    expect(err).toBe(refused);
    expect(await row(id)).toMatchObject({ status: 'failed', report: { error: 'generator_manifest', attempts: 1 } });
    const mine = eventsFor(id);
    expect(mine.length).toBe(1);
    expect(mine[0]?.ids).toEqual({ runId: id });
  });
});

describe('a failed run whose clock cannot be read (F-2006 J-26)', () => {
  // why: F-2006 J-26, FR-IMP-1 a failed clock read ended the run at 1970, before its own start
  it('ends failed at the run\'s own start, never at 1970', async () => {
    const id = await request('dry_run');
    const started = (await db.admin().query<{ started_at: Date }>('SELECT started_at FROM world.import_run WHERE id = $1', [id])).rows[0]!.started_at;
    const refused = Object.assign(new Error('refused'), { code: 'generator_manifest' });
    // The clock answers until the export refuses, then cannot be read: the failure's own read of it throws.
    let down = false;
    const clock = () => {
      if (down) throw Object.assign(new Error('clock down'), { code: 'ECONNRESET' });
      return demoClock();
    };
    const err = await runPendingImport(pool, { files: () => { down = true; throw refused; }, clock }).catch((e: unknown) => e);
    expect(err).toBe(refused);
    const r = (await db.admin().query<{ status: string; finished_at: Date }>('SELECT status, finished_at FROM world.import_run WHERE id = $1', [id])).rows[0]!;
    expect(r.status).toBe('failed');
    expect(r.finished_at.toISOString()).toBe(started.toISOString());
  });
});

describe('a run whose executor dies is executed again, 3 times in all (owner ruling dc73cb08, F-266)', () => {
  /** 1 attempt in an executor whose connections are cut once the run is working, as a killed process's are. */
  async function crashedAttempt(id: string, attempt: number): Promise<void> {
    const name = `executor-${attempt}`;
    const u = new URL(db.url());
    u.username = 'bw_web';
    u.password = '';
    const dying = createPool({ connectionString: u.toString(), max: 2, application_name: name });
    // its clients are cut while checked out: their own error events are expected here
    dying.on('error', () => undefined);
    dying.on('connect', (c) => c.on('error', () => undefined));
    const live = runPendingImport(dying, { files, clock: demoClock }).catch((e: unknown) => e);
    await until(async () => (await row(id))?.report?.attempts === attempt && ((await row(id))?.percent ?? 0) > 0, `attempt ${attempt} working`);
    await db.admin().query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', [name]);
    await live;
    await dying.end().catch(() => undefined);
    // the dead attempt left its row running, its attempt counted, and no domain row
    expect(await row(id)).toMatchObject({ status: 'running', report: { attempts: attempt } });
  }

  // why: FR-IMP-1, FR-IMP-10
  it('a crashed attempt is executed again from the start to 1 done record with the target counts', async () => {
    const id = await request('dry_run');
    await crashedAttempt(id, 1);
    const out = await runPendingImport(pool, { files, clock: demoClock });
    expect(out?.runId).toBe(id);
    const r = await row(id);
    expect(r).toMatchObject({ status: 'done', percent: 100 });
    expect((r?.report as { customers: { total: number } }).customers.total).toBe(18_400);
  });

  // why: FR-IMP-1, FR-IMP-10
  it('after 3 crashed attempts the run ends failed with attempts_exhausted, with no 4th attempt, and a new request is accepted', async () => {
    expect(MAX_RUN_ATTEMPTS).toBe(3);
    const id = await request('dry_run');
    for (let a = 1; a <= MAX_RUN_ATTEMPTS; a++) await crashedAttempt(id, a);
    const stoodAt = await row(id);
    const before = eventsFor(id).length;
    const source = { calls: 0 };
    const err = await runPendingImport(pool, { files: () => { source.calls++; return files; }, clock: demoClock }).catch((e: unknown) => e);
    await settle();
    expect(err).toBeInstanceOf(ImportRunFailed);
    // no 4th attempt: the export was never made, and the row was closed where the 3rd attempt died
    expect(source.calls).toBe(0);
    expect(await row(id)).toMatchObject({ status: 'failed', stage: stoodAt?.stage, percent: stoodAt?.percent, report: { error: 'attempts_exhausted', attempts: 3 } });
    expect(eventsFor(id).length).toBe(before + 1);
    expect(await runPendingImport(pool, { files, clock: demoClock })).toBeNull();
    const next = await request('dry_run');
    expect((await runPendingImport(pool, { files, clock: demoClock }))?.runId).toBe(next);
    expect((await row(next))?.status).toBe('done');
  });
});
