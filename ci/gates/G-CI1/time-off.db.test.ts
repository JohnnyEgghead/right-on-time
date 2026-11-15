// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI1's Reassigned column, filled by time off, through its real writer (F-476, the API-148 part; BUILD_PLAN D-15: each writer lane adds its own case file).
// cells.db.test.ts plants the time off's job_change row; this file makes the change through the real route, POST /technicians/{id}/time-off
// as an office user (P4-TECHNICIANS), and then sends 1 offline item of every status kind the technician app queues for the job that came
// off the technician, so a writer that shaped its row differently from the table's column would be caught here.
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

describe('G-CI1: time off (API-148) through its real route, then 1 offline item (F-476)', () => {
  // why: FR-TECH-6 (F-476: the Reassigned cells driven by time off's writer, API-148, not by a planted row)
  it.each(STATUS_ACTIONS)('an offline %s item after the office recorded time off over the job is what the table says for the Reassigned column', async (action) => {
    const n = await w.newJob({ tech: maria });
    const date = (await w.rows<{ date: string }>('SELECT date::text AS date FROM world.job WHERE job_number = $1', [n]))[0]!.date;
    const off = await w.post(`/technicians/${maria.technicianId}/time-off`, { from: date, to: date, note: null }, w.keisha);
    expect(off.status, await off.clone().text()).toBe(201);
    const change = (await w.rows<{ kind: string; actor_kind: string }>('SELECT kind, actor_kind FROM world.job_change WHERE job_number = $1 ORDER BY id DESC LIMIT 1', [n]))[0];
    expect(change).toEqual({ kind: 'unassigned_time_off', actor_kind: 'office' });
    expect(await w.rows('SELECT technician_id FROM world.job WHERE job_number = $1', [n])).toEqual([{ technician_id: null }]);

    const payload = action === 'note' ? noteOf() : action === 'finished' ? noParts : undefined;
    const it2 = item({ kind: action, jobNumber: n, baseVersion: 1, entered: demoAt('10:45'), payload });
    const [answer] = await answers(await w.send([it2], maria));
    // Time off lands in the Reassigned column (section 5.1 step 6: `unassigned_time_off` counts as `assigned`), naming time off.
    const verdict = OFFLINE_CONFLICT_TABLE[action].assigned;
    expect(answer!.result).toBe(verdict === 'apply' ? 'applied' : 'flagged');
    if (verdict === 'flag') {
      expect(answer!.messageKey).toBe('tech.item.flagged.assigned');
      const values = (await w.rows<{ message_values: Record<string, unknown> }>('SELECT message_values FROM world.offline_conflict WHERE job_number = $1', [n]))[0]!.message_values;
      expect(values).toMatchObject({ byKind: 'time_off', toKind: 'nobody', change: 'assigned' });
    }
  });
});
