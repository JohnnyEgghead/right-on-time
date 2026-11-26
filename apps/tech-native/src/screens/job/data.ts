// SPDX-License-Identifier: AGPL-3.0-or-later
// The native job screens' reads (SCR-TEC-04 to SCR-TEC-07; P5-TWA-JOB's contracts): the job (API-101) with signal, kept on the phone
// (copies.ts) for an open with no signal (SCR-TEC-04 Offline, saved), API-107's parts list kept the same way (UD-35), API-104's drive
// minutes, and API-07 for who is signed in. A 403 or 404 is SCR-TEC-04's No longer yours: the kept copy is dropped, and any waiting
// item for the job still sends. The copies are 1 person's: a different person than the copies' clears them before this read's
// answer is shown or saved, and a sign-out clears them (F-1017). Platform-free (the app and the copies come in), so the tests run it on
// node:fs against the scripted server.
import { ApiError, myJob, partsList, whoAmI } from '@bw/api';
import type { MapMeReads } from '../mapme/reads.ts';
import { routeRead } from '../mapme/steps.ts';
import type { NativeApp } from '../../core.ts';
import type { JobCopies } from './copies.ts';
import type { JobCopy, Part } from './model.ts';

export type JobView =
  | { kind: 'loading' }
  | { kind: 'job'; job: JobCopy; fromPhone: boolean }
  | { kind: 'not_on_phone' }
  /** A read that failed with signal (a server fault, an answer that does not parse) and no copy to show: not a No signal (F-1092). */
  | { kind: 'load_failed' }
  | { kind: 'not_yours' };

export class JobData {
  readonly app: NativeApp;
  readonly copies: JobCopies;

  constructor(app: NativeApp) {
    this.app = app;
    // The app's own copies: NativeApp.endSession clears them at sign-out or a 401 (F-1090), so no subscription is needed here.
    this.copies = app.jobCopies;
  }

  /** The signed-in technician's name: API-07 with signal (a different person's copies are cleared first), else the kept one. */
  async me(): Promise<string | null> {
    const api = this.app.api();
    if (!api) return null;
    try {
      const who = (await api.call(whoAmI, {})).data;
      const kept = this.copies.me();
      if (kept && kept.userId !== who.userId) this.copies.forgetAll();
      this.copies.saveMe({ userId: who.userId, name: who.name });
      return who.name;
    } catch {
      return this.copies.me()?.name ?? null;
    }
  }

  /** The job: the kept copy at once (onView), then API-101's answer, which replaces it and is kept. */
  async job(jobNumber: number, onView: (v: JobView) => void): Promise<JobView> {
    const kept = this.copies.job(jobNumber);
    if (kept) onView({ kind: 'job', job: kept, fromPhone: true });
    const api = this.app.api();
    if (!api) return kept ? { kind: 'job', job: kept, fromPhone: true } : { kind: 'not_on_phone' };
    await this.me(); // the person check comes before this person's answer is saved
    let v: JobView;
    try {
      const r = await api.call(myJob, { jobNumber });
      this.copies.saveJob(r.data);
      v = { kind: 'job', job: r.data, fromPhone: false };
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        this.copies.forgetJob(jobNumber);
        v = { kind: 'not_yours' };
      } else {
        const again = this.copies.job(jobNumber);
        // Only a call that never reached the server is No signal (a TypeError, core.ts answeredOrNetwork); anything else is a failed read (F-1092).
        v = again ? { kind: 'job', job: again, fromPhone: true } : e instanceof TypeError ? { kind: 'not_on_phone' } : { kind: 'load_failed' };
      }
    }
    onView(v);
    return v;
  }

  /**
   * The fixed parts list (API-107), kept for a finish with no signal; `parts` is null when it was never read. `failed`: with signal the read
   * failed (a server fault, an answer that does not parse) and no copy stands in, which is not the never-loaded No signal line (F-1092).
   */
  async partsRead(): Promise<{ parts: Part[] | null; failed: boolean }> {
    const api = this.app.api();
    let failed = false;
    if (api) {
      try {
        const r = await api.call(partsList, {});
        this.copies.saveParts(r.data.parts);
        return { parts: r.data.parts, failed: false };
      } catch (e) {
        // no signal: the kept list; any other failure is a failed read
        failed = !(e instanceof TypeError);
      }
    }
    const kept = this.copies.parts();
    return { parts: kept, failed: failed && kept === null };
  }

  /**
   * CTL-TEC-04-04 (FR-TECH-13, F-1369): the drive minutes from the van to this job (API-104 with no fromJob, as the Today card reads it); null unknown, offline or approximate. With the
   * session's MapMeReads the read goes through its leg(), which keeps the answer as that destination's last route read (rule 11, F-1311).
   */
  async driveMinutes(toJob: number, reads: Pick<MapMeReads, 'leg'> | null = null): Promise<number | null> {
    if (reads) {
      const r = await reads.leg(toJob);
      return r.kind === 'leg' && r.leg.track ? r.leg.minutes : null;
    }
    const api = this.app.api();
    if (!api) return null;
    try {
      const leg = (await api.call(routeRead, { toJob })).data.leg;
      return leg.track ? leg.minutes : null;
    } catch {
      return null;
    }
  }
}
