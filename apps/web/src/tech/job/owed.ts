// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The jobs of this phone whose finish waits and whose signature is owed (finish-leave.ts signatureOwed): the person left the finish screen
// after the finish was kept and before the signature was. The job then reads Done, so its screens draw no Finish link of their own; this
// tells them to draw one that opens the finish screen, which enters only the owed signature.
import type { QueuedItem } from '@bw/outbox/src/items/index.ts';
import { useEffect, useState } from 'react';
import { signatureOwed } from '../engine.ts';
import { isRefusedFinish } from './model.ts';
import { jobStore } from './store.ts';

const NONE: ReadonlySet<number> = new Set();

/** The jobs among the waiting items whose finish waits (not refused for parts), whose signature does not, and whose kept draft holds a signature. */
export async function owedJobs(waiting: readonly QueuedItem[], draftHasSignature: (jobNumber: number) => Promise<boolean>): Promise<Set<number>> {
  const jobs = new Set(waiting.filter((i) => i.kind === 'finished' && !isRefusedFinish(i)).map((i) => i.jobNumber));
  const got = await Promise.all([...jobs].map(async (n) => (signatureOwed(waiting, n, await draftHasSignature(n)) ? n : null)));
  return new Set(got.filter((n): n is number => n !== null));
}

export function useOwedSignatures(waiting: readonly QueuedItem[]): ReadonlySet<number> {
  const [owed, setOwed] = useState<ReadonlySet<number>>(NONE);
  const jobs = [...new Set(waiting.filter((i) => i.kind === 'finished' && !isRefusedFinish(i)).map((i) => i.jobNumber))].sort((a, b) => a - b);
  // The waiting list is a new array after every refresh: the effect runs again only when the jobs it would read, or their signatures, change.
  const key = `${jobs.join(',')}|${waiting.filter((i) => i.kind === 'signature').map((i) => i.jobNumber).join(',')}`;
  useEffect(() => {
    let live = true;
    void owedJobs(waiting, async (n) => (await jobStore().finish(n))?.signature != null)
      .then((got) => live && setOwed(got))
      // A draft that cannot be read leaves the last answer standing: the finish screen itself still decides when it opens.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [key]);
  return jobs.length === 0 ? NONE : owed;
}
