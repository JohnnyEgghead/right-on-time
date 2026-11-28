// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The in-flight guard (K-01, F-2011): 1 write per press. A button's write takes the guard when it starts and a second press while it is
// held does nothing, so 2 quick clicks (or a click and Enter) send 1 request. The guard is held in a ref, not read from React state: a
// press can reach a handler made by an older render (2 calls through 1 closure), and a state value read there is still the old one.
//
// Who ends it is the caller's: a write that moves the page on success (the booking's SCR-CUS-03) ends it only on its failure paths, so the
// button stays busy until the page moves; a write that stays on the page ends it when its answer lands, whatever the answer.
import { useRef, useState } from 'react';

export interface InFlight {
  /** Take the guard: true when it was free (go on and send), false when a write is already in flight (do nothing). */
  begin(): boolean;
  /** Let the guard go: the next press may send. */
  end(): void;
  /** Whether a write holds it now. */
  readonly held: boolean;
}

/** The guard alone, with `changed` told each time it is taken or let go. No React. */
export function createInFlight(changed: (held: boolean) => void = () => undefined): InFlight {
  let held = false;
  return {
    begin() {
      if (held) return false;
      held = true;
      changed(true);
      return true;
    },
    end() {
      if (!held) return;
      held = false;
      changed(false);
    },
    get held() {
      return held;
    },
  };
}

/**
 * One in-flight guard for one write of one screen: `busy` for the button's disabled and busy look, `begin` and `end` as
 * {@link createInFlight}. `begin` and `end` are the same functions on every render.
 */
export function useInFlight(): { busy: boolean; begin: () => boolean; end: () => void } {
  const [busy, setBusy] = useState(false);
  const core = useRef<InFlight | null>(null);
  core.current ??= createInFlight(setBusy);
  const guard = core.current;
  return { busy, begin: guard.begin, end: guard.end };
}

/**
 * The guard for a row of like buttons (F-2077, F-2079): 1 guard per key, so a press is dropped only while that same row's write is out and a press
 * on another row goes on. `changed` is told the keys held after each begin or end. No React.
 */
export interface KeyedInFlight {
  begin(key: string): boolean;
  end(key: string): void;
  held(key: string): boolean;
}
export function createKeyedInFlight(changed: (keys: readonly string[]) => void = () => undefined): KeyedInFlight {
  const keys = new Set<string>();
  return {
    begin(key) {
      if (keys.has(key)) return false;
      keys.add(key);
      changed([...keys]);
      return true;
    },
    end(key) {
      if (keys.delete(key)) changed([...keys]);
    },
    held: (key) => keys.has(key),
  };
}

/** {@link createKeyedInFlight} for one screen: `busy` lists the held keys for the buttons' busy look; `begin` and `end` are the same functions on every render. */
export function useKeyedInFlight(): { busy: readonly string[]; begin: (key: string) => boolean; end: (key: string) => void } {
  const [busy, setBusy] = useState<readonly string[]>([]);
  const core = useRef<KeyedInFlight | null>(null);
  core.current ??= createKeyedInFlight(setBusy);
  const guard = core.current;
  return { busy, begin: guard.begin, end: guard.end };
}
