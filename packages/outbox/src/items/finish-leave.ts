// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1932: how a finish screen leaves (SCR-TEC-07, both technician apps). A finish and its signature are 2 entries (API-102 and API-103), and
// the second can fail after the first was kept. The screen then stays open and a retry enters only what is not kept yet, so 1 finish and 1
// signature leave the phone. 1 object lives as long as its screen.
import type { EntryInput, TechOutbox } from './engine.ts';
import type { FinishPayload, QueuedItem } from './model.ts';

export interface FinishLeaveInput {
  jobNumber: number;
  baseVersion: number;
  payload: FinishPayload;
  /** The key of the finish the server refused (F-1025): it is corrected under that key, never entered beside it. */
  refusedKey: string | null;
  /** The signature's PNG; null with no signature. */
  signature: Uint8Array | null;
}

/**
 * F-1976: a finish of this job waits on the phone, no signature of it does, and the screen holds a signature: the signature is owed. A
 * screen opened again (the app closed, or the person left) builds a new FinishLeave that knows nothing of the first, so this reads the
 * outbox instead; resume() then makes it enter only the signature and never a second finish. A refused finish is not this case.
 */
export function signatureOwed(waiting: readonly QueuedItem[], jobNumber: number, hasSignature: boolean): boolean {
  return hasSignature
    && waiting.some((i) => i.jobNumber === jobNumber && i.kind === 'finished' && !(i.lastTry?.outcome === 'refused' && i.lastTry.code === 'parts_required'))
    && !waiting.some((i) => i.jobNumber === jobNumber && i.kind === 'signature');
}

export class FinishLeave {
  private readonly entries: Pick<TechOutbox, 'enter' | 'correctFinish'>;
  private finishKept = false;
  private done = false;

  constructor(entries: Pick<TechOutbox, 'enter' | 'correctFinish'>) {
    this.entries = entries;
  }

  /** The finish is kept and its signature is not: the screen must not close, and only the signature can still change. */
  get owed(): boolean {
    return this.finishKept && !this.done;
  }

  /** The finish was kept by an earlier screen (signatureOwed): from here on only the signature is entered. */
  resume(): void {
    if (!this.done) this.finishKept = true;
  }

  /** The entries after a change: a finish that is kept is what leaves, so until its signature is kept too only the signature changes. */
  entriesOf<D extends { signature: unknown }>(shown: D, changed: D, refused: boolean): D {
    return this.owed && !refused ? { ...shown, signature: changed.signature } : changed;
  }

  /** Enters what is not kept yet, the finish first; rejects when an entry is not kept, and can then be called again. */
  async leave(input: FinishLeaveInput): Promise<void> {
    const { jobNumber, baseVersion, payload, refusedKey, signature } = input;
    if (refusedKey !== null) await this.entries.correctFinish(refusedKey, payload);
    else if (!this.finishKept) await this.entries.enter({ jobNumber, baseVersion, body: { kind: 'finished', payload } } satisfies EntryInput);
    this.finishKept = true;
    if (signature) await this.entries.enter({ jobNumber, baseVersion: null, body: { kind: 'signature', contentType: 'image/png' }, blob: signature } satisfies EntryInput);
    this.done = true;
  }
}
