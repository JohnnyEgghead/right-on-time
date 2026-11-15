// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: SD-13, SD-43, NFR-01 (the LISTEN side: rising seq, branch and role filter, loss closes the streams)
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Temporal } from '@bw/time';
import { EMIT_KEEP_MS, PgNotifyBus, roleSees } from './bus.ts';

class FakeClient extends EventEmitter {
  queries: string[] = [];
  connect = vi.fn(async () => undefined);
  query = vi.fn(async (q: string) => {
    this.queries.push(q);
    return { rows: [] };
  });
  end = vi.fn(async () => undefined);
  notify(payload: string, channel = 'bw_events'): void {
    this.emit('notification', { channel, payload });
  }
}

const fixedClock = (now: () => number = () => 0) => ({ realNow: () => Temporal.Instant.fromEpochMilliseconds(now()) });

async function started(opts: { now?: () => number } = {}) {
  const client = new FakeClient();
  const bus = new PgNotifyBus({ newClient: () => client as never, firstSeq: 100, retryWaitMs: () => 5, clock: fixedClock(opts.now) });
  const seen: unknown[] = [];
  const lost = vi.fn();
  const off = bus.subscribe({ role: 'office' }, (e) => seen.push(e), lost);
  await bus.ready();
  return { client, bus, seen, lost, off };
}

const note = (name: string, ids: object) => JSON.stringify({ name, ids });

describe('PgNotifyBus', () => {
  it('opens 1 LISTEN connection and gives each event a rising seq with its ids only', async () => {
    const { client, bus, seen } = await started();
    expect(client.queries).toEqual(['LISTEN bw_events']);
    client.notify(note('job.changed', { jobNumber: 1, branch: 'columbus' }));
    client.notify(note('board.refresh', { branch: 'columbus' }));
    expect(seen).toEqual([
      { seq: 101, name: 'job.changed', ids: { jobNumber: 1, branch: 'columbus' } },
      { seq: 102, name: 'board.refresh', ids: { branch: 'columbus' } },
    ]);
    await bus.close();
  });

  it('ignores other channels and malformed payloads', async () => {
    const { client, bus, seen } = await started();
    client.notify(note('job.changed', {}), 'other');
    client.notify('garbage');
    expect(seen).toEqual([]);
    await bus.close();
  });

  it('filters by branch (an event without a branch goes to every branch) and by role', async () => {
    const client = new FakeClient();
    const bus = new PgNotifyBus({ newClient: () => client as never, firstSeq: 0, clock: fixedClock() });
    const cols: string[] = [];
    const dayt: string[] = [];
    const tech: string[] = [];
    bus.subscribe({ role: 'office', branch: 'columbus' }, (e) => cols.push(e.name));
    bus.subscribe({ role: 'office', branch: 'dayton' }, (e) => dayt.push(e.name));
    bus.subscribe({ role: 'technician' }, (e) => tech.push(e.name));
    await bus.ready();
    client.notify(note('job.changed', { branch: 'columbus' }));
    client.notify(note('alert.created', { alertId: 'a' }));
    expect(cols).toEqual(['job.changed', 'alert.created']);
    expect(dayt).toEqual(['alert.created']);
    expect(tech).toEqual(['job.changed']);
    expect(roleSees('technician', 'billing.changed')).toBe(false);
    await bus.close();
  });

  it('tells every subscriber it is lost when the LISTEN connection drops, then listens again', async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const clients = [first, second];
    const bus = new PgNotifyBus({ newClient: () => clients.shift() as never, firstSeq: 0, retryWaitMs: () => 5, clock: fixedClock() });
    const lost = vi.fn();
    bus.subscribe({ role: 'office' }, () => undefined, lost);
    await bus.ready();
    first.emit('error', new Error('connection terminated'));
    expect(lost).toHaveBeenCalledTimes(1);
    expect(bus.listening).toBe(false);
    await bus.ready();
    expect(bus.listening).toBe(true);
    expect(second.queries).toEqual(['LISTEN bw_events']);
    await bus.close();
  });

  it('keeps each seq emit time for 60 s and no longer (SD-43)', async () => {
    let now = 1_000_000;
    const { client, bus } = await started({ now: () => now });
    client.notify(note('clock.changed', {}));
    expect(bus.emitTime(101)).toBe(1_000_000);
    now += EMIT_KEEP_MS + 1;
    expect(bus.emitTime(101)).toBeUndefined();
    await bus.close();
  });
});
