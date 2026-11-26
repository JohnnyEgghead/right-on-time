// SPDX-License-Identifier: AGPL-3.0-or-later
// The Finish link back to a finish that waits for its signature (owed.ts): named for that job and for nobody else.
import { describe, expect, it } from 'vitest';
import type { QueuedItem } from '@bw/outbox/src/items/native.ts';
import type { FinishDraft } from './model.ts';
import { owedSignatures } from './owed.ts';

const item = (kind: string, jobNumber: number, extra: Record<string, unknown> = {}) =>
  ({ key: `${kind}-${jobNumber}`, kind, jobNumber, enteredRealMs: 1, baseVersion: 2, userId: 'u', ...extra }) as unknown as QueuedItem;
const signedDraft = (jobNumber: number): FinishDraft =>
  ({ jobNumber, parts: [], noPartsUsed: true, hours: null, minutes: null, workDone: [''], signature: { strokes: [[{ x: 1, y: 1 }, { x: 5, y: 5 }]], width: 10, height: 10, at: 't' } });

describe('the jobs that owe a signature on the phone', () => {
  // why: F-1985 only a kept finish with no signature waiting and a signed kept draft is owed, so no other job shows the link
  it('names the job whose finish waits with a signed draft and no waiting signature, and no other', () => {
    const drafts = new Map<number, FinishDraft | null>([
      [1, signedDraft(1)], [2, signedDraft(2)], [3, { ...signedDraft(3), signature: null }], [4, signedDraft(4)], [5, { ...signedDraft(5), signature: { ...signedDraft(5).signature!, strokes: [[]] } }],
    ]);
    const waiting = [
      item('finished', 1),
      item('finished', 2), item('signature', 2),
      item('finished', 3),
      item('finished', 4, { lastTry: { atRealMs: 1, outcome: 'refused', code: 'parts_required' } }),
      item('finished', 5),
      item('note', 6),
    ];
    expect([...owedSignatures(waiting, (n) => drafts.get(n) ?? null)]).toEqual([1]);
    expect([...owedSignatures([], (n) => drafts.get(n) ?? null)]).toEqual([]);
  });
});
