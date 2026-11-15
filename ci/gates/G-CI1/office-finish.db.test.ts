// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI1's status_set column through its real writer (F-476, the API-26 part; BUILD_PLAN D-15: each writer lane adds its
// own case file). cells.db.test.ts plants the office finish's job_change row; this file makes the change through the
// real route, POST /jobs/{n}/finish as an office user, and then sends 1 offline status item of every kind the technician
// app queues, so a writer that shaped its row differently from the table's column would be caught here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ITEM_ACTIONS, OFFLINE_CONFLICT_TABLE, type ItemAction } from '../../../packages/domain/src/index.ts';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { answers, demoAt, item, noParts, noteOf, techWorld, type Tech, type TechWorld } from '../../../packages/api-server/src/tech-items/testing.ts';

const db = useMigratedDatabase();
let w: TechWorld;
let maria: Tech;

beforeAll(async () => {
  w = await techWorld(db);
  [maria] = w.techs;
  await w.runningClock(demoAt('11:06'));
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const STATUS_ACTIONS = ITEM_ACTIONS.filter((a): a is Exclude<ItemAction, 'photo'> => a !== 'photo');

describe('G-CI1: the office finish (API-26) through its real route, then 1 offline item (F-476)', () => {
  // why: FR-TECH-6 (F-476: the status_set cell driven by its writer, API-26, not by a planted row)
  it.each(STATUS_ACTIONS)('an offline %s item after the office finished the job is what the table says for status_set', async (action) => {
    const n = await w.newJob({ tech: maria });
    const fin = await w.post(`/jobs/${n}/finish`, { parts: [], noPartsUsed: true, laborMinutes: 40, baseVersion: 1 }, w.keisha);
    expect(fin.status, await fin.clone().text()).toBe(200);
    const change = (await w.rows<{ kind: string; actor_kind: string }>('SELECT kind, actor_kind FROM world.job_change WHERE job_number = $1 ORDER BY id DESC LIMIT 1', [n]))[0];
    expect(change).toEqual({ kind: 'status_set', actor_kind: 'office' });

    const payload = action === 'note' ? noteOf() : action === 'finished' ? noParts : undefined;
    const it2 = item({ kind: action, jobNumber: n, baseVersion: 1, entered: demoAt('10:45'), payload });
    const [answer] = await answers(await w.send([it2], maria));
    const verdict = OFFLINE_CONFLICT_TABLE[action].status_set;
    expect(answer!.result).toBe(verdict === 'apply' ? 'applied' : 'flagged');
    if (verdict === 'flag') expect(answer!.messageKey).toBe('tech.item.flagged.status_set');
    // The office's finish stands: the job stays Done at the finish's version whatever the item was.
    expect(await w.rows('SELECT status FROM world.job WHERE job_number = $1', [n])).toEqual([{ status: 'done' }]);
  });
});
