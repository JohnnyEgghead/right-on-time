// SPDX-License-Identifier: AGPL-3.0-or-later
// API-09 as a stream row of the contract table (F-344), the stream's end path tied to the request (F-345) and the LISTEN
// connection's liveness check (F-347). No database: the real mounted router over the real policy table and handlers,
// with a stand-in bus; the real PgNotifyBus over a fake client; the real node:http adapter.
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { BusEvent } from '@bw/db';
import { Temporal } from '@bw/time';
import { handlers, tokenChecks } from '../handlers/index.ts';
import { sendResponse } from '../node.ts';
import { policyTable } from '../policy.ts';
import { kit } from '../testing.ts';
import type { EventBusPort } from '../types.ts';
import { PgNotifyBus } from './bus.ts';
import { EVENTS_PATH } from './stream.ts';

/** A bus that is listening, keeps its subscribers, and lets the test emit. */
function standInBus(listening = true) {
  const subs = new Set<{ filter: { branch?: string | undefined; role: string }; onEvent: (e: BusEvent) => void }>();
  const bus: EventBusPort & { emit(e: BusEvent): void; subs: typeof subs } = {
    listening,
    ready: async () => listening,
    emitTime: () => undefined,
    subscribe(filter, onEvent) {
      const s = { filter, onEvent };
      subs.add(s);
      return () => subs.delete(s);
    },
    emit(e) {
      for (const s of subs) if (s.filter.branch === undefined || e.ids.branch === undefined || e.ids.branch === s.filter.branch) s.onEvent(e);
    },
    subs,
  };
  return bus;
}

