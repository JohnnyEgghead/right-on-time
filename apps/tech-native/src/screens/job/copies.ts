// SPDX-License-Identifier: AGPL-3.0-or-later
// The native job screens' local copies beside the item store (UI-SPECIFICATION 4.5 rule 7; SCR-TEC-04 Offline, saved, SCR-TEC-05 and
// SCR-TEC-07; FR-TECH-4, FR-TECH-14, UD-35), the native counterpart of the web app's bw-tech-jobs database (apps/web/src/tech/job/
// store.ts). 1 small record per file in its own directory, by the item store's file rule (store/settings.ts does the same): a change
// is a new file with a higher revision, written whole then renamed into place, and the old one removed after; the highest that
// reads back wins, so a kill mid-write leaves the old record or the new one. The item store's own files and rules are not touched.
//   job-<n>     the last API-101 answer of a job opened with signal, for an open with no signal
//   draft-<n>   the Add note draft of a job, written on every change (CTL-TEC-05-01)
//   fin-<n>     the finish screen's entries of a job until it is finished (CTL-TEC-07-10, -11, -14)
//   parts       the last API-107 parts list, for the finish screen with no signal (UD-35)
//   me          the signed-in technician (API-07), for the own unsent notes and photos, and for whose copies these are
// The copies are 1 person's (customer names, addresses, notes, a signature): forgetAll clears them at sign-out and when a different
// person signs in (F-1017).
import { TEMP_PREFIX, type StoreDir } from '@bw/outbox/src/items/native.ts';
import type { FinishDraft, JobCopy, Part } from './model.ts';

const NAME = /^r-([a-z]+(?:-\d+)?)-(\d{6,})\.json$/;

export class JobCopies {
  private readonly dir: StoreDir;

  constructor(dir: StoreDir) {
    this.dir = dir;
    for (const n of dir.list()) if (n.startsWith(TEMP_PREFIX)) dir.remove(n);
  }

  private revs(key: string): { rev: number; name: string }[] {
    return this.dir.list().flatMap((name) => {
      const m = NAME.exec(name);
      return m && m[1] === key ? [{ rev: Number(m[2]), name }] : [];
    }).sort((a, b) => b.rev - a.rev);
  }

  private read<T>(key: string): T | null {
    for (const r of this.revs(key)) {
      const text = this.dir.readText(r.name);
      if (text === null) continue;
      try {
        return JSON.parse(text) as T;
      } catch {
        // a damaged record: the one below it is the last good one
      }
    }
    return null;
  }

  private write(key: string, value: unknown): void {
    const old = this.revs(key);
    this.dir.create(`r-${key}-${String((old[0]?.rev ?? 0) + 1).padStart(6, '0')}.json`, JSON.stringify(value));
    for (const o of old) this.dir.remove(o.name);
  }

  private drop(key: string): void {
    for (const o of this.revs(key)) this.dir.remove(o.name);
  }

  saveJob(job: JobCopy): void {
    this.write(`job-${job.job.jobNumber}`, job);
  }

  job(jobNumber: number): JobCopy | null {
    return this.read<JobCopy>(`job-${jobNumber}`);
  }

  forgetJob(jobNumber: number): void {
    this.drop(`job-${jobNumber}`);
  }

  /** The note draft; an empty text deletes it (Discard, or a draft typed away to nothing). */
  saveDraft(jobNumber: number, text: string): void {
    if (text === '') this.drop(`draft-${jobNumber}`);
    else this.write(`draft-${jobNumber}`, { text });
  }

  draft(jobNumber: number): string | null {
    return this.read<{ text: string }>(`draft-${jobNumber}`)?.text ?? null;
  }

  saveFinish(d: FinishDraft): void {
    this.write(`fin-${d.jobNumber}`, d);
  }

  finish(jobNumber: number): FinishDraft | null {
    return this.read<FinishDraft>(`fin-${jobNumber}`);
  }

  forgetFinish(jobNumber: number): void {
    this.drop(`fin-${jobNumber}`);
  }

  saveParts(parts: Part[]): void {
    this.write('parts', parts);
  }

  parts(): Part[] | null {
    return this.read<Part[]>('parts');
  }

  saveMe(me: { userId: string; name: string }): void {
    this.write('me', me);
  }

  me(): { userId: string; name: string } | null {
    return this.read<{ userId: string; name: string }>('me');
  }

  /** Sign-out, or a different person signed in: every copy goes. */
  forgetAll(): void {
    for (const n of this.dir.list()) if (NAME.test(n) || n.startsWith(TEMP_PREFIX)) this.dir.remove(n);
  }
}
