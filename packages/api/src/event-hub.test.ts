// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventHub, takesEvent, type EventSubscription } from './event-hub.ts';
import type { EventStreamHandle, EventStreamOptions, StreamEvent, StreamState } from './event-stream.ts';

/** A stand-in transport: counts the connections and lets a test drive the 1 open one. */
function fakeTransport() {
  const opened: (EventStreamOptions & { closed: boolean })[] = [];
  const connect = (o: EventStreamOptions): EventStreamHandle => {
    const row = { ...o, closed: false };
    opened.push(row);
    return { close: () => { row.closed = true; }, get state(): StreamState { return 'live'; } };
  };
  return { opened, connect, hub: createEventHub({ url: () => '/api/v1/events', connect }) };
}

const ev = (name: string, ids: StreamEvent['ids'] = {}): StreamEvent => ({ seq: 1, name, ids });
const sub = (over: Partial<EventSubscription> = {}): EventSubscription => ({ onEvent: vi.fn(), ...over });

describe('the tab\'s event connection (F-710)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // why: FR-DISP-12 a page beside the bell does not cost a 2nd connection (F-662, F-710): 1 URL, whatever the subscribers' branches
  it('serves the bell and the page on 1 connection with no branch on its URL', () => {
    const { opened, hub } = fakeTransport();
    hub.subscribe(sub({ branch: 'columbus' }));
    hub.subscribe(sub({ branch: 'dayton' }));
    hub.subscribe(sub());
    expect(opened).toHaveLength(1);
    expect(opened[0]!.url).toBe('/api/v1/events');
  });

  // why: SPECIFICATIONS 7.3 the filter of the bus: a branch's event reaches that branch, an event of no branch reaches every branch
  it('delivers by the server bus rule', () => {
    expect(takesEvent('dayton', ev('job.changed', { branch: 'dayton' }))).toBe(true);
    expect(takesEvent('dayton', ev('job.changed', { branch: 'columbus' }))).toBe(false);
    expect(takesEvent('dayton', ev('clock.changed'))).toBe(true);
    expect(takesEvent(undefined, ev('job.changed', { branch: 'columbus' }))).toBe(true);
    const { opened, hub } = fakeTransport();
    const d = sub({ branch: 'dayton' });
    const c = sub({ branch: 'columbus' });
    hub.subscribe(d);
    hub.subscribe(c);
    opened[0]!.onEvent(ev('job.changed', { branch: 'dayton' }));
    expect(d.onEvent).toHaveBeenCalledTimes(1);
    expect(c.onEvent).not.toHaveBeenCalled();
  });

  // why: F-712 a branch change is a new subscription, never a new connection
  it('keeps the connection across a cleanup and the next effect, and closes it when the last has gone', () => {
    const { opened, hub } = fakeTransport();
    const first = hub.subscribe(sub({ branch: 'columbus' }));
    first.close();
    const second = hub.subscribe(sub({ branch: 'dayton' }));
    vi.runAllTimers();
    expect(opened).toHaveLength(1);
    expect(opened[0]!.closed).toBe(false);
    second.close();
    vi.runAllTimers();
    expect(opened[0]!.closed).toBe(true);
    hub.subscribe(sub());
    expect(opened).toHaveLength(2);
  });

  // why: SPECIFICATIONS 4.3 a late subscriber hears the open connection's state at once, and everyone re-reads after a loss
  it('tells a late subscriber the state, and every subscriber of a reconnect', () => {
    const { opened, hub } = fakeTransport();
    const early = vi.fn();
    const reread = vi.fn();
    hub.subscribe(sub({ onState: early, onReconnect: reread }));
    opened[0]!.onState!('live');
    const late = vi.fn();
    const reread2 = vi.fn();
    hub.subscribe(sub({ onState: late, onReconnect: reread2 }));
    expect(late).toHaveBeenCalledWith('live');
    opened[0]!.onReconnect!();
    expect(reread).toHaveBeenCalledTimes(1);
    expect(reread2).toHaveBeenCalledTimes(1);
  });

  // why: SPECIFICATIONS 7.3 the stream closes on unauthenticated: the next screen's subscription sends no 2nd refused request (F-690)
  it('does not reopen a refused connection while anyone is subscribed', () => {
    const { opened, hub } = fakeTransport();
    hub.subscribe(sub());
    opened[0]!.onState!('closed');
    const late = vi.fn();
    const h = hub.subscribe(sub({ onState: late }));
    expect(opened).toHaveLength(1);
    expect(late).toHaveBeenCalledWith('closed');
    expect(h.state).toBe('closed');
  });

  // why: SPECIFICATIONS 7.3 one subscriber's failure never reaches another
  it('keeps delivering past a subscriber that throws', () => {
    const { opened, hub } = fakeTransport();
    const next = sub();
    hub.subscribe(sub({ onEvent: () => { throw new Error('a screen failed'); } }));
    hub.subscribe(next);
    opened[0]!.onEvent(ev('job.changed'));
    expect(next.onEvent).toHaveBeenCalledTimes(1);
  });

  // why: F-710 a closed subscription hears nothing more, and a double close is harmless
  it('stops delivering to a closed subscription', () => {
    const { opened, hub } = fakeTransport();
    const gone = sub();
    const stays = sub();
    const h = hub.subscribe(gone);
    hub.subscribe(stays);
    h.close();
    h.close();
    opened[0]!.onEvent(ev('job.changed'));
    expect(gone.onEvent).not.toHaveBeenCalled();
    expect(stays.onEvent).toHaveBeenCalledTimes(1);
    expect(h.state).toBe('closed');
  });
});
