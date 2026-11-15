// SPDX-License-Identifier: AGPL-3.0-or-later
// The web technician app's local copies beside the item store (UI-SPECIFICATION 4.5 rule 7, SCR-TEC-04 Offline, saved,
// SCR-TEC-05 and SCR-TEC-07; FR-TECH-4, FR-TECH-14, UD-35). 1 IndexedDB database per origin through Dexie, apart from the
// items database (@bw/outbox DexieItemStore), so the item store's schema and invariants stay P5-TWA-OUTBOX's:
//   jobs     the last API-101 answer of each job opened with signal, for an open with no signal
//   drafts   the Add note draft of each job, written on every change (CTL-TEC-05-01)
//   finish   the finish screen's entries of each job until it is finished: part rows, No parts used, labor, the
//            work-done lines and the signature PNG with its time (CTL-TEC-07-10, -11, -14)
//   parts    the name of the technician signed in with signal (API-07), for the own unsent notes (the parts list itself is
//            the app's one read loop's, data.ts TechReads, kept as bw.tech.parts)
// Every write asks for strict durability, as the item store does, so a reopened app finds what the screen said it kept.
// The copies are 1 person's (customer names, addresses, phones, notes, a signature): local.ts forgetPerson clears them at sign-out
// and personSignedIn when a different person signs in (forgetAll), as the F-1017 class asks of every copy a phone keeps.
import { Dexie, type Table } from 'dexie';
import type { MyJobAnswer, PartsAnswer } from '@bw/api';

export type JobCopy = MyJobAnswer;
export type Part = PartsAnswer['parts'][number];

export interface PartRow { partId: string; name: string; code: string; quantity: number }

export interface FinishDraft {
  jobNumber: number;
  parts: PartRow[];
  noPartsUsed: boolean;
  /** The labor fields as typed (CTL-TEC-07-07); null until the technician edits them (prefilled from Arrived to now). */
  hours: string | null;
  minutes: string | null;
  workDone: string[];
  /** The customer's signature, a PNG (SD-32: at most 1200 x 400), and the demo time it was signed at (a wire time). */
  signature: { png: Uint8Array; at: string } | null;
}

interface JobRow { jobNumber: number; job: JobCopy; savedRealMs: number }
interface DraftRow { jobNumber: number; text: string }
type PartsRow = { id: 'me'; name: string };

export const JOBS_DB_NAME = 'bw-tech-jobs';

export class JobCopyStore {
  readonly db: Dexie;
  private readonly jobs: Table<JobRow, number>;
  private readonly drafts: Table<DraftRow, number>;
  private readonly finishes: Table<FinishDraft, number>;
  private readonly parts: Table<PartsRow, string>;

  constructor(name: string = JOBS_DB_NAME, opts: { indexedDB?: IDBFactory; IDBKeyRange?: typeof IDBKeyRange } = {}) {
    this.db = new Dexie(name, { chromeTransactionDurability: 'strict', ...(opts.indexedDB ? { indexedDB: opts.indexedDB } : {}), ...(opts.IDBKeyRange ? { IDBKeyRange: opts.IDBKeyRange } : {}) });
    this.db.version(1).stores({ jobs: 'jobNumber', drafts: 'jobNumber', finish: 'jobNumber', parts: 'id' });
    this.jobs = this.db.table('jobs');
    this.drafts = this.db.table('drafts');
    this.finishes = this.db.table('finish');
    this.parts = this.db.table('parts');
  }

  async saveJob(job: JobCopy, savedRealMs: number): Promise<void> {
    await this.jobs.put({ jobNumber: job.job.jobNumber, job, savedRealMs });
  }

  async job(jobNumber: number): Promise<JobCopy | null> {
    return (await this.jobs.get(jobNumber))?.job ?? null;
  }

  async forgetJob(jobNumber: number): Promise<void> {
    await this.jobs.delete(jobNumber);
  }

  /** The note draft; an empty text deletes it (Discard, or a draft typed away to nothing). */
  async saveDraft(jobNumber: number, text: string): Promise<void> {
    if (text === '') await this.drafts.delete(jobNumber);
    else await this.drafts.put({ jobNumber, text });
  }

  async draft(jobNumber: number): Promise<string | null> {
    return (await this.drafts.get(jobNumber))?.text ?? null;
  }

  async saveFinish(d: FinishDraft): Promise<void> {
    await this.finishes.put({ ...d, parts: d.parts.map((p) => ({ ...p })), workDone: [...d.workDone] });
  }

  async finish(jobNumber: number): Promise<FinishDraft | null> {
    return (await this.finishes.get(jobNumber)) ?? null;
  }

  async forgetFinish(jobNumber: number): Promise<void> {
    await this.finishes.delete(jobNumber);
  }

  /** The signed-in technician's name (API-07), for the own unsent notes and photos with no signal. */
  async saveMe(name: string): Promise<void> {
    await this.parts.put({ id: 'me', name });
  }

  async me(): Promise<string | null> {
    const r = await this.parts.get('me');
    return r && r.id === 'me' ? r.name : null;
  }

  /** Sign-out, or a different person signed in: every copy goes, in 1 transaction (local.ts forgetPerson). */
  async forgetAll(): Promise<void> {
    await this.db.transaction('rw', [this.jobs, this.drafts, this.finishes, this.parts], async () => {
      await Promise.all([this.jobs.clear(), this.drafts.clear(), this.finishes.clear(), this.parts.clear()]);
    });
  }

  close(): void {
    this.db.close();
  }
}

let shared: JobCopyStore | null = null;
/** The page's 1 store, opened on first use in the browser. */
export function jobStore(): JobCopyStore {
  shared ??= new JobCopyStore();
  return shared;
}
