// SPDX-License-Identifier: AGPL-3.0-or-later
// Spike S1: the SSE route (SPECIFICATIONS section 4.1, "Route handler returning a ReadableStream").
// Each stream subscribes to the process bus, filtered by branch, and sends an SSE comment
// heartbeat every 15 s (section 4.3).
import { bus } from '../../../../lib/bus.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HEARTBEAT_MS = 15_000;

export async function GET(request) {
  const url = new URL(request.url);
  const branch = Number(url.searchParams.get('branch') ?? '1');
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (text) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const sub = bus.subscribe((event) => {
        if (event?.ids?.branchId !== branch) return;
        send(`id: ${event.seq}\nevent: ${event.name}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      const heartbeat = setInterval(() => send(': hb\n\n'), HEARTBEAT_MS);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        sub.unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed by the runtime
        }
      };
      request.signal.addEventListener('abort', () => cleanup());
      await sub.ready;
      send('retry: 3000\n: open\n\n');
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
