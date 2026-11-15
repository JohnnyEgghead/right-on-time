// SPDX-License-Identifier: AGPL-3.0-or-later
// Whose reads run (F-1069): the Map, Parts and Me reads belong to the session, not to a screen. They start with the person's session and stop the
// moment it ends (sign-out, or a 401), whichever screen is showing, and the copies they kept go with it.
import type { MapMeReads } from './reads.ts';

export interface FollowedSession {
  userId: string;
  token: string;
  origin: string;
}

export interface LifecycleDeps {
  /** The reads for this person (their client carries their token). */
  make(session: FollowedSession): MapMeReads;
  /** The app coming back to the foreground; returns the way to stop listening. */
  onForeground(fn: () => void): () => void;
  /** The 60 s timer; returns the way to stop it. */
  every(fn: () => void, ms: number): () => void;
  /** Every copy the reads kept on the phone goes. */
  forget(): void;
  /** A 401 on a read: the server ended this session, so the app's session ends too. */
  endSession(): void;
  everyMs: number;
}

export class MapMeLifecycle {
  private current: { user: string; token: string; reads: MapMeReads; off: () => void } | null = null;

  constructor(private readonly deps: LifecycleDeps) {}

  /** The reads for the session now held (null: signed out). Called at every change of the app's session, and by each screen. */
  follow(session: FollowedSession | null): MapMeReads | null {
    if (!session) {
      this.end(true);
      return null;
    }
    if (this.current && this.current.user === session.userId && this.current.token === session.token) return this.current.reads;
    this.end(false);
    const made = this.deps.make(session);
    const kick = () => void made.refresh();
    const offFg = this.deps.onForeground(kick);
    const offTimer = this.deps.every(kick, this.deps.everyMs);
    // A 401 (the reads' signedOut flag) ends the session at once: the copies of that person go, then the app's session.
    const offSub = made.subscribe(() => {
      if (made.snapshot.signedOut && this.current?.reads === made) {
        this.end(true);
        this.deps.endSession();
      }
    });
    this.current = { user: session.userId, token: session.token, reads: made, off: () => { offFg(); offTimer(); offSub(); } };
    kick();
    return made;
  }

  /** Stops the reads (no more calls, no round saves after this); with `forget`, the copies the person kept go as well. */
  private end(forget: boolean): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    c.off();
    c.reads.stop();
    if (forget) this.deps.forget();
  }
}
