// SPDX-License-Identifier: AGPL-3.0-or-later
// The finish probes of G-CI10 (finish-paths.ts): 1 per finish route section 6.6 FR-BILL-3 names, added by the lane
// that builds the route, in the same commit as its contract row (API-26 office finish: P4-JOB; API-62 Correct the
// finish: P3-BILLING-WRITES; API-102's finish item: P3-ITEMS). A probe drives the REAL route through the mounted kernel, as a principal
// its policy entry admits, finishing an on-site job with neither parts nor No parts used, and reports what happened.
// The gate requires code parts_required, the job not done and no billing_item row.
//
// Beyond the named routes, migration 0012 (F-384) holds every other writer: a transaction that moves a job into done
// with no billing_item fails at commit, so a done-writer that skips billFinishedJob (and its finish-lines check)
// cannot land unseen (packages/db/src/job-done-billing.db.test.ts).
import { loadConfig } from '../../../packages/config/src/index.ts';
import { createPool, type Queryable } from '../../../packages/db/src/client.ts';
import { createLogger } from '../../../packages/log/src/index.ts';
import { sessionCookie, SqlSessionStore, startSession } from '../../../packages/api-server/src/kernel/sessions.ts';
import { createWebKernel } from '../../../packages/api-server/src/web.ts';
import { realNow, toWire, Temporal, type RealTimeUse } from '../../../packages/time/src/index.ts';

export interface FinishProbeContext {
  /** Superuser connection of the gate's database (migrated, with the billing test world's reference rows). */
  admin: Queryable;
  /** The database URL, for a probe that mounts the production kernel on its own pool. */
  databaseUrl: string;
  /** A job on site today, ready to finish. */
  newOnSiteJob(): Promise<number>;
}

export interface FinishProbeResult {
  /** The error code the route answered (the whole response, or the item's result for API-102). */
  code: string;
}

export interface FinishProbe {
  id: `API-${number}`;
  run(ctx: FinishProbeContext, jobNumber: number): Promise<FinishProbeResult>;
}

const asLogin = (url: string, login: string): string => {
  if (!url) throw new Error('a finish probe needs the gate database URL (FinishProbeContext.databaseUrl)');
  const u = new URL(url);
  u.username = login;
  return u.toString();
};

/**
 * API-102's finish item (P3-ITEMS): a technician of the job's branch, signed in by the real session layer on the native
 * app (bearer), sends 1 Finished item with no parts and No parts used off; the item's own answer is the code.
 */
const sendItemsFinish: FinishProbe = {
  id: 'API-102',
  async run(ctx, jobNumber) {
    const a = ctx.admin;
    const user = (await a.query<{ id: string }>(
      `INSERT INTO world."user" (email, name, name_search, role, branch_id, language, status, sample, reviewer)
       VALUES ('probe.tech.' || $1 || '@example.test', 'Probe Tech', 'probe tech', 'technician', 'columbus', 'en', 'active', false, false) RETURNING id`,
      [jobNumber])).rows[0]!.id;
    const tech = (await a.query<{ id: string }>(
      `INSERT INTO world.technician (user_id, branch_id, name, name_in_texts, phone, primary_skill, skills, installer, shift_start, shift_end,
                                     working_days, saturdays, since)
       VALUES ($1, 'columbus', 'Probe Tech', 'Probe', '(614) 555-0199', 'heating_cooling', '{heating_cooling}', false, '08:00', '17:00',
               '{1,2,3,4,5}', 'none', '2020-01-01') RETURNING id`, [user])).rows[0]!.id;
    await a.query('UPDATE world.job SET technician_id = $2 WHERE job_number = $1', [jobNumber, tech]);
    const job = (await a.query<{ version: number; zone: string }>('SELECT version, zone FROM world.job WHERE job_number = $1', [jobNumber])).rows[0]!;
    const clock = (await a.query<{ demo_anchor: Date; world_epoch: number }>('SELECT demo_anchor, world_epoch FROM system.demo_clock WHERE id = 1')).rows[0]!;

    const web = createPool({ connectionString: asLogin(ctx.databaseUrl, 'bw_web'), max: 2 });
    const kernel = createWebKernel({
      settings: loadConfig({ DATABASE_URL: asLogin(ctx.databaseUrl, 'bw_web'), ACCESS_CODE_ON: 'off' }),
      log: createLogger({ process: 'web', write: () => undefined }),
    });
    try {
      const clockReal = { realNow: (use: RealTimeUse) => realNow(use === 'session_idle' ? 'session_idle' : 'session_lifetime') };
      const token = await startSession(new SqlSessionStore(web), clockReal, { userId: user, role: 'technician' }, { client: 'native', via: 'password', keepSignedIn: false });
      const at = toWire(Temporal.Instant.fromEpochMilliseconds(clock.demo_anchor.getTime()), job.zone);
      const finish = {
        key: crypto.randomUUID(), kind: 'finished', jobNumber, baseVersion: job.version, worldEpoch: clock.world_epoch,
        deviceTime: at, offsetSavedReal: at, sinceSaveMs: 0, demoTime: at,
        payload: { parts: [], noPartsUsed: false, laborMinutes: 45, workDone: [] },
      };
      const res = await kernel.router.handle(new Request('http://web:3000/api/v1/tech/items', {
        method: 'POST', body: JSON.stringify({ items: [finish] }), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      }), { address: '203.0.113.9' });
      const body = (await res.json()) as { code?: string; data?: { items: { result: string; code: string | null }[] } };
      const answer = body.data?.items[0];
      return { code: answer?.code ?? answer?.result ?? body.code ?? `status ${res.status}` };
    } finally {
      await kernel.close();
      await web.end();
    }
  },
};

