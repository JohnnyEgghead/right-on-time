// SPDX-License-Identifier: AGPL-3.0-or-later
// The page side of the event stream (SPECIFICATIONS 4.3, 7.3, SD-47, GAP-7): reads the SSE text of API-09, marks the stream
// lost after 30 s without a byte (the server writes a heartbeat comment every 15 s), reconnects, and on every reconnect
// calls `onReconnect` so the page re-reads every region in full. Missed events are never replayed and Last-Event-ID is
// never sent (D1). A 401 or 403 answer ends the stream for good ("stream closes on unauthenticated").
export interface StreamEvent {
  seq: number;
  name: string;
  ids: Record<string, string | number>;
}

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'closed';

export interface EventStreamOptions {
  url: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  onEvent: (e: StreamEvent) => void;
  /** After the stream is open again following a loss: the page re-reads in full. Not called for the first open. */
  onReconnect?: () => void;
  onState?: (s: StreamState) => void;
  /** GAP-7: no byte for this long marks the stream lost. Default 30 000 ms. */
  lostAfterMs?: number;
  /** Wait before the nth retry. Default 1 s growing to 10 s. */
  retryWaitMs?: (attempt: number) => number;
}

export interface EventStreamHandle {
  close(): void;
  readonly state: StreamState;
}

/** Parse SSE text into frames; returns the frames and the unparsed rest. Comment lines (`: ...`) make no frame. */
export function parseSse(buffer: string): { frames: { event: string; id: string; data: string }[]; rest: string } {
  const frames: { event: string; id: string; data: string }[] = [];
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    let id = '';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':') || line === '') continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length > 0) frames.push({ event, id, data: data.join('\n') });
  }
  return { frames, rest };
}

/** A refused answer's body is never read, so it is cancelled: Chromium keeps a fetch with an unread body open for the page's life (F-690). */
function discard(res: Response): void {
  void res.body?.cancel().catch(() => undefined);
}

export function connectEventStream(opts: EventStreamOptions): EventStreamHandle {
  const doFetch = opts.fetch ?? fetch;
  const lostAfter = opts.lostAfterMs ?? 30_000;
  const wait = opts.retryWaitMs ?? ((n: number) => Math.min(10_000, 1_000 * 2 ** n));
  let state: StreamState = 'connecting';
  let closed = false;
  let current: AbortController | null = null;
  let sleeper: NodeJS.Timeout | number | null = null;
  const set = (s: StreamState): void => {
    if (state === s) return;
    state = s;
    opts.onState?.(s);
  };

  const run = async (): Promise<void> => {
    let attempt = 0;
    let opened = false;
    while (!closed) {
      const ctl = new AbortController();
      current = ctl;
      let lostTimer: ReturnType<typeof setTimeout> | undefined;
      const arm = (): void => {
        clearTimeout(lostTimer);
        lostTimer = setTimeout(() => ctl.abort(), lostAfter);
      };
      try {
        arm();
        const res = await doFetch(opts.url, { headers: { accept: 'text/event-stream', ...opts.headers }, signal: ctl.signal });
        if (res.status === 401 || res.status === 403) {
          set('closed');
          closed = true;
          clearTimeout(lostTimer);
          discard(res);
          return;
        }
        if (res.status !== 200) discard(res);
        if (res.status === 200 && res.body) {
          attempt = 0;
          set('live');
          if (opened) opts.onReconnect?.();
          opened = true;
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            arm();
            buf += dec.decode(value, { stream: true });
            const parsed = parseSse(buf);
            buf = parsed.rest;
            for (const f of parsed.frames) {
              try {
                const d = JSON.parse(f.data) as { ids?: Record<string, string | number> };
                opts.onEvent({ seq: Number(f.id), name: f.event, ids: d.ids ?? {} });
              } catch {
                // a frame that is not ours is dropped
              }
            }
          }
        }
      } catch {
        // lost, refused or aborted: fall through to the retry
      }
      clearTimeout(lostTimer);
      if (closed) return;
      set('reconnecting');
      await new Promise<void>((r) => {
        sleeper = setTimeout(r, wait(attempt++));
      });
    }
  };
  void run();

  return {
    close() {
      closed = true;
      current?.abort();
      if (sleeper !== null) clearTimeout(sleeper as NodeJS.Timeout);
      set('closed');
    },
    get state() {
      return state;
    },
  };
}
