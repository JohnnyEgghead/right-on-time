// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-02's timeline (DK-16, DK-17, DK-74 timeline.js): the hours header, the Unassigned row (CTL-OFC-02-10), 1 row per
// technician (CTL-OFC-02-08) with its job blocks (CTL-OFC-02-09) and time blocks (CTL-OFC-02-33), the off-hours shading
// (CTL-OFC-02-34) and the now line (CTL-OFC-02-11). Drag (pointer events) reassigns a job or moves a block: while a job is
// dragged over a row, that row shows the drop target and the move preview (CTL-OFC-02-21; FR-DISP-17), released outside
// any row nothing is moved. The keyboard and single-pointer ways are the popovers' Reassign and Change (UD-7, UD-47).
// Positions are set through the style property after the board is read in the browser; the page's CSP (SPECIFICATIONS
// 11.5) allows no style attribute in the served HTML, so the lanes render only once mounted.
import type { MessageKey } from '@bw/i18n';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useT } from '../shell/intl.tsx';
import {
  DAY_SPAN, daySpan, draggable, hourAt, hourLabel, hourOf, jobClass, jobHours, pct, place, spanText, statusKey, timeText, timingKey, windowText,
  type Board, type BoardBlock, type BoardJob, type BoardTech, type Span, type Target,
} from './model.ts';

/** The preview a job drag shows over a technician's row (API-131), or its failure. */
export type DragPreview = { state: 'loading' } | { state: 'failed' } | { state: 'ok'; arrivesAbout: string | null; insideWindow: boolean | null };

/** A drag in progress, as the timeline draws it. */
export type Drag =
  | { kind: 'job'; job: BoardJob; target: Target; preview: DragPreview | null }
  | { kind: 'block'; block: BoardBlock; from: string; target: Target; startHour: number };

export interface TimelineOptions {
  span?: Span;
  /** The row header width in px (DK-74 `who`): 190 on the board, 170 in the frames' small boards. */
  who?: number;
  rowH?: number;
  unassigned?: boolean;
  /** The demo time's hour on today's board (null on another day: no now line). */
  now?: number | null;
}

export interface TimelineProps extends TimelineOptions {
  /** The root's id: `tl` on the board (DK-85 #tl, the element the timeline renders into). */
  id?: string;
  board: Board;
  technicians?: readonly BoardTech[];
  /** Jobs that were dropped and wait for the server (job number -> the row they went to; null: the Unassigned row). */
  moving?: ReadonlyMap<number, string | null>;
  movingBlocks?: ReadonlyMap<string, { technicianId: string; start: string; end: string }>;
  /** Moves are paused (offline); blocks still open their popovers. */
  paused?: boolean;
  /** A fixed drag scene (the look comparator's Previewing and Moving frames). */
  scene?: Drag | null;
  noJobs?: boolean;
  onOpenJob?: (j: BoardJob, el: HTMLElement) => void;
  onOpenBlock?: (b: BoardBlock, technicianId: string, el: HTMLElement) => void;
  onPreview?: (j: BoardJob, technicianId: string | null) => Promise<DragPreview>;
  onDropJob?: (j: BoardJob, t: Target) => void;
  onDropBlock?: (b: BoardBlock, from: string, t: Target, startHour: number) => void;
}

const useMounted = () => {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
};

/** Sets left and width (percent) through the style property (allowed by the CSP, unlike a style attribute). */
function at(left: number, width: number) {
  return { left: `${left}%`, width: `${width}%` };
}

const ROW = 'data-row';
/** DK-70's check path (icon-paths.ts check). */
const CHECK_PATH = 'M5 12.5l4.5 4.5L19 7.5';
/**
 * The drag's own drawing is never what lies under the pointer: its tooltip sits 46 px up, over the row above its target, and takes
 * pointer hits (the page's sheet is DK-85's, never edited), so reading it put a drop on the row the tooltip belongs to (F-792).
 */
