// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI1 inv1-offline-exactly-once, the server cases (SPECIFICATIONS section 14 item 1, section 5.1 steps 5 to 8;
// invariant 1; FR-TECH-6): every one of the 36 cells of the offline conflict table is a test generated from
// the typed constant (@bw/domain OFFLINE_CONFLICT_TABLE), driven through the real route (API-102, or API-103 for the
// Add photo row) as a technician of the reference seed, against the production kernel as bw_web on PostgreSQL 18.
// The change of each column is made the way its writer makes it: the office's assign (API-22) and reschedule (API-24)
// through the real routes; cancel (API-25), the office finish (API-26) and the details edit (API-27) are not built
// yet (wave 18 and phase 4), so their job_change rows are planted with the kind and actor section 3 names. Plus the 2
// variants section 5.1 step 6 adds: time off lands in Reassigned, a customer reschedule in Rescheduled.
// The client cases (WebKit, a context close) join in P5-TWA-OUTBOX (BUILD_PLAN D-15).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHANGE_COLUMNS, ITEM_ACTIONS, OFFLINE_CONFLICT_TABLE, STATUS_ITEM_TARGET, type ChangeColumn, type ItemAction, type Verdict } from '../../../packages/domain/src/index.ts';
import { BUS_CHANNEL, createClient, decodeNotification } from '../../../packages/db/src/index.ts';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { billFinishedJob } from '../../../apps/worker/src/billing/queue.ts';
import { Temporal } from '../../../packages/time/src/index.ts';
import {
  answers, blobQuery, demoAt, item, jpeg, noParts, noteOf, techWorld, type Tech, type TechWorld,
} from '../../../packages/api-server/src/tech-items/testing.ts';

const db = useMigratedDatabase();
let w: TechWorld;
let maria: Tech;
let kevin: Tech;

beforeAll(async () => {
  w = await techWorld(db);
  [maria, kevin] = w.techs;
  await w.runningClock(demoAt('11:06'));
}, 120_000);
afterAll(async () => {
  await w?.close();
});
// Each cell books into the same window: free the technicians' room afterwards, so the office's real assign and
// reschedule (which check capacity, SD-27) see an empty day each time. The rows stay; only the status moves.
afterEach(async () => {
  await w.admin().query(`UPDATE world.job SET status = 'canceled' WHERE status <> 'canceled'`);
});

/** What the server did with 1 item: the answer, and the rows that prove it (never dropped: applied or listed). */
interface Observed {
  result: string;
  messageKey: string | null;
  applied: boolean;
  listed: { messageKey: string; offlineAt: Date; sentAt: Date } | null;
  ledger: string | null;
}

/** The cell's rule over what was observed: a problem string, or null when the server did what the table says. */
export function cellProblem(cell: { action: string; column: string; verdict: Verdict }, o: Observed): string | null {
  const name = `(${cell.action}, ${cell.column})`;
  if (o.ledger === null) return `${name}: no ledger row: the item was dropped`;
  if (cell.verdict === 'apply') {
    if (o.result !== 'applied' || !o.applied || o.listed) return `${name}: the table says Apply; the server answered ${o.result}, applied ${o.applied}, listed ${o.listed !== null}`;
    return null;
  }
  if (o.result !== 'flagged' || o.applied || !o.listed) return `${name}: the table says Flag; the server answered ${o.result}, applied ${o.applied}, listed ${o.listed !== null}`;
  if (o.listed.messageKey !== `offline.flag.${cell.column}` || o.messageKey !== `tech.item.flagged.${cell.column}`) return `${name}: flagged with the wrong message`;
  return null;
}

const ENTERED = demoAt('10:45');

