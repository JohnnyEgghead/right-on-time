// SPDX-License-Identifier: AGPL-3.0-or-later
// The bell's record of the alerts it has seen, and the CMP-11 "New alert" decision (UI-SPECIFICATION SCR-OFC-28, state New alert).
// F-1809: 1 alert check transaction can publish alert.created and alert.dismissed together, and each starts a re-read of API-43. The
// reads are not ordered, and the first to land takes the diff. So the announcement is not decided by the read that EVT-04 alert.created
// started: while that read is out, whichever read lands with a new alert announces it, once.

export interface BellLanding<A> {
  /** The newest alert this read added to the seen set, or undefined. */
  added: A | undefined;
  /** True when CMP-11 should announce `added`. */
  announce: boolean;
  /**
   * F-1812: this read is out of date: it began in another world or branch, or an older read than 1 that already landed. The list it
   * brought must not be drawn (a slow answer for the world left, or one older than what the panel shows, would replace the newer list).
   */
  stale: boolean;
}

export interface BellSeen<A extends { id: string }> {
  /** A fresh world or branch: nothing is seen, so the next landing records without a diff, and no announcement is owed. */
  reset(): void;
  /**
   * One re-read begins. `announcing`: EVT-04 alert.created started it. Call the returned step once, when the read lands, with its list,
   * or with null when it failed.
   */
  begin(announcing: boolean): (next: A[] | null) => BellLanding<A>;
}

export function createBellSeen<A extends { id: string }>(): BellSeen<A> {
  let known: Set<string> | null = null;
  // The alert.created reads begun in this world and not landed yet: while any is out, a new alert is owed its announcement.
  let owed = 0;
  let world = 0;
  // F-1812: the order reads began in, and the order of the newest read applied.
  let begun = 0;
  let applied = 0;
  return {
    reset() {
      known = null;
      owed = 0;
      applied = 0;
      world += 1;
    },
    begin(announcing) {
      const at = world;
      const order = (begun += 1);
      if (announcing) owed += 1;
      let landed = false;
      return (next) => {
        const none: BellLanding<A> = { added: undefined, announce: false, stale: false };
        if (landed) return none;
        landed = true;
        const mine = announcing && at === world;
        const want = announcing || owed > 0;
        if (mine) owed -= 1;
        if (next === null) return none;
        if (at !== world || order < applied) return { ...none, stale: true };
        applied = order;
        const seen = known;
        known = new Set(next.map((a) => a.id));
        const added = seen === null ? undefined : next.find((a) => !seen.has(a.id));
        if (added === undefined) return none;
        // A later landing of the alert.created read sees this alert as seen, so it is announced once.
        return { added, announce: want, stale: false };
      };
    },
  };
}
