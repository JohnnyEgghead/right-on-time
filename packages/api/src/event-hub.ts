// SPDX-License-Identifier: AGPL-3.0-or-later
// The tab's 1 event connection (F-710, F-662, F-712): every live screen and the shell's chrome subscribe here instead of opening a stream
// of their own. A browser keeps at most 6 connections per host on HTTP/1.1, and a page beside the bell used to hold 2, so the 4th tab hung.
//
// The connection is API-09 with no ?branch: 1 tab can need more than 1 branch at once (the bell follows the top bar, the job page its job's
// branch, System health the caller's own), so a ?branch connection could not serve them. Each subscription names its branch and is filtered
// here, by the rule the server's bus uses (an event with no branch id goes to every branch). A branch change therefore never touches the
// connection, and no connection is ever opened for a branch the top bar then leaves. Who may see what stays the server's: the role filter
// and the access check run on the 1 connection as they did on many.
import { servedPath } from './contract.ts';
import { eventStreamRow } from './contracts/demo.ts';
import { connectEventStream, type EventStreamHandle, type EventStreamOptions, type StreamEvent, type StreamState } from './event-stream.ts';

export interface EventSubscription {
  /** Only this branch's events (and the events of no branch). Left out: every branch's. */
  branch?: string;
  onEvent: (e: StreamEvent) => void;
  /** After the connection is open again following a loss: the subscriber re-reads in full. */
  onReconnect?: () => void;
  /** The connection's state. A subscriber that joins an open connection hears its state at once. */
  onState?: (s: StreamState) => void;
}

export interface EventHub {
  subscribe(sub: EventSubscription): EventStreamHandle;
}

/** Does this subscription's branch take this event? The rule of PgNotifyBus.#deliver, on the page's side of the 1 connection. */
export function takesEvent(branch: string | undefined, e: StreamEvent): boolean {
  const own = e.ids['branch'];
  return branch === undefined || own === undefined || String(own) === branch;
}

/**
 * A hub on 1 URL. The connection opens with the first subscription and closes when the last has gone; the close waits a tick, because a
 * re-render's cleanup and its next effect run back to back and must not cost a new connection. A connection the server refused ('closed',
 * a 401 or 403) stays closed while anyone is subscribed, so the next screen's subscription does not send a 2nd refused request.
 */
export function createEventHub(opts: { url: () => string; connect?: (o: EventStreamOptions) => EventStreamHandle }): EventHub {
  const connect = opts.connect ?? connectEventStream;
  const subs = new Set<EventSubscription>();
  let link: EventStreamHandle | null = null;
  let state: StreamState = 'connecting';
  let closing: ReturnType<typeof setTimeout> | null = null;

  /** One subscriber's failure never reaches another. */
  const each = (call: (s: EventSubscription) => void): void => {
    for (const s of [...subs]) {
      try {
        call(s);
      } catch {
        // as PgNotifyBus: the next subscriber still hears it
      }
    }
  };
  const open = (): void => {
    state = 'connecting';
    link = connect({
      url: opts.url(),
      onEvent: (e) => each((s) => {
        if (takesEvent(s.branch, e)) s.onEvent(e);
      }),
      onReconnect: () => each((s) => s.onReconnect?.()),
      onState: (next) => {
        state = next;
        each((s) => s.onState?.(next));
      },
    });
  };
  const closeNow = (): void => {
    closing = null;
    if (subs.size > 0) return;
    const was = link;
    link = null;
    was?.close();
  };

  return {
    subscribe(sub) {
      if (closing !== null) clearTimeout(closing);
      closing = null;
      subs.add(sub);
      if (link === null) open();
      else if (state !== 'connecting') sub.onState?.(state);
      let gone = false;
      return {
        close() {
          if (gone) return;
          gone = true;
          subs.delete(sub);
          sub.onState?.('closed');
          if (subs.size === 0) closing = setTimeout(closeNow, 0);
        },
        get state() {
          return gone ? 'closed' : state;
        },
      };
    },
  };
}

let tabHub: EventHub | null = null;

/** Subscribe through this tab's 1 event connection. A module of the page's bundle is 1 per tab; page code never opens a stream itself. */
export function subscribeEvents(sub: EventSubscription): EventStreamHandle {
  tabHub ??= createEventHub({ url: () => servedPath(eventStreamRow) });
  return tabHub.subscribe(sub);
}