const read = async (body: ReadableStream<Uint8Array>, until: string): Promise<string> => {
  const reader = body.getReader();
  let text = '';
  while (!text.includes(until)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text;
};

describe('API-09 through the policy table (F-344)', () => {
  // why: F-344, SD-7
  it('is a contract row with a policy entry for every signed-in role, so the mounted router serves it', () => {
    const entry = policyTable.find((e) => e.kind === 'api' && e.contract === 'API-09');
    expect(entry).toMatchObject({ kind: 'api', method: 'GET', path: EVENTS_PATH, access: { kind: 'roles', roles: ['manager', 'office', 'technician'] } });
    expect(entry?.kind === 'api' && entry.row.stream).toBe(true);
    expect(kit(policyTable, { ...handlers }).router.routes.some((r) => r.contract === 'API-09')).toBe(true);
  });

  // why: F-344, NFR-01
  it('streams a signed-in caller its branch events as text/event-stream, and the cancel unsubscribes', async () => {
    const bus = standInBus();
    const k = kit(policyTable, { ...handlers }, {}, tokenChecks, { events: bus });
    const { cookie } = await k.signIn('office');
    const res = await k.call('GET', `${EVENTS_PATH}?branch=columbus`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const body = res.body!;
    expect(await read(body, ': connected')).toContain('retry: 2000');
    bus.emit({ seq: 7, name: 'job.changed', ids: { jobNumber: 24825, branch: 'dayton' } });
    bus.emit({ seq: 8, name: 'job.changed', ids: { jobNumber: 24830, branch: 'columbus' } });
    expect(await read(body, 'id: 8')).toBe('event: job.changed\nid: 8\ndata: {"ids":{"jobNumber":24830,"branch":"columbus"}}\n\n');
    expect(bus.subs.size).toBe(1);
    await body.cancel();
    expect(bus.subs.size).toBe(0);
  });

  // why: F-344, FR-AUTH-1
  it('refuses through the kernel: no session is unauthenticated, the code unentered is access_code_required', async () => {
    const off = kit(policyTable, { ...handlers }, {}, tokenChecks, { events: standInBus() });
    const anon = await off.call('GET', EVENTS_PATH);
    expect([anon.status, ((await anon.json()) as { code: string }).code]).toEqual([401, 'unauthenticated']);
    const on = kit(policyTable, { ...handlers }, { ACCESS_CODE_ON: true }, tokenChecks, { events: standInBus() });
    const coded = await on.call('GET', EVENTS_PATH);
    expect([coded.status, ((await coded.json()) as { code: string }).code]).toEqual([403, 'access_code_required']);
    const codeOnly = await on.call('GET', EVENTS_PATH, { headers: { cookie: on.accessCookie() } });
    expect([codeOnly.status, ((await codeOnly.json()) as { code: string }).code]).toEqual([401, 'unauthenticated']);
    // A password session passed the code at sign-in (authorize.ts codePassed).
    const signedIn = await on.call('GET', EVENTS_PATH, { headers: { cookie: (await on.signIn('technician')).cookie } });
    expect(signedIn.status).toBe(200);
    await signedIn.body?.cancel();
  });

  // why: F-344, SD-13
  it('answers server_error (retry) when the LISTEN connection is not up, and when the process has no bus', async () => {
    const down = kit(policyTable, { ...handlers }, {}, tokenChecks, { events: standInBus(false) });
    const a = await down.call('GET', EVENTS_PATH, { headers: { cookie: (await down.signIn('manager')).cookie } });
    expect([a.status, ((await a.json()) as { code: string }).code]).toEqual([500, 'server_error']);
    const none = kit(policyTable, { ...handlers });
    const b = await none.call('GET', EVENTS_PATH, { headers: { cookie: (await none.signIn('manager')).cookie } });
    expect(b.status).toBe(500);
  });
});

describe("the stream's end path (F-345)", () => {
  // why: F-345
  it('cancels the stream body at once when the client left before the answer was ready', async () => {
    const cancelled = vi.fn();
    let gone: () => void = () => undefined;
    const left = new Promise<void>((r) => { gone = r; });
    let hooked: () => void = () => undefined;
    const reached = new Promise<void>((r) => { hooked = r; });
    const server = http.createServer((req, res) => {
      req.socket.on('close', () => gone());
      hooked();
      void left.then(async () => {
        const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
        await sendResponse(res, new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const ctl = new AbortController();
    const call = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { signal: ctl.signal }).catch(() => undefined);
    // The handler has hooked the socket: an abort before it (F-709: a timer under load) would never be heard.
    await reached;
    ctl.abort();
    await call;
    await left;
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled(), { timeout: 1_000 });
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  // why: F-345
  it("stops a timed-out ready() wait instead of polling on (the LISTEN connection never comes up)", async () => {
    const client = Object.assign(new EventEmitter(), { connect: () => new Promise(() => undefined), query: vi.fn(), end: vi.fn(async () => undefined) });
    const bus = new PgNotifyBus({ newClient: () => client as never, clock: { realNow: () => Temporal.Instant.fromEpochMilliseconds(0) }, livenessMs: false });
    const t0 = performance.now();
    expect(await bus.ready(60)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1_000);
    await bus.close();
  });
});

describe('the LISTEN connection liveness check (F-347)', () => {
  // why: F-347
  it('treats a LISTEN connection that stops answering as lost: every stream is told, and it reconnects', async () => {
    const clients: (EventEmitter & { query: ReturnType<typeof vi.fn> })[] = [];
    let hang = true;
    const make = () => {
      const c = Object.assign(new EventEmitter(), {
        connect: vi.fn(async () => undefined),
        query: vi.fn(async (q: string) => (q === 'SELECT 1' && hang ? new Promise(() => undefined) : { rows: [] })),
        end: vi.fn(async () => undefined),
      });
      clients.push(c);
      return c;
    };
    const bus = new PgNotifyBus({ newClient: () => make() as never, clock: { realNow: () => Temporal.Instant.fromEpochMilliseconds(0) }, livenessMs: 20, retryWaitMs: () => 5 });
    const lost = vi.fn();
    bus.subscribe({ role: 'office' }, () => undefined, lost);
    expect(await bus.ready(1_000)).toBe(true);
    await vi.waitFor(() => expect(lost).toHaveBeenCalledTimes(1), { timeout: 1_000 });
    hang = false;
    await vi.waitFor(() => expect(clients.length).toBeGreaterThanOrEqual(2), { timeout: 1_000 });
    expect(await bus.ready(1_000)).toBe(true);
    expect(clients[0]!.query).toHaveBeenCalledWith('SELECT 1');
    await bus.close();
  });
});