async function plant(n: number, kind: string, actorKind: 'office' | 'customer', set: string, data: Record<string, unknown>): Promise<void> {
  const a = w.admin();
  await a.query('BEGIN');
  try {
    const v = (await a.query<{ version: number }>(`UPDATE world.job SET ${set}, version = version + 1 WHERE job_number = $1 RETURNING version`, [n])).rows[0]!.version;
    await a.query(
      `INSERT INTO world.job_change (job_number, at, actor_user_id, actor_kind, kind, from_version, to_version, data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [n, demoAt('10:50').toString(), actorKind === 'office' ? w.keisha.userId : null, actorKind, kind, v - 1, v, JSON.stringify(data)]);
    // The office finish bills in its transaction (section 6.6), as every done-writer must (migration 0012).
    if (set.includes(`'done'`)) await billFinishedJob(a, { jobNumber: n, at: Temporal.Instant.from(demoAt('10:50').toString()) });
    await a.query('COMMIT');
  } catch (e) {
    await a.query('ROLLBACK');
    throw e;
  }
}

/** Make the column's change to job n (version 1, Maria's, scheduled), as its writer does. */
async function change(column: ChangeColumn | 'time_off' | 'customer_reschedule', n: number): Promise<void> {
  switch (column) {
    case 'no_change':
      return;
    case 'assigned': {
      const r = await w.post(`/jobs/${n}/assignment`, { technicianId: kevin.technicianId, baseVersion: 1 }, w.keisha);
      expect(r.status, await r.clone().text()).toBe(200);
      return;
    }
    case 'rescheduled': {
      const r = await w.post(`/jobs/${n}/schedule`, { date: '2026-09-17', windowId: w.windowId, baseVersion: 1 }, w.keisha);
      expect(r.status, await r.clone().text()).toBe(200);
      expect(((await r.json()) as { data: { outcome: { technicianKept: boolean } } }).data.outcome.technicianKept).toBe(true);
      return;
    }
    case 'details':
      return plant(n, 'details', 'office', `problem = 'Rattles at start'`, { from: { problem: null }, to: { problem: 'Rattles at start' } });
    case 'canceled':
      return plant(n, 'canceled', 'office', `status = 'canceled'`, { from: { status: 'scheduled' }, to: { status: 'canceled' } });
    case 'status_set':
      return plant(n, 'status_set', 'office', `status = 'done', ended_at = '2026-09-15T14:50:00Z', labor_minutes = 30, no_parts_used = true`,
        { from: { status: 'scheduled' }, to: { status: 'done' } });
    case 'time_off':
      return plant(n, 'unassigned_time_off', 'office', 'technician_id = NULL', { from: { technicianId: maria.technicianId }, to: { technicianId: null } });
    case 'customer_reschedule':
      return plant(n, 'rescheduled', 'customer', `date = '2026-09-17'`,
        { from: { date: '2026-09-15', technicianId: maria.technicianId }, to: { date: '2026-09-17', technicianId: maria.technicianId } });
  }
}

/** Send the row's offline item (base version 1, entered at 10:45) and read back what the server did. */
async function sendAndObserve(action: ItemAction, n: number): Promise<Observed> {
  const before = (await w.rows<{ status: string; version: number }>('SELECT status, version FROM world.job WHERE job_number = $1', [n]))[0]!;
  let key: string;
  let result: string;
  let messageKey: string | null;
  if (action === 'photo') {
    const q = blobQuery({ kind: 'photo', jobNumber: n, entered: ENTERED });
    key = q['key'] as string;
    const r = await w.upload(q, jpeg(), 'image/jpeg', maria);
    expect(r.status, await r.clone().text()).toBe(200);
    ({ result, messageKey } = ((await r.json()) as { data: { result: string; messageKey: string | null } }).data);
  } else {
    const payload = action === 'note' ? noteOf() : action === 'finished' ? noParts : undefined;
    const it = item({ kind: action, jobNumber: n, baseVersion: 1, entered: ENTERED, payload });
    key = it['key'] as string;
    ({ result, messageKey } = (await answers(await w.send([it], maria)))[0]!);
  }
  const after = (await w.rows<{ status: string; version: number }>('SELECT status, version FROM world.job WHERE job_number = $1', [n]))[0]!;
  let applied: boolean;
  if (action === 'note') applied = (await w.rows('SELECT 1 FROM world.note WHERE item_key = $1', [key])).length === 1;
  else if (action === 'photo') applied = (await w.rows('SELECT 1 FROM world.photo WHERE key = $1', [key])).length === 1;
  else applied = after.status === STATUS_ITEM_TARGET[action] && after.version === before.version + 1;
  const listed = (await w.rows<{ message_key: string; offline_at: Date; sent_at: Date }>(
    'SELECT message_key, offline_at, sent_at FROM world.offline_conflict WHERE item_key = $1', [key]))[0];
  const ledger = (await w.rows<{ result: string }>('SELECT result FROM world.tech_item WHERE key = $1', [key]))[0]?.result ?? null;
  return { result, messageKey, applied, listed: listed ? { messageKey: listed.message_key, offlineAt: listed.offline_at, sentAt: listed.sent_at } : null, ledger };
}

describe('G-CI1: the 36 cells of the offline conflict table, from the typed constant (FR-TECH-6)', () => {
  for (const action of ITEM_ACTIONS) {
    for (const column of CHANGE_COLUMNS) {
      const verdict = OFFLINE_CONFLICT_TABLE[action][column];
      // why: FR-TECH-6, invariant 1 - each cell of the offline conflict table gets its verdict (apply or flag) from the server
      it(`(${action}, ${column}) -> ${verdict}`, async () => {
        const n = await w.newJob({ tech: maria });
        await change(column, n);
        const o = await sendAndObserve(action, n);
        expect(cellProblem({ action, column, verdict }, o)).toBeNull();
        if (verdict === 'flag') {
          // F-478: section 5.1 step 8 also writes the flagged job_change row (version unchanged); the cell is not right without it.
          const flagged = await w.rows<{ from_version: number; to_version: number }>(
            `SELECT from_version, to_version FROM world.job_change WHERE job_number = $1 AND kind = 'flagged'`, [n]);
          expect(flagged).toHaveLength(1);
          expect(flagged[0]!.to_version).toBe(flagged[0]!.from_version);
        }
        if (o.listed) {
          // A listed item carries its offline and sent times (FR-TECH-6 acceptance).
          expect([o.listed.offlineAt.getTime(), o.listed.sentAt.getTime()]).toEqual([ENTERED.epochMilliseconds, demoAt('11:06').epochMilliseconds]);
        }
      });
    }
  }
});

describe('G-CI1: a flagged item publishes EVT-01 (section 5.1 step 8)', () => {
  // why: F-478
  it('sends job.changed for the job when an item is flagged', async () => {
    const listener = createClient({ connectionString: db.url() });
    await listener.connect();
    const seen: string[] = [];
    listener.on('notification', (m) => {
      const e = decodeNotification(m.payload);
      if (e?.name === 'job.changed') seen.push(String(e.ids['jobNumber']));
    });
    await listener.query(`LISTEN ${BUS_CHANNEL}`);
    try {
      const n = await w.newJob({ tech: maria });
      await change('assigned', n);
      const o = await sendAndObserve('arrived', n);
      expect(o.result).toBe('flagged');
      await expect.poll(() => seen.filter((x) => x === String(n)).length, { timeout: 5_000 }).toBeGreaterThan(0);
    } finally {
      await listener.end();
    }
  });
});

describe('G-CI1: the 2 variants of section 5.1 step 6', () => {
  // why: FR-TECH-6
  it('a time-off unassignment lands in the Reassigned column and names time off', async () => {
    const n = await w.newJob({ tech: maria });
    await change('time_off', n);
    const o = await sendAndObserve('arrived', n);
    expect(cellProblem({ action: 'arrived', column: 'assigned', verdict: 'flag' }, o)).toBeNull();
    const values = (await w.rows<{ message_values: Record<string, unknown> }>('SELECT message_values FROM world.offline_conflict WHERE job_number = $1', [n]))[0]!.message_values;
    expect(values).toMatchObject({ byKind: 'time_off', toKind: 'nobody', change: 'assigned' });
  });

  // why: FR-TECH-6
  it('a customer reschedule lands in the Rescheduled column and names the customer', async () => {
    const n = await w.newJob({ tech: maria });
    await change('customer_reschedule', n);
    const o = await sendAndObserve('finished', n);
    expect(cellProblem({ action: 'finished', column: 'rescheduled', verdict: 'flag' }, o)).toBeNull();
    const values = (await w.rows<{ message_values: Record<string, unknown> }>('SELECT message_values FROM world.offline_conflict WHERE job_number = $1', [n]))[0]!.message_values;
    expect(values).toMatchObject({ byKind: 'customer', date: '2026-09-17', change: 'rescheduled' });
  });
});

describe('G-CI1: a repeated key answers duplicate with nothing applied twice', () => {
  // why: FR-TECH-4, invariant 1
  it('repeats every result kind as duplicate with its stored message, and changes nothing the second time', async () => {
    const flaggedJob = await w.newJob({ tech: maria });
    await change('assigned', flaggedJob);
    const appliedJob = await w.newJob({ tech: maria });
    const items = [
      item({ kind: 'finished', jobNumber: flaggedJob, baseVersion: 1, entered: ENTERED, payload: noParts }),
      item({ kind: 'arrived', jobNumber: appliedJob, baseVersion: 1, entered: ENTERED }),
      item({ kind: 'note', jobNumber: appliedJob, baseVersion: 1, entered: ENTERED, payload: noteOf() }),
    ];
    const first = await answers(await w.send(items, maria));
    expect(first.map((a) => a.result)).toEqual(['flagged', 'applied', 'applied']);
    const snapshot = async () => w.rows(
      `SELECT (SELECT count(*) FROM world.job_change WHERE job_number IN ($1, $2))::int AS changes,
              (SELECT count(*) FROM world.offline_conflict WHERE job_number = $1)::int AS conflicts,
              (SELECT count(*) FROM world.note WHERE job_number = $2)::int AS notes,
              (SELECT version FROM world.job WHERE job_number = $2) AS version`, [flaggedJob, appliedJob]);
    const before = await snapshot();
    const second = await answers(await w.send(items, maria));
    expect(second.map((a) => [a.result, a.messageKey])).toEqual(first.map((a) => ['duplicate', a.messageKey]));
    expect(await snapshot()).toEqual(before);
  });
});

describe('G-CI1 must-fail cases: the cell rule is not vacuous (every run)', () => {
  // why: FR-TECH-6, invariant 1
  it('reports a real server outcome checked against a planted flipped cell, and a dropped item', async () => {
    const n = await w.newJob({ tech: maria });
    await change('assigned', n);
    const o = await sendAndObserve('finished', n);
    expect(cellProblem({ action: 'finished', column: 'assigned', verdict: 'apply' }, o)).toMatch(/table says Apply/);
    expect(cellProblem({ action: 'finished', column: 'assigned', verdict: 'flag' }, { ...o, ledger: null })).toMatch(/dropped/);
    const m = await w.newJob({ tech: maria });
    const applied = await sendAndObserve('arrived', m);
    expect(cellProblem({ action: 'arrived', column: 'no_change', verdict: 'flag' }, applied)).toMatch(/table says Flag/);
  });
});
