// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DEMO-8 (a van's position is computed on read from its baked track and the clock, never stored: SPECIFICATIONS section 6.10 "there is no position table, and the schema test asserts it")
import { describe, expect, it } from 'vitest';
import { useMigratedDatabase } from './testing/fixture.ts';

const db = useMigratedDatabase();

describe('the schema stores no van position', () => {
  it('has no table named for a position, location or trail, in any schema the app reads', async () => {
    const r = await db.admin().query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_schema IN ('world', 'system', 'public') AND table_name ~* '(position|location|gps|breadcrumb|trail|ping)'`);
    expect(r.rows).toEqual([]);
  });

  it('keeps no coordinate or position column on the technician, the van or the job, where a stored van position would live', async () => {
    const r = await db.admin().query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'world' AND table_name IN ('technician', 'van', 'job', 'technician_day')
          AND column_name ~* '(^lon$|^lat$|lng|longitude|latitude|position|location|coord)'`);
    expect(r.rows).toEqual([]);
  });
});
