// SPDX-License-Identifier: AGPL-3.0-or-later
// The street field's search (API-111, CTL-CUS-01-04; K-08.15): after 2 characters, debounced, the text in the body and never the URL. The
// field shows the answer to its newest text only. Every change of the text makes an answer still waiting stale, the change to fewer than 2
// characters too, so typing and then clearing before the answer lands leaves the field idle. It is createLatest (search-latest.ts, the
// top-bar search's guard, F-229), so the booking page shares 1 mechanism with the office's searches. No React.
import { createLatest } from '../shell/search-latest.ts';
import type { BookingApi } from './api.ts';
import type { StreetState } from './BookingView.tsx';

export interface StreetSearch {
  /** The field's text changed: show idle under 2 characters, else ask after the debounce. Returns the cancel of the debounce timer. */
  typed(text: string): () => void;
  /** A street was picked or the page left: an answer still waiting is dropped. */
  stop(): void;
}

export function createStreetSearch(streets: BookingApi['streets'], show: (s: StreetState) => void, debounceMs: number): StreetSearch {
  const latest = createLatest();
  return {
    typed(text) {
      latest.invalidate();
      const q = text.trim();
      if (q.length < 2) {
        show({ kind: 'idle' });
        return () => undefined;
      }
      const id = setTimeout(() => {
        show({ kind: 'loading' });
        void latest.run(() => streets(q), (r) => show(!r.ok ? { kind: 'error' } : r.data.streets.length === 0 ? { kind: 'none' } : { kind: 'results', streets: r.data.streets }));
      }, debounceMs);
      return () => clearTimeout(id);
    },
    stop() {
      latest.invalidate();
    },
  };
}
