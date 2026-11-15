// SPDX-License-Identifier: AGPL-3.0-or-later
// The event stream, API-09 (SPECIFICATIONS 7.3): `text/event-stream`, `event: <name>`, `id: <seq>`, `data: {ids}`, filtered by
// the caller's branch (?branch) and role, a heartbeat comment every 15 s. `Last-Event-ID` is ignored: a reconnecting page
// re-reads in full (4.3). API-09 is a stream row of the contract table with a policy entry (F-344): the kernel resolves the
// caller and authorizes it (the access code, then every signed-in staff role) before this handler runs, opens no
// transaction for it, and answers the stream body this handler returns as text/event-stream.
import type { BusEvent } from '@bw/db';
import type { Handler } from '../types.ts';

/** The served path of API-09. */
export const EVENTS_PATH = '/api/v1/events';
/** SPECIFICATIONS 4.3: an SSE comment every 15 s real time. */
export const HEARTBEAT_MS = 15_000;
/** How long a stream opened while the LISTEN connection is down waits for it before it refuses (503 retry). */
export const LISTEN_WAIT_MS = 5_000;

/** One event as the SSE text: the `data:` line is `{ids}` only. */
export const sseFrame = (e: BusEvent): string => `event: ${e.name}\nid: ${e.seq}\ndata: ${JSON.stringify({ ids: e.ids })}\n\n`;

/** The API-09 handler: subscribes the authorized caller to the process's bus (HandlerContext.events) and streams its events. */
export function eventStreamHandler(opts: { heartbeatMs?: number; listenWaitMs?: number } = {}): Handler<ReadableStream<Uint8Array>> {
  return async (req, _tx, ctx) => {
    const bus = ctx.events;
    // The policy entry admits staff only; anything else here is a defect.
    if (bus === null || req.caller.kind !== 'staff') return { ok: false, status: 500, code: 'server_error' };
    const role = req.caller.role;
    const branch = (req.params as { branch?: string }).branch;

    // A stream opened while the LISTEN connection is down would never hear an event: wait briefly, then refuse (503 retry).
    if (!bus.listening && !(await bus.ready(opts.listenWaitMs ?? LISTEN_WAIT_MS))) return { ok: false, status: 500, code: 'server_error' };

    const enc = new TextEncoder();
    let cleanup = (): void => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let done = false;
        const send = (text: string): void => {
          if (!done) controller.enqueue(enc.encode(text));
        };
        const finish = (): void => {
          if (done) return;
          done = true;
          clearInterval(timer);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // already closed by the consumer
          }
        };
        const unsubscribe = bus.subscribe({ branch, role }, (e) => send(sseFrame(e)), finish);
        const timer = setInterval(() => send(': heartbeat\n\n'), opts.heartbeatMs ?? HEARTBEAT_MS);
        cleanup = finish;
        send('retry: 2000\n: connected\n\n');
      },
      cancel() {
        cleanup();
      },
    });
    return { ok: true, status: 200, data: body };
  };
}
