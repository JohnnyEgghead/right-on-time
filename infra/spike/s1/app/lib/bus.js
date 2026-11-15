// SPDX-License-Identifier: AGPL-3.0-or-later
// Spike S1: the PgNotifyBus shape of SPECIFICATIONS section 4.3, cut down.
// 1 LISTEN bw_events connection per web process fans each notification out to that
// process's SSE streams. Payloads carry ids only (D1). Shared through globalThis so
// every route module in the process sees the same bus and the same pool.
import pg from 'pg';

const KEY = Symbol.for('bw.spike.s1');

function create() {
  const subscribers = new Set();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  let listening = null;
  let delivered = 0;

  async function listen() {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    client.on('notification', (msg) => {
      let event;
      try {
        event = JSON.parse(msg.payload ?? '');
      } catch {
        return;
      }
      for (const fn of subscribers) fn(event);
      delivered += 1;
    });
    client.on('error', (err) => {
      // A lost LISTEN connection would silently stop every stream; for the spike, fail loudly.
      console.error(JSON.stringify({ level: 'error', msg: 'listen connection lost', error: err.message }));
      process.exit(1);
    });
    await client.connect();
    await client.query('LISTEN bw_events');
    return client;
  }

  return {
    pool,
    subscribe(fn) {
      subscribers.add(fn);
      listening ??= listen();
      return { ready: listening, unsubscribe: () => subscribers.delete(fn) };
    },
    stats: () => ({ streams: subscribers.size, notifications: delivered }),
  };
}

globalThis[KEY] ??= create();
export const bus = globalThis[KEY];