/**
 * API-62 Correct a finish and send again (P3-BILLING-WRITES): an office user signed in by the real session layer (web,
 * cookie) corrects the on-site job with neither parts nor No parts used; the route answers parts_required before it asks
 * whether the job is waiting (FR-BILL-3: 1 rule on every finish path).
 */
const correctionFinish: FinishProbe = {
  id: 'API-62',
  async run(ctx, jobNumber) {
    const a = ctx.admin;
    const user = (await a.query<{ id: string }>(
      `INSERT INTO world."user" (email, name, name_search, role, branch_id, language, status, sample, reviewer)
       VALUES ('probe.office.' || $1 || '@example.test', 'Probe Office', 'probe office', 'office', 'columbus', 'en', 'active', false, false) RETURNING id`,
      [jobNumber])).rows[0]!.id;
    const job = (await a.query<{ version: number }>('SELECT version FROM world.job WHERE job_number = $1', [jobNumber])).rows[0]!;

    const web = createPool({ connectionString: asLogin(ctx.databaseUrl, 'bw_web'), max: 2 });
    const kernel = createWebKernel({
      settings: loadConfig({ DATABASE_URL: asLogin(ctx.databaseUrl, 'bw_web'), ACCESS_CODE_ON: 'off' }),
      log: createLogger({ process: 'web', write: () => undefined }),
    });
    try {
      const clockReal = { realNow: (use: RealTimeUse) => realNow(use === 'session_idle' ? 'session_idle' : 'session_lifetime') };
      const token = await startSession(new SqlSessionStore(web), clockReal, { userId: user, role: 'office' }, { client: 'web', via: 'password', keepSignedIn: false });
      const res = await kernel.router.handle(new Request(`http://web:3000/api/v1/billing/queue/${jobNumber}/correction`, {
        method: 'POST',
        body: JSON.stringify({ parts: [], noPartsUsed: false, laborMinutes: 45, baseVersion: job.version }),
        headers: { 'content-type': 'application/json', origin: 'http://localhost:8080', cookie: sessionCookie(token, false, false).split(';')[0] as string },
      }), { address: '203.0.113.9' });
      const body = (await res.json()) as { code?: string };
      return { code: body.code ?? `status ${res.status}` };
    } finally {
      await kernel.close();
      await web.end();
    }
  },
};

/**
 * API-26 the office finish (P4-JOB): an office user signed in by the real session layer (web, cookie) finishes the on-site
 * job from SCR-OFC-22 with neither parts nor No parts used; finishLines refuses it before the version gate (FR-BILL-3).
 */
const officeFinish: FinishProbe = {
  id: 'API-26',
  async run(ctx, jobNumber) {
    const a = ctx.admin;
    const user = (await a.query<{ id: string }>(
      `INSERT INTO world."user" (email, name, name_search, role, branch_id, language, status, sample, reviewer)
       VALUES ('probe.finish.' || $1 || '@example.test', 'Probe Finish', 'probe finish', 'office', 'columbus', 'en', 'active', false, false) RETURNING id`,
      [jobNumber])).rows[0]!.id;
    const job = (await a.query<{ version: number }>('SELECT version FROM world.job WHERE job_number = $1', [jobNumber])).rows[0]!;

    const web = createPool({ connectionString: asLogin(ctx.databaseUrl, 'bw_web'), max: 2 });
    const kernel = createWebKernel({
      settings: loadConfig({ DATABASE_URL: asLogin(ctx.databaseUrl, 'bw_web'), ACCESS_CODE_ON: 'off' }),
      log: createLogger({ process: 'web', write: () => undefined }),
    });
    try {
      const clockReal = { realNow: (use: RealTimeUse) => realNow(use === 'session_idle' ? 'session_idle' : 'session_lifetime') };
      const token = await startSession(new SqlSessionStore(web), clockReal, { userId: user, role: 'office' }, { client: 'web', via: 'password', keepSignedIn: false });
      const res = await kernel.router.handle(new Request(`http://web:3000/api/v1/jobs/${jobNumber}/finish`, {
        method: 'POST',
        body: JSON.stringify({ parts: [], noPartsUsed: false, laborMinutes: 45, baseVersion: job.version }),
        headers: { 'content-type': 'application/json', origin: 'http://localhost:8080', cookie: sessionCookie(token, false, false).split(';')[0] as string },
      }), { address: '203.0.113.9' });
      const body = (await res.json()) as { code?: string };
      return { code: body.code ?? `status ${res.status}` };
    } finally {
      await kernel.close();
      await web.end();
    }
  },
};

export const FINISH_PROBES: readonly FinishProbe[] = [sendItemsFinish, correctionFinish, officeFinish];
