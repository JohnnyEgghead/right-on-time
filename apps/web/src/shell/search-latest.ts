// SPDX-License-Identifier: AGPL-3.0-or-later
// The top-bar search shows the answer to the newest query only (F-229): a slow answer to an earlier query that lands
// after a newer query began is dropped, never shown. Each search takes a number when it starts; typing, clearing the box
// or starting another search makes every earlier number stale.
export interface Latest {
  /** Run `read`; hand its answer to `apply` only if no newer search or invalidation began meanwhile. True when applied. */
  run<T>(read: () => Promise<T>, apply: (answer: T) => void): Promise<boolean>;
  /** Make every search still waiting stale (the query changed, or the box was cleared). */
  invalidate(): void;
}

export function createLatest(): Latest {
  let current = 0;
  return {
    async run(read, apply) {
      const mine = ++current;
      const answer = await read();
      if (mine !== current) return false;
      apply(answer);
      return true;
    },
    invalidate() {
      current++;
    },
  };
}
