// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: SD-13, SD-43, SD-47, NFR-01 (P3-EVENTS Acceptance: the event bus and the event stream on the Compose stack at its default settings)
// A notify reaches 2 open streams with ids only; a stream that was dropped reconnects (the 30 s outage and the 15 s heartbeat: unit tests, P10-NIGHTLY-SPEED) and the page re-reads; a worldEpoch
// change empties the client cache; each event carries a rising seq. The stack is real PostgreSQL 18, the real handlers
// (API-10 is read through the client) and pbs running, reached through its proxy (nginx's /api/v1/events location). The
// rows are ci/shell-stack/fixture.sql's (the clock row at epoch 1, 1 office user and its session).
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectEventStream, createClient, createResourceCache, readClock, type StreamEvent } from '../../packages/api/src/index.ts';
import type { Queryable } from '../../packages/db/src/client.ts';
import { publishEvent, type EventIds, type EventName } from '../../packages/db/src/events.ts';

const base = process.env.BW_EVENTS_STACK_URL;
const session = process.env.BW_EVENTS_STACK_SESSION;
const dbContainer = process.env.BW_EVENTS_DB_CONTAINER;
if (!base || !session || !dbContainer) throw new Error('BW_EVENTS_STACK_URL, _SESSION and _DB_CONTAINER are not set: run ci/events-stack.sh');
const origin = new URL(base).origin;
const headers = { cookie: `bw_session=${session}` };

/** Run SQL in the stack's database as its owner login (the way a writer's transaction would). */
function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', dbContainer!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout;
}
/**
 * A Queryable over psql in the stack's database, signed in as a writer login (F-348: the worker's own login, bw_worker,
 * not the owner): each query runs in its own committed transaction, its $n parameters passed as psql variables, so the
 * values are quoted by psql, never spliced into the SQL.
 */
function writerTx(login: 'bw_worker' | 'bw_web'): Queryable {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      const vars = values.flatMap((v, i) => ['-v', `p${i + 1}=${String(v)}`]);
      const text = sql.replace(/\$(\d+)/g, (_m, n: string) => `:'p${n}'`);
      const r = spawnSync('docker', ['exec', '-i', dbContainer!, 'psql', '-q', '-t', '-A', '-U', login, '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', ...vars, '-f', '-'],
        { encoding: 'utf8', input: `BEGIN;\n${text};\nCOMMIT;\n` });
      if (r.status !== 0) throw new Error(`psql as ${login} failed (${r.status}): ${r.stderr.slice(0, 300)}`);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Queryable;
}
/** A writer's committed transaction that publishes 1 event through the bus's 1 publisher (@bw/db publishEvent). */
async function publish(name: EventName, ids: EventIds): Promise<void> {
  await publishEvent(writerTx('bw_worker'), name, ids);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** A raw reader of the stream, so the test sees the exact wire text. */
async function openRaw(url: string): Promise<{ text: () => string; close: () => void; status: number; type: string }> {
  const ctl = new AbortController();
  const res = await fetch(url, { headers: { ...headers, accept: 'text/event-stream' }, signal: ctl.signal });
  let text = '';
  void (async () => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of res.body!) text += dec.decode(chunk as Uint8Array, { stream: true });
    } catch {
      // closed
    }
  })();
  return { text: () => text, close: () => ctl.abort(), status: res.status, type: res.headers.get('content-type') ?? '' };
}
const frames = (t: string) => [...t.matchAll(/event: (\S+)\nid: (\d+)\ndata: (.*)\n\n/g)].map((m) => ({ event: m[1]!, id: Number(m[2]), data: m[3]! }));

/** A TCP relay in front of the stack's proxy that the test can cut and restore: the "dropped network" of the reconnect case. */
function relay(targetPort: number) {
  const sockets = new Set<net.Socket>();
  let cut = false;
  const server = net.createServer((client) => {
    if (cut) return void client.destroy();
    const up = net.connect(targetPort, '127.0.0.1');
    sockets.add(client).add(up);
    client.pipe(up).pipe(client);
    const drop = () => { client.destroy(); up.destroy(); sockets.delete(client); sockets.delete(up); };
    client.on('error', drop).on('close', drop);
    up.on('error', drop).on('close', drop);
  });
  return {
    listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port))),
    cut: () => { cut = true; for (const s of sockets) s.destroy(); },
    restore: () => { cut = false; },
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  };
}

const eventsUrl = `${origin}/api/v1/events`;
const open: { close: () => void }[] = [];
afterAll(() => open.forEach((o) => o.close()));

beforeAll(() => {
  // The stack is up with the fixture rows: epoch 1.
  expect(psql('SELECT world_epoch FROM system.demo_clock').trim()).toBe('1');
});

