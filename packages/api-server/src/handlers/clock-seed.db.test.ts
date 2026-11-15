// SPDX-License-Identifier: AGPL-3.0-or-later
// P2-SEED (owner ruling c025a9ec, moved from P2-SHELL): API-10 GET /clock on the real migrated database answers its
// specified 500 server_error before the reference seed, and 200 after it, with world epoch 1 and the demo time read from
// the row the seed wrote. The production kernel as the web process's own login bw_web, like shell-reads.db.test.ts;
// no fixture row is inserted: the only rows are the seed's. Run by gate G-CI7 step 3.
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@bw/config';
import { createLogger } from '@bw/log';
import { realNow, Temporal } from '@bw/time';
import { seedReference } from '../../../db/src/seed/index.ts';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { createWebKernel, type WebKernel } from '../web.ts';

const db = useMigratedDatabase();
const asWeb = () => {
  const u = new URL(db.url());
  u.username = 'bw_web';
  return u.toString();
};
const kernels: WebKernel[] = [];
const kernel = () => {
  const k = createWebKernel({
    settings: loadConfig({ DATABASE_URL: asWeb(), ACCESS_CODE_ON: 'on', ACCESS_CODE: 'a-test-access-code', ACCESS_COOKIE_KEY: 'k'.repeat(43) }),
    log: createLogger({ process: 'web', write: () => undefined }),
  });
  kernels.push(k);
  return k;
};
afterAll(async () => {
  await Promise.all(kernels.map((k) => k.close()));
});

const get = (k: WebKernel, path: string) => k.router.handle(new Request(`http://web:3000${path}`), { address: '203.0.113.9' });

describe('API-10 read the clock around the reference seed', () => {
  // why: FR-DEMO-1 no invented time: on the migrated database before the seed there is no clock row, so the read fails (D11)
  // why: API-10 answers 500 server_error before the reference seed and 200 after it, from the row the seed wrote
  it('answers server_error before the seed and 200 with world epoch 1 and the row\'s demo time after it', async () => {
    const before = await get(kernel(), '/api/v1/clock');
    expect(before.status).toBe(500);
    expect(((await before.json()) as { code: string }).code).toBe('server_error');
    expect((await db.admin().query('SELECT 1 FROM system.demo_clock')).rowCount).toBe(0);

    const a = db.admin();
    await a.query('BEGIN');
    await seedReference(a, { sampleSeed: 'test-seed-0123456789ab', anchorReal: new Date(realNow('record_stamp').epochMilliseconds) });
    await a.query('COMMIT');

    const after = await get(kernel(), '/api/v1/clock');
    expect(after.status).toBe(200);
    const raw = await after.text();
    const c = (JSON.parse(raw) as { data: { demoNow: string; paused: boolean; rate: number; worldEpoch: number; lastMove: unknown; replay: unknown } }).data;
    expect(c).toMatchObject({ worldEpoch: 1, paused: true, rate: 1, lastMove: null, replay: { running: false, done: 0, total: 0 } });
    // Paused: the demo time is the row's anchor, Tue Sep 15, 2026, 7:00 AM Eastern, however long the test took.
    expect(Temporal.ZonedDateTime.from(c.demoNow).epochMilliseconds).toBe(Date.parse('2026-09-15T11:00:00Z'));
    expect(c.demoNow).toBe('2026-09-15T07:00:00-04:00[America/New_York]');
  });
});
