// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The demo clock as a page follows it (F-1930, UD-18): the 1 way for every page that shows the demo clock's now or its today. The time is
// read when the page opens and whenever the page asks (readClock), and advances between reads from the answer it got (FR-DEMO-2: never the
// device clock's now). A read that fails keeps the time the page holds, and of 2 reads on their way the later one wins.
// A page re-reads on EVT-05 clock.changed, on EVT-06 world.reset and when its stream comes back, because a clock event missed while the stream
// was lost is never sent again; its clock first, then its list, so the list is asked for the day the clock is on.
import type { Instant } from '@bw/time';
import { useCallback, useEffect, useRef, useState } from 'react';
import { advance, toView, type ClockAnswer, type ClockView } from './clock.ts';
import { createReader } from './reads.ts';

/** A moment of the demo clock and how it runs on from there (a ClockView is one). */
export type DemoTime = Pick<ClockView, 'at'> & { answer: Pick<ClockAnswer, 'paused' | 'rate'> };
/** Reads the demo time now; null when it is not known. Hold it outside the component: a new function is a new clock. */
export type DemoSource<T extends DemoTime> = () => Promise<T | null>;

const TICK_MS = 30_000;

/** API-10, the demo clock of the office pages. */
export const officeClock: DemoSource<ClockView> = async () => {
  const r = await createReader({ baseUrl: window.location.origin }).read<ClockAnswer>('API-10');
  return r.ok ? toView(r.data) : null;
};

/** The date of a moment in a zone, "2026-09-15". */
export const dayIn = (at: Instant, zone: string): string => at.toZonedDateTimeISO(zone).toPlainDate().toString();

interface Held<T> { time: T; readAt: number | null }

/** The demo time of a page. `source` null reads nothing (a preview: `given` is the time it shows, which does not run). */
export function useDemoClock<T extends DemoTime>(source: DemoSource<T> | null, given: T | null = null) {
  const [held, setHeld] = useState<Held<T> | null>(given ? { time: given, readAt: null } : null);
  const [failed, setFailed] = useState(false);
  const [ticks, setTicks] = useState(0);
  const latest = useRef(held);
  const asked = useRef(0);
  const landed = useRef(0);
  /** Reads the clock; resolves with the time in force after it: the answer's, or the last one the page has when the read failed. */
  const readClock = useCallback(async (): Promise<T | null> => {
    if (!source) return latest.current?.time ?? null;
    asked.current += 1;
    const n = asked.current;
    const time = await source().catch(() => null);
    if (time && n > landed.current) {
      landed.current = n;
      latest.current = { time, readAt: performance.now() };
      setHeld(latest.current);
    }
    setFailed(time === null);
    return latest.current?.time ?? null;
  }, [source]);
  useEffect(() => {
    void readClock();
    if (!source) return;
    const h = window.setInterval(() => setTicks((n) => n + 1), TICK_MS);
    return () => window.clearInterval(h);
  }, [source, readClock]);
  const now = held ? advance(held.time, held.readAt === null ? 0 : performance.now() - held.readAt) : null;
  return { time: held?.time ?? null, now, ticks, failed, readClock };
}

/**
 * The demo clock's today as the clock last answered it. When the time the page runs on from that answer is on another day, the clock is asked
 * again (at most once each tick), so midnight moves the page and a clock that was paused does not.
 */
export function useDemoDay(source: DemoSource<ClockView>) {
  const { time, now, ticks, failed, readClock } = useDemoClock(source);
  const day = time ? dayIn(time.at, time.zone) : null;
  const ahead = time !== null && now !== null && dayIn(now, time.zone) !== day;
  useEffect(() => {
    if (ahead) void readClock();
  }, [ahead, ticks, readClock]);
  /** Reads the clock; resolves with the demo day after it, null when none is known. */
  const readDay = useCallback(async (): Promise<string | null> => {
    const t = await readClock();
    return t ? dayIn(t.at, t.zone) : null;
  }, [readClock]);
  return { day, failed, readDay };
}

/** What a page's live updates need to follow the demo day: whether it does (its URL names no date), the day it shows, and the clock read. */
export interface FollowedDay {
  following: boolean;
  day: string | null;
  readDay: () => Promise<string | null>;
}

/** Reads the clock first; true when the followed day moved, so the page's read of the new day is the read to make. */
export async function dayMoved(f: FollowedDay): Promise<boolean> {
  const was = f.day;
  return (await f.readDay()) !== was && f.following;
}