describe('the event stream on the Compose stack', () => {
  // why: SD-13
  it('refuses a caller with no session', async () => {
    const res = await fetch(eventsUrl, { headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  // why: SD-13, NFR-01
  it('delivers 1 notify to 2 open streams with ids only, each event with a rising seq', async () => {
    const a = await openRaw(eventsUrl);
    const b = await openRaw(`${eventsUrl}?branch=columbus`);
    const other = await openRaw(`${eventsUrl}?branch=dayton`);
    open.push(a, b, other);
    expect(a.status).toBe(200);
    expect(a.type).toContain('text/event-stream');
    await until('the streams to open', () => a.text().includes(': connected') && b.text().includes(': connected') && other.text().includes(': connected'));

    await publish('job.changed', { jobNumber: 24800, branch: 'columbus' });
    await publish('board.refresh', { branch: 'columbus', date: '2026-09-15' });
    await publish('alert.created', { alertId: 'a-1' });
    await until('3 events on each stream', () => frames(a.text()).length === 3 && frames(b.text()).length === 3);

    for (const s of [a, b]) {
      const f = frames(s.text());
      expect(f.map((x) => x.event)).toEqual(['job.changed', 'board.refresh', 'alert.created']);
      // the data line is {ids} and nothing else: no row, no names, no counts
      expect(f.map((x) => JSON.parse(x.data))).toEqual([
        { ids: { jobNumber: 24800, branch: 'columbus' } },
        { ids: { branch: 'columbus', date: '2026-09-15' } },
        { ids: { alertId: 'a-1' } },
      ]);
      // a rising seq
      expect(f[1]!.id).toBeGreaterThan(f[0]!.id);
      expect(f[2]!.id).toBeGreaterThan(f[1]!.id);
    }
    // both streams carry the same seq for the same event
    expect(frames(a.text()).map((x) => x.id)).toEqual(frames(b.text()).map((x) => x.id));
    // the other branch heard only the event with no branch
    expect(frames(other.text()).map((x) => x.event)).toEqual(['alert.created']);
  });

  // why: SD-47
  it('empties the client cache when a world.reset moves the worldEpoch, and the next read carries the new epoch', async () => {
    const client = createClient({ baseUrl: origin, headers });
    const cache = createResourceCache(client);
    const first = await cache.read(readClock, {});
    expect(first.worldEpoch).toBe(1);
    expect(cache.size).toBe(1);

    const events: StreamEvent[] = [];
    const h = connectEventStream({
      url: eventsUrl, headers,
      onEvent: (e) => {
        events.push(e);
        if (e.name === 'world.reset') cache.observeEpoch(Number(e.ids.worldEpoch));
      },
    });
    open.push(h);
    await until('the stream to be live', () => h.state === 'live');
    // F-549: pbs_epoch moves with it, as a confirmed reset leaves the row. The worker's reset confirmer (P3-REPLAY, every 5 s)
    // treats world_epoch above pbs_epoch as an unconfirmed reset and, when it confirms, unpauses the clock: it would undo the
    // pause the next case sets and reads back.
    psql('BEGIN; UPDATE system.demo_clock SET world_epoch = 2, pbs_epoch = 2; COMMIT;');
    await publish('world.reset', { worldEpoch: 2 });
    await until('the world.reset event', () => events.some((e) => e.name === 'world.reset'));
    expect(cache.size).toBe(0);
    expect(cache.peek(readClock, {})).toBeUndefined();
    expect((await cache.read(readClock, {})).worldEpoch).toBe(2);
    expect(cache.epoch).toBe(2);
  });

  // why: SD-13, SD-47 (P10-NIGHTLY-SPEED, F-2091: the 30 s outage and the 15 s heartbeat are fake-timer unit tests, packages/api/src/event-stream.test.ts and packages/api-server/src/events/stream.test.ts; this case keeps the real cut, the real reconnect and the real API-10 re-read, with no wait)
  it('reconnects a stream that was dropped, re-reads API-10 through the cache once, and keeps delivering with a higher seq', async () => {
    const proxyPort = Number(new URL(base!).port);
    const r = relay(proxyPort);
    const port = await r.listen();
    open.push(r);
    const states: string[] = [];
    const events: StreamEvent[] = [];
    let rereads = 0;
    // F-348: the page's re-read is a real one: API-10 through the resource cache, as every region re-reads on reconnect.
    const cache = createResourceCache(createClient({ baseUrl: origin, headers }));
    expect((await cache.read(readClock, {})).paused).toBe(false);
    const reread: Promise<unknown>[] = [];
    const h = connectEventStream({
      url: `http://127.0.0.1:${port}/api/v1/events`, headers,
      onEvent: (e) => events.push(e),
      onReconnect: () => {
        rereads++;
        reread.push(cache.read(readClock, {}));
      },
      onState: (s) => states.push(s),
      retryWaitMs: (n) => Math.min(2_000, 500 * 2 ** n),
    });
    open.push(h);
    await until('the stream to be live', () => h.state === 'live');
    await publish('clock.changed', {});
    await until('the first event', () => events.length === 1);
    expect(rereads).toBe(0);

    r.cut();
    await until('the stream to notice', () => h.state === 'reconnecting');
    await publish('clock.changed', {}); // missed: never replayed (D1)
    psql('BEGIN; UPDATE system.demo_clock SET paused = true; COMMIT;'); // the change the missed event announced
    expect(h.state).toBe('reconnecting');
    r.restore();
    await until('the stream to reconnect', () => h.state === 'live' && rereads === 1);
    expect(events).toHaveLength(1); // the event of the gap was not replayed: the page re-reads instead
    await Promise.all(reread);
    expect(cache.peek(readClock, {})?.paused).toBe(true); // the re-read brought the gap's change

    await publish('clock.changed', {});
    await until('an event after the reconnect', () => events.length === 2);
    expect(events[1]!.seq).toBeGreaterThan(events[0]!.seq);
    expect(rereads).toBe(1);
    expect(states).toEqual(['live', 'reconnecting', 'live']);
  }, 60_000);
});
