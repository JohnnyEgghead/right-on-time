// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: SD-13, NFR-01 (the event bus contract: pg_notify carries ids only)
import { describe, expect, it, vi } from 'vitest';
import { BUS_CHANNEL, decodeNotification, encodeNotification, publishEvent } from './events.ts';

describe('the bus notification', () => {
  it('encodes a name and ids and nothing else, and decodes it back', () => {
    const text = encodeNotification('job.changed', { jobNumber: 24800, branch: 'columbus' });
    expect(JSON.parse(text)).toEqual({ name: 'job.changed', ids: { jobNumber: 24800, branch: 'columbus' } });
    expect(decodeNotification(text)).toEqual({ name: 'job.changed', ids: { jobNumber: 24800, branch: 'columbus' } });
  });

  it('refuses an id value that is a row, a list or null (ids only, D1)', () => {
    expect(() => encodeNotification('job.changed', { row: { a: 1 } } as never)).toThrow(/ids only/);
    expect(() => encodeNotification('job.changed', { list: [1] } as never)).toThrow(/ids only/);
    expect(() => encodeNotification('job.changed', { n: null } as never)).toThrow(/ids only/);
  });

  it('drops a payload that is not a bus payload', () => {
    for (const bad of [undefined, 'nope', '[]', '{"name":"x.y","ids":{}}', '{"name":"job.changed","ids":{"a":{"b":1}}}', '{"name":"job.changed"}']) {
      expect(decodeNotification(bad)).toBeNull();
    }
  });

  it('publishes through pg_notify on the bw_events channel with the encoded text', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    await publishEvent({ query }, 'world.reset', { worldEpoch: 3 });
    expect(query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [BUS_CHANNEL, '{"name":"world.reset","ids":{"worldEpoch":3}}']);
    expect(BUS_CHANNEL).toBe('bw_events');
  });
});
