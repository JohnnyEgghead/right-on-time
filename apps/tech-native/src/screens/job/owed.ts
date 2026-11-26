// SPDX-License-Identifier: AGPL-3.0-or-later
// The jobs of this phone whose finish waits and whose signature is owed (finish-leave.ts signatureOwed): the person left the finish screen
// after the finish was kept and before the signature was. Such a job reads Done, so its screens draw no Finish control of their own; the
// Job screen and Today draw 1 that opens the finish screen, which enters only the owed signature.
import { signatureOwed } from '@bw/outbox/src/items/native.ts';
import type { QueuedItem } from '@bw/outbox/src/items/native.ts';
import { refusedFinish, type FinishDraft } from './model.ts';
import { signed } from './signature.ts';

/** The jobs among the waiting items whose finish waits (not refused for parts), whose signature does not, and whose kept draft holds a signature. */
export function owedSignatures(waiting: readonly QueuedItem[], draftOf: (jobNumber: number) => FinishDraft | null): ReadonlySet<number> {
  const out = new Set<number>();
  for (const n of new Set(waiting.filter((i) => i.kind === 'finished').map((i) => i.jobNumber))) {
    if (refusedFinish(n, waiting) !== null) continue;
    const d = draftOf(n);
    if (signatureOwed(waiting, n, d?.signature != null && signed(d.signature.strokes))) out.add(n);
  }
  return out;
}
