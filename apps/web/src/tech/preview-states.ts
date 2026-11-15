// SPDX-License-Identifier: AGPL-3.0-or-later
// The fixed engine states the tech preview routes draw (harness build only; SyncPreview.tsx, FramePreview.tsx).
import type { AnsweredItem, QueuedItem } from '@bw/outbox/src/items/index.ts';
import type { OutboxState } from './engine.ts';

const item = (n: number, enteredRealMs = 0): QueuedItem => ({
  key: `00000000-0000-4000-8000-00000000000${n}`, worldEpoch: 1, deviceTime: '', offsetSavedReal: '', sinceSaveMs: 0, demoTime: '', enteredRealMs,
  jobNumber: 24830, baseVersion: 3, userId: 'u', kind: 'note', payload: { text: 'note' },
});
const answered = (n: number): AnsweredItem => ({
  key: `00000000-0000-4000-8000-00000000001${n}`, kind: 'note', jobNumber: 24830, enteredRealMs: 0, answeredRealMs: 0,
  result: 'applied', code: null, messageKey: null, values: null,
});
const base: OutboxState = { ready: true, waiting: [], online: true, sending: false, oldCount: 0, lastSent: [], signedOut: false };
export const STATES: Record<string, OutboxState> = {
  synced: base,
  waiting: { ...base, waiting: [item(1), item(2), item(3)] },
  offline: { ...base, online: false, waiting: [item(1), item(2), item(3)] },
  old: { ...base, online: false, waiting: [item(1), item(2)], oldCount: 1 },
  sent: { ...base, lastSent: [answered(1), answered(2), answered(3)] },
};

