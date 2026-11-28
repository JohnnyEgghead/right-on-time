// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// CMP-01 demo clock (CTL-CMP-01-01, CTL-CMP-01-02) and CMP-02 clock banner (CTL-CMP-02-01 to CTL-CMP-02-03): the kit's
// demo strip (DK-24, markup DK-77 / DK-80). FR-DEMO-1: every web surface shows it in its header.
// Reads API-10 on mount, on window focus, every READ_EVERY_MS (GAP-7: pages without the event stream) and on EVT-05 and EVT-06, and advances
// the shown time from API-10's anchor by the monotonic time since the read (FR-DEMO-2: never the device clock's now).
import { subscribeEvents } from '@bw/api';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { advance, bannerLine, clockText, moveKey, shortText, toView, type ClockAnswer, type ClockView } from './clock.ts';
import { Icon } from './Icon.tsx';
import { useT } from './intl.tsx';
import { useNewestAnswer } from './newest-answer.ts';
import { createReader, type Reader } from './reads.ts';
import { useWorldReset } from './world-reset.tsx';

export const READ_EVERY_MS = 60_000;
const TICK_MS = 1_000;

export interface DemoStripProps {
  /** A first read already made (server-rendered page data, or a preview state). Absent: the strip reads API-10 itself. */
  initial?: ClockAnswer | null;
  /** CTL-CMP-01-02: managers on SURF-OFC only (hidden on SURF-PBS, D5a-2). */
  changeHref?: string | null;
  /** "phone": the technician web app and the customer phone pages (DK-24 .ph). */
  variant?: 'desktop' | 'phone' | 'header';
  /** "header" only: the app has no signal; the clock says so (DK-107 .r1p-clk .ns). */
  offline?: boolean;
  /** The demo time the world was reset to, shown after a world reset event (CTL-CMP-02-03, EVT-06). */
  resetTo?: string | null;
  /** Tests and previews: a reader other than the page's own origin; false: never read (a fixed preview state). */
  reader?: Reader | false;
  /** A signed-in page: EVT-06 reaches it at once through the tab's event connection. Any other page finds a reset at its next read. */
  live?: boolean;
}

const now = () => performance.now();

export function DemoStrip({ initial = null, changeHref = null, variant = 'desktop', offline = false, resetTo, reader, live = false }: DemoStripProps) {
  const t = useT();
  const { notice, observe } = useWorldReset();
  const [view, setView] = useState<ClockView | null>(initial ? toView(initial) : null);
  const [stale, setStale] = useState(false);
  const [caughtUp, setCaughtUp] = useState(false);
  const readAt = useRef<number | null>(null);
  const [, setTick] = useState(0);
  const wasReplaying = useRef(Boolean(initial?.replay?.running));

  const newest = useNewestAnswer();
  const read = useCallback(async () => {
    if (reader === false) return;
    const r = reader ?? createReader({ baseUrl: window.location.origin });
    // K-05: the timer, a focus and an event each read; the newest read's answer is the one shown, however late an earlier one lands.
    await newest.run(() => r.read<ClockAnswer>('API-10'), (res) => {
      if (!res.ok) {
        setStale(true);
        return;
      }
      readAt.current = now();
      observe(res.data);
      const v = toView(res.data);
      // "Caught up" shows for 1 refresh after a replay ends (CTL-CMP-02-02).
      setCaughtUp(wasReplaying.current && !v.answer.replay?.running);
      wasReplaying.current = Boolean(v.answer.replay?.running);
      setView(v);
      setStale(false);
    });
  }, [reader, observe, newest]);

  useEffect(() => {
    if (initial) readAt.current = now();
    void read();
    const every = window.setInterval(() => void read(), READ_EVERY_MS);
    const onFocus = () => void read();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(every);
      window.removeEventListener('focus', onFocus);
    };
    // initial is a first read only; later reads replace it, so it is not a dependency.
  }, [read]);

  useEffect(() => {
    if (!live || reader !== undefined) return;
    const handle = subscribeEvents({
      onEvent: (e) => {
        if (e.name === 'world.reset' || e.name === 'clock.changed') void read(); // K-04: a move of the clock changes the strip too
      },
      onReconnect: () => void read(), // an EVT-05 or EVT-06 missed while the stream was lost is never replayed
    });
    return () => handle.close();
  }, [live, reader, read]);

  const paused = view?.answer.paused ?? false;
  useEffect(() => {
    if (!view || paused || reader === false) return;
    const tick = window.setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => window.clearInterval(tick);
  }, [view, paused, reader]);

  const at = view ? advance(view, readAt.current === null || reader === false ? 0 : now() - readAt.current) : null;

  let line: ReactNode = null;
  let lineCtl = 'CTL-CMP-02-01';
  const resetAt = resetTo === undefined ? notice?.to : resetTo; // the clock page's own null: its new move replaced the notice
  if (resetAt && view) {
    const reset = toView({ ...view.answer, demoNow: resetAt });
    line = t('shell.clock.worldReset', { when: shortText(reset.at, reset.zone, t.lang, t) });
    lineCtl = 'CTL-CMP-02-03';
  } else if (stale) {
    line = t('shell.clock.notUpdated');
    lineCtl = 'CTL-CMP-01-01';
  } else if (view) {
    const kind = bannerLine(view.answer);
    if (kind === 'replay' && view.answer.replay) {
      line = t('shell.clock.catchingUp', { done: view.answer.replay.done, total: view.answer.replay.total });
      lineCtl = 'CTL-CMP-02-02';
    } else if (caughtUp) {
      line = t('shell.clock.caughtUp');
      lineCtl = 'CTL-CMP-02-02';
    } else if (kind === 'move' && view.answer.lastMove) {
      const move = view.answer.lastMove;
      const to = toView({ ...view.answer, demoNow: move.toDemo });
      const person = move.by !== 'nightly' && move.by !== 'idle';
      line = t.rich(moveKey(move), {
        name: move.by,
        when: shortText(to.at, to.zone, t.lang, t),
        b: (chunks) => (person ? <b translate="no">{chunks}</b> : <b>{chunks}</b>),
      });
    }
  }

  // F-938: the technician app's Today draws the clock inside its header (DK-107 .clkrow .r1p-clk), not as a strip above it.
  if (variant === 'header') {
    return (
      <div className="r1p-clk" data-cmp="CMP-01" data-ctl="CTL-CMP-01-01">
        <Icon name="clock" />
        <span>{t('shell.clock.label')}</span> <b data-demo-time="">{at && view ? clockText(at, view.zone, t.lang, t) : null}</b>
        {offline ? <> <span className="ns">{t('tech.today.noSignalParen')}</span></> : null}
      </div>
    );
  }

  return (
    <div className={variant === 'phone' ? 'r1-demobar ph' : 'r1-demobar'} data-cmp="CMP-01">
      <span className="clk" data-ctl="CTL-CMP-01-01">
        <Icon name="clock" />
        <span className="lbl">{t('shell.clock.label')}</span>
        <b data-demo-time="">{at && view ? clockText(at, view.zone, t.lang, t) : null}</b>
      </span>
      {view ? <span className={paused ? 'run paused' : 'run'}>{t(paused ? 'status.clock.paused' : 'status.clock.running')}</span> : null}
      {changeHref ? (
        <a href={changeHref} data-ctl="CTL-CMP-01-02">
          {t('shell.clock.change')}
        </a>
      ) : null}
      {line ? (
        <span className="moved" data-ctl={lineCtl} role="status">
          {line}
        </span>
      ) : null}
    </div>
  );
}