const DRAG_LAYER = '.dragtip, .dragging, .drop-target';
const targetAt = (x: number, y: number): Target => {
  for (const el of document.elementsFromPoint(x, y)) {
    if ((el as HTMLElement).closest?.(DRAG_LAYER)) continue;
    const r = (el as HTMLElement).closest?.(`[${ROW}]`);
    if (r) {
      const v = r.getAttribute(ROW) as string;
      return v === 'unassigned' ? { kind: 'unassigned' } : { kind: 'tech', id: v };
    }
  }
  return { kind: 'none' };
};
/** A press on a job or a block; `grab` is how far inside it the pointer went down. */
type Press = { x: number; y: number; started: boolean; grab: number; el: HTMLElement; d: Drag };
/** What a pointer event says here, from the button (React's event) or the window (the browser's). */
type PointerSpot = { clientX: number; clientY: number };

export function Timeline(p: TimelineProps) {
  const t = useT();
  const mounted = useMounted();
  // The hour range runs to the end of the day's latest job or block (FR-DISP-1): a day that runs past the 6 PM frame edge
  // stretches the grid and the region scrolls sideways, the technician column staying put (F-1540).
  const span = p.span ?? daySpan(p.board);
  const stretch = (span.end - span.start) / (DAY_SPAN.end - DAY_SPAN.start);
  const who = p.who ?? 190;
  const rowH = p.rowH ?? 50;
  const techs = p.technicians ?? p.board.technicians;
  const [live, setLive] = useState<Drag | null>(null);
  const drag = p.scene ?? live;
  const press = useRef<Press | null>(null);
  const suppressClick = useRef(false);
  const previewFor = useRef<string>('');

  // Escape cancels a drag (no move is made).
  useEffect(() => {
    if (!live) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        press.current = null;
        setLive(null);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [live]);

  const askPreview = (j: BoardJob, target: Target) => {
    if (target.kind !== 'tech' || target.id === j.technicianId || !p.onPreview) return;
    const key = `${j.jobNumber}:${target.id}`;
    previewFor.current = key;
    void p.onPreview(j, target.id).then((pv) => {
      if (previewFor.current !== key) return;
      setLive((d) => (d && d.kind === 'job' && d.target.kind === 'tech' && d.target.id === target.id ? { ...d, preview: pv } : d));
    });
  };

  const down = (e: ReactPointerEvent<HTMLElement>, d: Drag) => {
    if (p.paused || e.button !== 0) return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    press.current = { x: e.clientX, y: e.clientY, started: false, grab: e.clientX - r.left, el, d };
    el.setPointerCapture?.(e.pointerId);
  };
  /** The hour a dragged block starts at with the pointer at x over the target row; off every row it keeps its own start. */
  const blockHour = (s: Press, block: BoardBlock, target: Target, x: number) => {
    const lane = target.kind === 'tech' ? document.querySelector(`[${ROW}="${target.id}"] .lane`) : null;
    const lr = lane?.getBoundingClientRect();
    return lr ? hourAt(x - s.grab, lr.left, lr.width, span) : hourOf(block.start);
  };
  const move = (e: PointerSpot) => {
    const s = press.current;
    if (!s) return;
    if (!s.started && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 5) return;
    s.started = true;
    const target = targetAt(e.clientX, e.clientY);
    if (s.d.kind === 'job') {
      const j = s.d.job;
      setLive((cur) => {
        const same = cur && cur.kind === 'job' && JSON.stringify(cur.target) === JSON.stringify(target);
        if (same) return cur;
        const preview: DragPreview | null = target.kind === 'tech' && target.id !== j.technicianId ? { state: 'loading' } : null;
        askPreview(j, target);
        return { kind: 'job', job: j, target, preview };
      });
    } else {
      setLive({ kind: 'block', block: s.d.block, from: s.d.from, target, startHour: blockHour(s, s.d.block, target, e.clientX) });
    }
  };
  const up = (e: PointerSpot) => {
    const s = press.current;
    press.current = null;
    if (!s?.started) return;
    // The click a browser may send after a drag's release is not a press of the block (WebKit sends none, so the
    // flag clears on the next turn instead of eating the next real click).
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    setLive(null);
    previewFor.current = '';
    // A drop lands where the pointer was released, read from this event. `live` is what was last drawn, and a release can
    // beat the last move's draw by a few ms, so reading it put a job on the row above or a block 5 to 35 minutes off (F-792).
    const target = targetAt(e.clientX, e.clientY);
    if (s.d.kind === 'job') p.onDropJob?.(s.d.job, target);
    else p.onDropBlock?.(s.d.block, s.d.from, target, blockHour(s, s.d.block, target, e.clientX));
  };
  // The pressed button can leave the page during its own drag: another person's move redraws it on another row, and the button
  // handlers go with it. The window hears the pointer then, so the release still goes out and answers with who moved it
  // (FR-DISP-6, UD-6), and no drag stays on screen (F-792). While the button is on the page it hears everything itself.
  useEffect(() => {
    if (!live) return;
    const orphaned = (fn: (e: PointerEvent) => void) => (e: PointerEvent) => {
      if (press.current && !press.current.el.isConnected) fn(e);
    };
    const moved = orphaned(move);
    const released = orphaned(up);
    window.addEventListener('pointermove', moved);
    window.addEventListener('pointerup', released);
    return () => {
      window.removeEventListener('pointermove', moved);
      window.removeEventListener('pointerup', released);
    };
  });
  const click = (fn: () => void) => () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    fn();
  };

  const hours: ReactNode[] = [];
  for (let h = span.start; h < span.end; h++) {
    hours.push(
      <span key={h} className={h === span.start ? 'first' : ''} ref={(el) => { if (el) el.style.left = `${pct(h, span)}%`; }}>
        {hourLabel(h)}
      </span>,
    );
  }

  const off = (() => {
    const s = hourOf(p.board.workingHours.start);
    const e = hourOf(p.board.workingHours.end);
    return [place(span.start, s, span), place(e, span.end, span)];
  })();

  const jobButton = (j: BoardJob, rowTech: string | null) => {
    const cls = jobClass(j);
    const { start, end } = jobHours(j);
    const pos = place(Math.max(start, span.start), Math.min(end, span.end), span);
    const service = t(j.serviceLabelKey as MessageKey);
    const eta = j.eta ? timeText(j.eta) : '';
    const win = windowText(j.window.start, j.window.end);
    const tag = timingKey(j);
    const l2 = cls === 'done' ? t(j.status === 'no_one_home' ? 'board.job.noOneHome' : 'board.job.done', { service })
      : cls === 'site' ? t('board.job.site', { service })
        : cls === 'way' ? t('board.job.way', { eta })
          : cls === 'risk' || cls === 'late' ? t('board.job.timed', { eta, window: win })
            : cls === 'unas' ? `${service} - ${j.area}` : service;
    const isMoving = p.moving?.has(j.jobNumber) === true;
    const canDrag = draggable(j) && !p.paused && !isMoving;
    const sr = t('board.job.sr', { job: j.jobNumber, area: j.area, window: win, status: t(statusKey(j)), timing: tag ? t(tag) : 'none' });
    return (
      <button
        key={`j${j.jobNumber}`}
        type="button"
        className={`bw-btn-reset job ${cls}`}
        data-ctl="CTL-OFC-02-09"
        data-job={j.jobNumber}
        data-row-of={rowTech ?? 'unassigned'}
        aria-busy={isMoving || undefined}
        aria-describedby={`jd${j.jobNumber}`}
        ref={(el) => { if (el) Object.assign(el.style, at(pos.left, pos.width)); }}
        onPointerDown={canDrag ? (e) => down(e, { kind: 'job', job: j, target: { kind: 'none' }, preview: null }) : undefined}
        onPointerMove={canDrag ? move : undefined}
        onPointerUp={canDrag ? up : undefined}
        onClick={(e) => {
          const el = e.currentTarget;
          click(() => p.onOpenJob?.(j, el))();
        }}
      >
        <div className="l1">
          {cls === 'done' && j.status === 'done' ? <CheckMark /> : null}
          {tag && (cls === 'risk' || cls === 'late') ? <span className="tag">{t(tag)}</span> : null}
          {j.customerName}
        </div>
        <div className="l2">{isMoving ? t('board.job.moving') : l2}</div>
        {/* The name is the visible words (WCAG 2.5.3); the job number, status word, timing word and window are its description. */}
        <span id={`jd${j.jobNumber}`} hidden>{sr}</span>
      </button>
    );
  };

  const blockButton = (b: BoardBlock, tech: string) => {
    const m = p.movingBlocks?.get(b.blockId);
    const pos = place(hourOf(m?.start ?? b.start), hourOf(m?.end ?? b.end), span);
    return (
      <button
        key={`b${b.blockId}`}
        type="button"
        className="bw-btn-reset job task"
        data-ctl="CTL-OFC-02-33"
        data-block={b.blockId}
        aria-busy={m ? true : undefined}
        aria-describedby={`bd${b.blockId}`}
        ref={(el) => { if (el) Object.assign(el.style, at(pos.left, pos.width)); }}
        onPointerDown={p.paused || m ? undefined : (e) => down(e, { kind: 'block', block: b, from: tech, target: { kind: 'none' }, startHour: hourOf(b.start) })}
        onPointerMove={p.paused || m ? undefined : move}
        onPointerUp={p.paused || m ? undefined : up}
        onClick={(e) => {
          const el = e.currentTarget;
          click(() => p.onOpenBlock?.(b, tech, el))();
        }}
      >
        <div className="l1">{b.label}</div>
        <div className="l2">{m ? t('board.job.moving') : b.place ?? spanText(b.start, b.end)}</div>
        <span id={`bd${b.blockId}`} hidden>{spanText(b.start, b.end)}</span>
      </button>
    );
  };

  /** The drag layer of a row: the drop target, the dragged block at its preview time, and the move preview. */
  const dragLayer = (rowKey: string | null): ReactNode => {
    if (!drag) return null;
    const over = drag.target.kind === 'unassigned' ? null : drag.target.kind === 'tech' ? drag.target.id : undefined;
    if (over === undefined || over !== rowKey) return null;
    if (drag.kind === 'block') {
      const length = hourOf(drag.block.end) - hourOf(drag.block.start);
      const pos = place(drag.startHour, drag.startHour + length, span);
      return (
        <>
          <div className="drop-target" ref={(el) => { if (el) Object.assign(el.style, at(pos.left, pos.width)); }} />
          <div className="job task dragging" ref={(el) => { if (el) Object.assign(el.style, at(pos.left, pos.width)); }}>
            <div className="l1">{drag.block.label}</div>
          </div>
        </>
      );
    }
    const j = drag.job;
    const ok = drag.preview?.state === 'ok' ? drag.preview : null;
    const start = ok?.arrivesAbout ? hourOf(ok.arrivesAbout) : jobHours(j).start;
    const pos = place(start, start + j.expectedMinutes / 60, span);
    const ghost = place(start - 0.08, start + j.expectedMinutes / 60 + 0.08, span);
    const name = rowKey === null ? null : techs.find((x) => x.id === rowKey)?.name ?? '';
    const win = windowText(j.window.start, j.window.end);
    return (
      <>
        <div className="drop-target" ref={(el) => { if (el) Object.assign(el.style, at(ghost.left, ghost.width)); }} />
        <div className="job way dragging" aria-hidden="true" ref={(el) => { if (el) Object.assign(el.style, { ...at(pos.left, pos.width), background: '#fff', borderColor: '#2f6fe0', color: '#1745a8' }); }}>
          <div className="l1">{j.customerName}</div>
          <div className="l2">{ok?.arrivesAbout ? t('board.job.eta', { eta: timeText(ok.arrivesAbout) }) : j.eta ? t('board.job.eta', { eta: timeText(j.eta) }) : ''}</div>
        </div>
        <div className="dragtip" role="status" data-ctl="CTL-OFC-02-21" ref={(el) => { if (el) Object.assign(el.style, { left: `${pct(start + j.expectedMinutes / 60, span) + 1}%`, top: '-46px' }); }}>
          {name === null ? <b>{t('board.drag.toUnassigned')}</b> : (
            <>
              <b>{t('board.drag.to', { name })}</b>
              {drag.preview?.state === 'failed' ? (<><br />{t('board.drag.noPreview')}</>) : ok?.arrivesAbout ? (
                <>
                  {' - '}<span className="ok">{t('board.drag.arrives', { time: timeText(ok.arrivesAbout) })}</span><br />
                  {ok.insideWindow ? t('board.drag.onTime', { window: win }) : t('board.drag.late', { window: win })}
                </>
              ) : null}
            </>
          )}
        </div>
      </>
    );
  };

  const lane = (rowKey: string | null, jobs: readonly BoardJob[], blocks: readonly BoardBlock[], leftBehind: readonly BoardJob[]) => (
    <div className="lane">
      {mounted ? (
        <>
          {Array.from({ length: span.end - span.start - 1 }, (_, i) => span.start + 1 + i).map((h) => (
            <div key={`g${h}`} className="tl-grid" ref={(el) => { if (el) el.style.left = `${pct(h, span)}%`; }} />
          ))}
          <div className="tl-off" data-ctl="CTL-OFC-02-34" ref={(el) => { if (el) Object.assign(el.style, { left: '0', width: `${off[0]!.width}%` }); }} />
          <div className="tl-off" data-ctl="CTL-OFC-02-34" ref={(el) => { if (el) Object.assign(el.style, { left: `${off[1]!.left}%`, right: '0' }); }} />
          {p.noJobs ? <span className="nojobs">{t('board.noJobs')}</span> : null}
          {/* Jobs and blocks in time order, as DK-74 draws a row (and a screen reader reads it). */}
          {[
            ...jobs.map((j) => ({ at: jobHours(j).start, node: () => jobButton(j, rowKey) })),
            ...(rowKey ? blocks.map((b) => ({ at: hourOf(b.start), node: () => blockButton(b, rowKey) })) : []),
          ].sort((x, y) => x.at - y.at).map((x) => x.node())}
          {leftBehind.map((j) => {
            const { start, end } = jobHours(j);
            const pos = place(start, end, span);
            return <div key={`lb${j.jobNumber}`} className="left-behind" ref={(el) => { if (el) Object.assign(el.style, at(pos.left, pos.width)); }}>{t('board.job.moving')}</div>;
          })}
          {dragLayer(rowKey)}
        </>
      ) : null}
    </div>
  );

  // A job dropped and waiting for the server is drawn on the row it went to; the row it left shows "Moving...".
  const placed = (rowKey: string | null, all: readonly BoardJob[]) => {
    const here = all.filter((j) => !p.moving?.has(j.jobNumber) || p.moving.get(j.jobNumber) === rowKey);
    const arriving = [...(p.moving ?? new Map<number, string | null>())]
      .filter(([n, to]) => to === rowKey && !all.some((j) => j.jobNumber === n))
      .map(([n]) => [...p.board.unassigned, ...p.board.technicians.flatMap((x) => x.jobs)].find((j) => j.jobNumber === n))
      .filter((j): j is BoardJob => j !== undefined);
    const left = all.filter((j) => p.moving?.has(j.jobNumber) && p.moving.get(j.jobNumber) !== rowKey);
    return { jobs: [...here, ...arriving], left };
  };
  // A block dropped and waiting for the server is drawn on the row it went to.
  const allBlocks = p.board.technicians.flatMap((x) => x.blocks.map((b) => ({ b, on: x.id })));
  const blocksOn = (techId: string) => allBlocks.filter(({ b, on }) => (p.movingBlocks?.get(b.blockId)?.technicianId ?? on) === techId).map(({ b }) => b);

  const ua = placed(null, p.board.unassigned);
  return (
    <div id={p.id} className="tl" role="region" aria-label={t('board.timeline', { date: p.board.date })}>
      <div className="tl-in" ref={(el) => { if (el) el.style.width = stretch > 1 ? `calc(${who}px + (100% - ${who}px) * ${stretch.toFixed(5)})` : ''; }}>
      <div className="tl-head">
        <div className="corner" ref={(el) => { if (el) el.style.width = `${who}px`; }}>{t('board.corner')}</div>
        <div className="tl-hours">{mounted ? hours : null}</div>
      </div>
      {p.unassigned === false ? null : (
        <div className="tl-row unas" data-ctl="CTL-OFC-02-10" {...{ [ROW]: 'unassigned' }} ref={(el) => { if (el) el.style.height = `${rowH}px`; }}>
          <div className="who" ref={(el) => { if (el) el.style.width = `${who}px`; }}>
            <span className="av">{ua.jobs.length}</span>
            <div>
              <div className="nm">{t('board.unassignedRow')}</div>
              <div className="sub">{t('board.unassignedHint')}</div>
            </div>
          </div>
          {lane(null, ua.jobs, [], ua.left)}
        </div>
      )}
      {techs.map((x) => {
        const r = placed(x.id, x.jobs);
        const [skill = '', ...moreSkills] = x.skills.map((s) => t(`skill.${s}` as MessageKey));
        return (
          <div key={x.id} className="tl-row" {...{ [ROW]: x.id }} ref={(el) => { if (el) el.style.height = `${rowH}px`; }}>
            <div className="who" data-ctl="CTL-OFC-02-08" ref={(el) => { if (el) el.style.width = `${who}px`; }}>
              <span className="av" ref={(el) => { if (el) el.style.background = 'var(--teal-600)'; }}>{x.initials}</span>
              <div>
                <div className="nm">{x.name}</div>
                <div className="sub" title={x.van ? t('board.vanSkill', { van: x.van, skill }) : skill}>{x.van ? t('board.vanSkill', { van: x.van, skill }) : skill}</div>
                {moreSkills.length > 0 ? <div className="sub2" title={moreSkills.join(', ')}>{moreSkills.join(', ')}</div> : null}
              </div>
            </div>
            {lane(x.id, r.jobs, blocksOn(x.id), r.left)}
          </div>
        );
      })}
      {mounted && p.now !== null && p.now !== undefined && p.now >= span.start && p.now <= span.end ? (
        <div className="tl-now" data-ctl="CTL-OFC-02-11" ref={(el) => { if (el) el.style.left = `calc(${who}px + (100% - ${who}px) * ${(pct(p.now as number, span) / 100).toFixed(5)})`; }}>
          <span className="flag">{nowLabel(p.now)}</span>
        </div>
      ) : null}
      </div>
    </div>
  );
}

/** DK-74's Done mark: the check icon drawn with stroke 2.6 and the kit class ck (DK-17 .job .ck). */
function CheckMark() {
  return (
    <svg className="ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={CHECK_PATH} />
    </svg>
  );
}

/** "10:28 AM" (DK-74 BW.fmt). */
export function nowLabel(hour: number): string {
  let h = Math.floor(hour + 1e-6);
  let m = Math.round((hour - h) * 60);
  if (m === 60) {
    h += 1;
    m = 0;
  }
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
