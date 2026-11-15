// SPDX-License-Identifier: AGPL-3.0-or-later
// The outbox's events leave through the bus's 1 publisher (@bw/db publishEvent) with the event catalog's ids.
import { describe, expect, it } from 'vitest';
import { BUS_CHANNEL, decodeNotification, type Queryable } from '@bw/db';
import { publish, publishTextChanged, textChangedIds } from './notify.ts';

/** A transaction that keeps every query it is sent. */
function recordingTx() {
  const sent: { sql: string; values: unknown[] }[] = [];
  const tx = { query: async (sql: string, values: unknown[] = []) => (sent.push({ sql, values }), { rows: [], rowCount: 0 }) } as unknown as Queryable;
  return { tx, sent };
}

describe('text.changed ids (UI-SPECIFICATION 12.3 EVT-03)', () => {
  // why: F-370
  it('names the text, its customer and its job, plus the branch the bus filters on', () => {
    expect(textChangedIds({ textId: 't1', customerId: 'c1', jobNumber: 24825, branch: 'columbus' }))
      .toEqual({ textId: 't1', customerId: 'c1', jobNumber: 24825, branch: 'columbus' });
  });

  // why: F-370
  it('leaves jobNumber out for a text with no job (an office text), never a null id', () => {
    expect(textChangedIds({ textId: 't2', customerId: 'c1', jobNumber: null, branch: 'columbus' }))
      .toEqual({ textId: 't2', customerId: 'c1', branch: 'columbus' });
  });

  // why: F-370
  it('publishes on the bus channel through publishEvent, so the payload decodes as a bus event', async () => {
    const { tx, sent } = recordingTx();
    await publishTextChanged(tx, { textId: 't3', customerId: 'c2', jobNumber: 24826, branch: 'columbus' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.values[0]).toBe(BUS_CHANNEL);
    expect(decodeNotification(sent[0]!.values[1] as string)).toEqual({
      name: 'text.changed', ids: { textId: 't3', customerId: 'c2', jobNumber: 24826, branch: 'columbus' },
    });
  });

  // why: F-370
  it("refuses an id that is not a string or a number (publishEvent's check, which the old copy skipped)", async () => {
    const { tx } = recordingTx();
    await expect(publish(tx, 'alert.created', { alertId: { nested: true } as unknown as string })).rejects.toThrow(/ids only/);
  });
});
