// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-02 Dispatch board, its timeline half (P4-BOARD; UI-SPECIFICATION section 6; DK-85 office-board.html): the date
// navigation and day mode (CTL-OFC-02-01 to 04, -07), New job (-05), the day summary (-06, -18, -19), Day / Week (-20),
// Add block (-32), the live indicator (CMP-13), the status legend (-17), the timeline (Timeline.tsx), the Needs attention
// list with the flagged phone items and Mark handled (-15, -16), and the hosted popovers and dialogs (Dialogs.tsx).
// The map panel's controls (-12 to -14, -22 to -31) are MapPanel.tsx (P4-BOARD-MAP); this screen owns its choices and its read:
// API-21 every 10 s while the panel is shown, whatever API-20 answered and whatever day is shown (SD-47, GAP-7, SCR-OFC-02's
// Partial state, CTL-OFC-02-23: a van's position is at the demo time), and Hide map's choice, kept in the browser.
//
// Writes: a drop (or the reassign dialog) calls API-22 against the version the board read; the block shows "Moving..."
// until the answer and returns on a refusal (SD-47 optimistic move with rollback). version_conflict opens SCR-OFC-19,
// whose Move it anyway repeats the call against the answer's currentVersion (UD-6). Live: API-09's events re-read API-20
// and, after each re-read an event caused, the board posts that event's seq to API-172 (OI-48, SD-43).
import { subscribeEvents } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { Temporal, toWire } from '@bw/time';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAnnounce } from '../shell/Announcer.tsx';
import { branchById, BRANCH_STORAGE_KEY } from '../shell/branches.ts';
import { toView, type ClockAnswer } from '../shell/clock.ts';
import { officeClock, useDemoClock } from '../shell/demo-day.ts';
import { OfficeFrame } from '../shell/Frames.tsx';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { useMe } from '../shell/me.ts';
import type { Me } from '../shell/OfficeTopBar.tsx';
import { ErrorPanel, LiveIndicator, type LiveState } from '../shell/Panels.tsx';
import { boardApi, conflictOf, overlapOf, type Refusal } from './api.ts';
import { delaySampler } from './delay-samples.ts';
import { routeLines } from './route-lines.ts';
import { weekParamMonday } from '../week/week-model.ts';
import { fileSrc, thumbSrc } from '../job/PhotoViewer.tsx';
import './css.ts';
import { MapPanel } from './MapPanel.tsx';
import {
  BlockDialog, BlockPopover, ConflictDialog, DeleteBlockDialog, JobPopover, ReassignDialog, useConflictText,
  type BlockErrors, type BlockForm, type BlockView, type ConflictSubject, type ReassignState,
} from './Dialogs.tsx';
import {
  blockDrop, boardHref, dateParts, draggable, entryLines, filtered, flagValues, hhmm, hourOf, isDate, jobDrop, noRoomText, shortName, shortWindow, spanText, stepDate, timeText, windowText,
  type Board, type BoardBlock, type BoardJob, type Conflict, type JobTab, type MapShows, type Target, type Van,
} from './model.ts';
import { Timeline, type Drag, type DragPreview } from './Timeline.tsx';

/** SD-47, GAP-7: board van positions re-read every 10 s; they are computed on read, so no event says they moved. */
export const VAN_READ_MS = 10_000;
/** Where the browser keeps Hide map's choice (CTL-OFC-02-22): a per-viewer convenience, so a failed store only loses the choice. */
export const MAP_HIDDEN_KEY = 'bw.board.mapHidden';

/** The events the board re-reads on (UI-SPECIFICATION SCR-OFC-02 Live: EVT-01, -02, -05, -06, -09, -10). */
export const BOARD_EVENTS = new Set(['job.changed', 'board.refresh', 'clock.changed', 'world.reset', 'settings.changed', 'block.changed']);

type Pop = { kind: 'job'; jobNumber: number; anchor: HTMLElement | null } | { kind: 'block'; blockId: string; anchor: HTMLElement | null };

/** A write the conflict dialog can repeat against the answer's version (UD-6). */
type Retry =
  | { kind: 'job'; job: BoardJob; to: string | null; toName: string }
  | { kind: 'block'; block: BoardBlock; technicianId: string; start: string; end: string };

type Modal =
  | { kind: 'reassign'; job: BoardJob; state: ReassignState }
  | { kind: 'conflict'; retry: Retry; conflict: Conflict | null; theirs: string | null; again: boolean; resending: boolean }
  | { kind: 'block'; mode: 'add' | 'change'; block: BoardBlock | null; form: BlockForm; errors: BlockErrors; overlap: string | null; saving: boolean }
  | { kind: 'delete'; block: BoardBlock; technicianId: string; deleting: boolean };

export interface BoardScreenProps {
  /** Harness states: a fixed board, no reads, no stream. */
  fixed?: {
    board: Board | 'loading' | 'error'; me: Me; clock: ClockAnswer; scene?: Drag | null; moving?: Map<number, string | null>; offline?: boolean;
    marking?: string | null; extra?: ReactNode;
    /** The map panel's harness state: its read's answer and the choices a person made. */
    vans?: readonly Van[] | 'failed'; shows?: MapShows; skill?: string | null; tab?: JobTab; selected?: string | null; hidden?: boolean;
  };
}

const findJob = (b: Board, n: number): BoardJob | undefined => [...b.unassigned, ...b.technicians.flatMap((x) => x.jobs)].find((j) => j.jobNumber === n);
const findBlock = (b: Board, id: string) => {
  for (const x of b.technicians) for (const bl of x.blocks) if (bl.blockId === id) return { block: bl, technicianId: x.id, technician: x.name };
  return null;
};

/** A board read on its way: for 1 branch and date, with whether it must run again and whether its last answer failed. */
interface Flight { key: string; again: boolean; failed: boolean; promise: Promise<Board | null> }

export function BoardScreen({ fixed }: BoardScreenProps) {
  const t = useT();
  const announce = useAnnounce();
  const api = useMemo(() => boardApi(), []);
  const me = useMe(fixed ? false : undefined, fixed?.me);
  const params = useSearchParams();
  const asked = params?.get('date') ?? 'today';
  const date = isDate(asked) ? asked : 'today';
  const [storedBranch, setStoredBranch] = useState<string | null>(null);
  useEffect(() => {
    try {
      setStoredBranch(window.localStorage.getItem(BRANCH_STORAGE_KEY));
    } catch {
      setStoredBranch(null);
    }
  }, []);
  const branch = me ? branchById(params?.get('branch') ?? storedBranch ?? me.branch).id : null;

  const [board, setBoard] = useState<Board | null>(fixed && typeof fixed.board === 'object' ? fixed.board : null);
  const [failed, setFailed] = useState(fixed?.board === 'error');
  const [offline, setOffline] = useState(fixed?.offline ?? false);
  // F-1085: a live board starts at Reconnecting: Live is said only once the stream (API-09) has answered (a preview's fixed state starts Live).
  const [live, setLive] = useState<LiveState>(fixed ? 'live' : 'reconnecting');
  const [moving, setMoving] = useState<Map<number, string | null>>(fixed?.moving ?? new Map());
  const [movingBlocks, setMovingBlocks] = useState<Map<string, { technicianId: string; start: string; end: string }>>(new Map());
  const [pop, setPop] = useState<Pop | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [marking, setMarking] = useState<string | null>(fixed?.marking ?? null);
  const conflictText = useConflictText();
  const [mapHidden, setMapHidden] = useState(fixed?.hidden ?? false);
  // F-1544: the larger map. Not kept: a reload opens the normal board (it is a closer look at the map, not a setting).
  const [mapLarge, setMapLarge] = useState(false);
  const [vans, setVans] = useState<readonly Van[] | 'failed' | null>(fixed?.vans ?? null);
  const [shows, setShows] = useState<MapShows>(fixed?.shows ?? 'vans');
  const [skill, setSkill] = useState<string | null>(fixed?.skill ?? null);
  const [tab, setTab] = useState<JobTab>(fixed?.tab ?? 'attention');
  const [selectedVan, setSelectedVan] = useState<string | null>(fixed?.selected ?? null);

  // --- the demo time (API-10): the now line and "Today, live" (CTL-OFC-02-11, -04), re-read on clock.changed -----------
  const { now: demoNow, readClock, ticks, failed: clockFailed } = useDemoClock(fixed ? null : officeClock, fixed ? toView(fixed.clock) : null);

  // --- reads ---------------------------------------------------------------------------------------------------------
  // 1 read on its way for each branch and date: a read for another branch does not join it, and an answer of a read that is no longer the
  // one on its way does not land, so the old branch's rows never stand under the new branch's name (F-1947).
  const reading = useRef<Flight | null>(null);
  const shownKey = useRef('');
  const [readFailures, setReadFailures] = useState(0);
  const read = useCallback(async (): Promise<Board | null> => {
    if (fixed || !branch) return null;
    const key = `${branch} ${date}`;
    // A write begun under the branch just left ends with that branch's read: it must not start, nor take the place of the new branch's read (F-1983).
    if (key !== shownKey.current) return null;
    const flying = reading.current;
    if (flying && flying.key === key) {
      flying.again = true;
      return flying.promise;
    }
    const flight: Flight = { key, again: false, failed: false, promise: Promise.resolve(null) };
    flight.promise = (async () => {
      let out: Board | null = null;
      do {
        flight.again = false;
        const r = await api.board(branch, date);
        if (reading.current !== flight) return out;
        if (r.ok) {
          out = r.data;
          setBoard(r.data);
          setFailed(false);
          setOffline(false);
          flight.failed = false;
        } else if (r.code === 'offline' || r.status >= 500) {
          setOffline(true);
          setFailed((f) => f || out === null);
          flight.failed = true;
        } else {
          // F-833: a refusal is no passing outage, and nothing says the last board is old: CMP-12 takes its place until a read answers.
          setBoard(null);
          setFailed(true);
          flight.failed = true;
        }
      } while (flight.again);
      return out;
    })();
    reading.current = flight;
    try {
      return await flight.promise;
    } finally {
      if (reading.current === flight) {
        reading.current = null;
        // A failed read changes no dependency of the date check below when the offline bar was already up; this lets it look once more (F-1949).
        if (flight.failed) setReadFailures((n) => n + 1);
      }
    }
  }, [api, branch, date, fixed]);

  useEffect(() => {
    if (fixed || !branch) return;
    setBoard(null);
    shownKey.current = `${branch} ${date}`;
    void read();
  }, [branch, date, fixed, read]);

  // --- the map panel's read (API-21): while the panel is shown, every 10 s and at once on Show map ------------------------
  useEffect(() => {
    if (fixed) return;
    try {
      setMapHidden(window.localStorage.getItem(MAP_HIDDEN_KEY) === '1');
    } catch {
      setMapHidden(false);
    }
  }, [fixed]);
  // Escape returns from the larger map, unless it is closing something of its own (the vans menu, a popover or a dialog); focus goes to the toggle.
  useEffect(() => {
    if (!mapLarge) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('.r1-pop, [role="dialog"], .bw-vans-menu')) return;
      setMapLarge(false);
      document.querySelector<HTMLElement>('.mapp [data-large-toggle]')?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mapLarge]);
  const hideMap = (hidden: boolean) => {
    setMapLarge(false);
    setMapHidden(hidden);
    try {
      window.localStorage.setItem(MAP_HIDDEN_KEY, hidden ? '1' : '0');
    } catch {
      // The choice lasts until the page leaves.
    }
  };
  // Only the newest read's answer lands: a slow answer of the branch just left must not stand as this branch's vans.
  const vanRead = useRef(0);
  // F-817: the route lines of the last answer, named as `have` on the next read so an unchanged leg travels once.
  const lines = useRef(routeLines());
  const readVans = useCallback(async () => {
    if (fixed || !branch) return;
    const mine = ++vanRead.current;
    const r = await api.vans(branch, lines.current.have());
    if (mine !== vanRead.current) return;
    if (!r.ok) lines.current.reset();
    setVans(r.ok ? lines.current.take(r.data.vans, r.data.worldEpoch) : 'failed');
  }, [api, branch, fixed]);
  useEffect(() => {
    if (fixed || !branch || mapHidden) return;
    setVans(null); // unknown until this read answers: the panel prints no number for it
    lines.current.reset(); // a first read (this branch, or the panel shown again) names no lines
    void readVans();
    const h = window.setInterval(() => void readVans(), VAN_READ_MS);
    return () => {
      window.clearInterval(h);
      vanRead.current++;
    };
  }, [branch, fixed, mapHidden, readVans]);

  // --- live updates (API-09), the re-read after each event, and its delay sample (API-172) ---------------------------
  // 1 subscription per branch: what it calls back is read through a ref, so a render never closes and reopens it.
  const onLive = useRef({ read, readClock, api });
  onLive.current = { read, readClock, api };
  useEffect(() => {
    if (fixed || !branch) return;
    let open = true;
    // F-1085: the first read can start before this board's stream is open (event-stream.ts calls onReconnect only on a re-open), and nothing
    // replays (D1), so a change committed in between would wait for some later event: the first time the stream answers, read once more.
    let firstLive = true;
    let reconnected = false;
    // Every seq the batch held: the 1 re-read holds 1 sample per seq (API-172, F-606), so the slowest delay (SD-43) is not under-reported in a
    // burst; the held samples leave in batches (F-885).
    const samples = delaySampler((batch, keepalive) => onLive.current.api.delaySamples(batch, keepalive));
    let pending: number[] = [];
    let timer: number | null = null;
    const flush = async () => {
      timer = null;
      const seqs = pending;
      pending = [];
      const b = await onLive.current.read();
      if (b && open) samples.hold(seqs);
    };
    const h = subscribeEvents({
      branch,
      onEvent: (e) => {
        if (!BOARD_EVENTS.has(e.name)) return;
        if (e.name === 'clock.changed' || e.name === 'world.reset') void onLive.current.readClock();
        pending.push(e.seq);
        if (timer === null) timer = window.setTimeout(() => void flush(), 50);
      },
      // The clock first: a clock event missed while the stream was lost is never sent again.
      onReconnect: () => {
        reconnected = true;
        void onLive.current.readClock().then(() => {
          if (open) void onLive.current.read();
        });
      },
      onState: (s) => {
        if (open) setLive(s === 'live' ? 'live' : s === 'closed' ? 'paused' : 'reconnecting');
        if (open && s === 'live' && firstLive) {
          firstLive = false;
          // A board that subscribed while the stream was lost first hears it live on a reconnect, and the hub says live before it says
          // reconnect: that read is onReconnect's, clock first, and the only one.
          queueMicrotask(() => {
            if (open && !reconnected) void onLive.current.read();
          });
        }
      },
    });
    return () => {
      open = false;
      h.close();
      if (timer !== null) window.clearTimeout(timer);
      samples.close();
    };
  }, [branch, fixed]);

  // --- words ---------------------------------------------------------------------------------------------------------
  const dateText = (d: string) => {
    const p = dateParts(d);
    return t('board.date', { weekday: t(`time.weekday.${p.weekday}` as MessageKey), month: t(`time.month.${p.month}` as MessageKey), day: p.day, year: p.year });
  };
  const shortDate = (d: string) => {
    const p = dateParts(d);
    return t('shell.clock.short', { weekday: t(`time.weekday.${p.weekday}` as MessageKey), month: t(`time.month.${p.month}` as MessageKey), day: p.day, time: '' }).replace(/, $/, '');
  };
  const techName = (id: string | null) => (id === null ? null : board?.technicians.find((x) => x.id === id)?.name ?? null);
  // UD-18: while today is chosen the board follows the demo clock across midnight.
  const demoDate = board && demoNow ? toWire(demoNow, board.zone).slice(0, 10) : null;
  // Either date can be the old one (this page can miss a clock event, or run ahead of a clock that was paused), so the clock is read before the
  // board. 1 re-read for each pair of dates, because every answer is a new board and runs this again; once the 2 agree the pair is forgotten, so
  // the same dates can come again after a reset. A board read already on its way answers first; one that fails sets no board, but offline changes.
  // A pair whose clock read failed is not held: the next tick (30 s) tries it again, and so does a failed board read that ended while the dates differed (F-1949).
  const reReadFor = useRef<string | null>(null);
  const reReadTick = useRef(0);
  useEffect(() => {
    if (date !== 'today' || !board || !demoDate || demoDate === board.date) {
      reReadFor.current = null;
      return;
    }
    // A failed clock read makes the pair try again once for each tick, so the answers it brings do not run this in a loop.
    const pair = `${board.date} ${demoDate}`;
    if (reading.current || (reReadFor.current === pair && (!clockFailed || reReadTick.current === ticks))) return;
    reReadFor.current = pair;
    reReadTick.current = ticks;
    void readClock().then(() => onLive.current.read());
  }, [board, date, demoDate, offline, readClock, ticks, clockFailed, readFailures]);
  const nowWire = board?.today && demoNow ? toWire(demoNow, board.zone) : null;
  const nowHour = nowWire ? hourOf(nowWire) : null;

  // --- refusals ------------------------------------------------------------------------------------------------------
  const refusalText = (r: Refusal, technician: string | null, window = ''): string => {
    const o = overlapOf(r);
    if (o && board) {
      const job = findJob(board, o.job.jobNumber);
      return r.detail.block && !job
        ? t('board.refused.overBlock', { technician: technician ?? '', label: o.block.label, span: spanText(o.block.start, o.block.end) })
        : t('board.refused.overJob', { technician: technician ?? '', customer: job?.customerName ?? String(o.job.jobNumber), span: spanText(o.job.plannedArrival, o.job.plannedEnd) });
    }
    if (r.code === 'technician_no_room') {
      const text = noRoomText(t, r.detail, technician ?? '', window);
      if (text) return text;
    }
    if (r.code === 'rule_refused') return t('board.refused.rule');
    return t('board.refused.other');
  };
  /** A job move's overlap names the block it would overlap; a block move's names the job. */
  const jobOverlapText = (r: Refusal, technician: string | null, window: string) => {
    const o = overlapOf(r);
    return o ? t('board.refused.overBlock', { technician: technician ?? '', label: o.block.label, span: spanText(o.block.start, o.block.end) }) : refusalText(r, technician, window);
  };
  const blockOverlapText = (r: Refusal, technician: string | null) => {
    const o = overlapOf(r);
    if (!o || !board) return refusalText(r, technician);
    const job = findJob(board, o.job.jobNumber);
    return t('board.refused.overJob', { technician: technician ?? '', customer: job?.customerName ?? String(o.job.jobNumber), span: spanText(o.job.plannedArrival, o.job.plannedEnd) });
  };

  // --- job moves -----------------------------------------------------------------------------------------------------
  const moveJob = async (job: BoardJob, to: string | null, baseVersion: number, from: 'drop' | 'dialog' | 'conflict'): Promise<void> => {
    const toName = to === null ? t('board.unassignedRow') : techName(to) ?? '';
    if (from === 'drop') setMoving((m) => new Map(m).set(job.jobNumber, to));
    const r = await api.assign(job.jobNumber, to, baseVersion);
    const done = () => setMoving((m) => {
      const n = new Map(m);
      n.delete(job.jobNumber);
      return n;
    });
    if (r.ok) {
      const written = (r.data as { job: { plannedArrival: string | null } }).job;
      await read();
      done();
      // F-1787: a drop has no dialog of its own; one opened while its read was in flight is left open (see moveBlockTo).
      if (from !== 'drop') setModal(null);
      if (to === null) announce(t('board.toast.toUnassigned', { job: job.jobNumber }));
      else if (from === 'dialog') announce(t('board.toast.reassigned', { job: job.jobNumber, name: toName }));
      else announce(t('board.toast.moved', { name: toName, time: written.plannedArrival ? timeText(written.plannedArrival) : '' }));
      return;
    }
    done();
    const c = conflictOf(r);
    if (c) {
      setModal((m) => ({ kind: 'conflict', retry: { kind: 'job', job, to, toName }, conflict: c, theirs: null, again: m?.kind === 'conflict', resending: false }));
      void read();
      return;
    }
    if (r.code === 'not_found') {
      if (from === 'conflict') setModal({ kind: 'conflict', retry: { kind: 'job', job, to, toName }, conflict: null, theirs: null, again: false, resending: false });
      void read();
      return;
    }
    const text = jobOverlapText(r, to === null ? null : techName(to), windowText(job.window.start, job.window.end));
    if (from === 'dialog') setModal((m) => (m?.kind === 'reassign' && m.state.step === 'choosing' ? { ...m, state: { ...m.state, saving: false, message: text } } : m));
    else {
      // A drop has no dialog of its own: one opened while its write was in flight is left open.
      if (from !== 'drop') setModal(null);
      announce(text, 'alert');
    }
  };

  const onDropJob = (job: BoardJob, target: Target) => {
    const move = jobDrop(job, target);
    if (!move || offline) return;
    void moveJob(job, move.technicianId, job.version, 'drop');
  };
  const onPreview = async (job: BoardJob, technicianId: string | null): Promise<DragPreview> => {
    const r = await api.preview(job.jobNumber, technicianId);
    return r.ok ? { state: 'ok', arrivesAbout: r.data.arrivesAbout, insideWindow: r.data.insideWindow } : { state: 'failed' };
  };

  // --- block moves ---------------------------------------------------------------------------------------------------
  const moveBlockTo = async (block: BoardBlock, technicianId: string, start: string, end: string, baseVersion: number, from: 'drop' | 'dialog' | 'conflict') => {
    // F-1787: the answer closes only what was open when the move started. The block stays pressable while its move reads the
    // board, and a popover opened then (or its Delete dialog) is the person's next step: SCR-OFC-32 closes only by Close or
    // Escape, and a drop has no dialog of its own. Closing whatever was open when the read settled shut both on board-stack.
    const popAtStart = pop;
    if (from === 'drop') setMovingBlocks((m) => new Map(m).set(block.blockId, { technicianId, start: retime(block.start, start), end: retime(block.end, end) }));
    const r = await api.moveBlock({ blockId: block.blockId, technicianId, start, end, baseVersion });
    const done = () => setMovingBlocks((m) => {
      const n = new Map(m);
      n.delete(block.blockId);
      return n;
    });
    if (r.ok) {
      const b = (r.data as { block: BoardBlock }).block;
      await read();
      done();
      if (from !== 'drop') setModal(null);
      setPop((p) => (p === popAtStart ? null : p));
      announce(t('board.toast.blockMoved', { label: b.label, name: techName(technicianId) ?? '', span: spanText(b.start, b.end) }));
      return;
    }
    done();
    const c = conflictOf(r);
    if (c) {
      const now = await read();
      const cur = now ? findBlock(now, block.blockId) : null;
      setModal((m) => ({
        kind: 'conflict', retry: { kind: 'block', block, technicianId, start, end }, conflict: c,
        theirs: cur ? timeText(cur.block.start) : null, again: m?.kind === 'conflict', resending: false,
      }));
      return;
    }
    if (r.code === 'not_found') {
      if (from !== 'drop') setModal({ kind: 'conflict', retry: { kind: 'block', block, technicianId, start, end }, conflict: null, theirs: null, again: false, resending: false });
      void read();
      return;
    }
    const text = blockOverlapText(r, techName(technicianId));
    if (from === 'dialog') setModal((m) => (m?.kind === 'block' ? { ...m, saving: false, overlap: text } : m));
    else {
      if (from !== 'drop') setModal(null);
      announce(text, 'alert');
    }
  };
  const onDropBlock = (block: BoardBlock, fromTech: string, target: Target, startHour: number) => {
    if (offline) return;
    const d = blockDrop(block, fromTech, target, startHour);
    if (d === null) return;
    if (d === 'needs_technician') {
      announce(t('board.drop.needsTech'), 'alert');
      return;
    }
    void moveBlockTo(block, d.technicianId, d.start, d.end, block.version, 'drop');
  };

  // --- the conflict dialog -------------------------------------------------------------------------------------------
  const anyway = () => {
    if (modal?.kind !== 'conflict' || !modal.conflict) return;
    const { retry, conflict } = modal;
    setModal({ ...modal, resending: true });
    if (retry.kind === 'job') void moveJob({ ...retry.job, version: conflict.currentVersion }, retry.to, conflict.currentVersion, 'conflict');
    else void moveBlockTo({ ...retry.block, version: conflict.currentVersion }, retry.technicianId, retry.start, retry.end, conflict.currentVersion, 'conflict');
  };
  const keep = () => {
    setModal(null);
    void read();
  };
  const conflictMessage = (m: Extract<Modal, { kind: 'conflict' }>): string | null => {
    if (!m.conflict) return null;
    const subject: ConflictSubject = m.retry.kind === 'job' ? { kind: 'job', mine: m.retry.toName }
      : { kind: 'block', mine: timeText(retime(m.retry.block.start, m.retry.start)), theirs: m.theirs };
    return conflictText(m.conflict, subject, m.again);
  };

  // --- the reassign dialog -------------------------------------------------------------------------------------------
  const openReassign = async (job: BoardJob) => {
    if (!board || !branch) return;
    setPop(null);
    setModal({ kind: 'reassign', job, state: { step: 'loading' } });
    const r = await api.suggest({ branch, date: board.date, windowId: job.windowId, serviceId: job.serviceId, jobNumber: job.jobNumber });
    setModal((m) => (m?.kind === 'reassign' ? { ...m, state: r.ok ? { step: 'choosing', list: r.data.technicians, pick: undefined, preview: null, saving: false, message: null } : { step: 'error' } } : m));
  };
  const pickReassign = async (id: string | null) => {
    if (modal?.kind !== 'reassign' || modal.state.step !== 'choosing') return;
    const job = modal.job;
    setModal({ ...modal, state: { ...modal.state, pick: id, preview: null, message: null } });
    if (id === null) return;
    const r = await api.preview(job.jobNumber, id);
    setModal((m) => (m?.kind === 'reassign' && m.state.step === 'choosing' && m.state.pick === id ? { ...m, state: { ...m.state, preview: r.ok ? r.data : 'failed' } } : m));
  };
  const submitReassign = () => {
    if (modal?.kind !== 'reassign' || modal.state.step !== 'choosing' || modal.state.pick === undefined || modal.state.saving) return;
    setModal({ ...modal, state: { ...modal.state, saving: true } });
    void moveJob(modal.job, modal.state.pick, modal.job.version, 'dialog');
  };

  // --- the block dialogs ---------------------------------------------------------------------------------------------
  const workingTechs = board?.technicians.map((x) => ({ id: x.id, name: x.name })) ?? [];
  const openAddBlock = () => {
    setModal({ kind: 'block', mode: 'add', block: null, form: { technicianId: workingTechs[0]?.id ?? '', label: '', place: '', start: '', end: '' }, errors: {}, overlap: null, saving: false });
  };
  const openChangeBlock = (blockId: string) => {
    const f = board ? findBlock(board, blockId) : null;
    if (!f) return;
    setPop(null);
    setModal({ kind: 'block', mode: 'change', block: f.block, form: { technicianId: f.technicianId, label: f.block.label, place: f.block.place ?? '', start: hhmm(f.block.start), end: hhmm(f.block.end) }, errors: {}, overlap: null, saving: false });
  };
  const saveBlock = async () => {
    if (modal?.kind !== 'block' || modal.saving || !board) return;
    const f = modal.form;
    const errors: BlockErrors = {};
    if (f.label.trim() === '') errors.label = 'board.blockdlg.required';
    if (f.place.trim() === '') errors.place = 'board.blockdlg.required';
    if (!(f.start && f.end && f.end > f.start)) errors.end = 'board.blockdlg.endAfter';
    if (Object.keys(errors).length > 0) {
      setModal({ ...modal, errors });
      return;
    }
    setModal({ ...modal, errors: {}, overlap: null, saving: true });
    if (modal.mode === 'change' && modal.block) {
      await moveBlockTo(modal.block, f.technicianId, f.start, f.end, modal.block.version, 'dialog');
      return;
    }
    const r = await api.createBlock({ technicianId: f.technicianId, date: board.date, label: f.label.trim(), place: f.place.trim(), start: f.start, end: f.end });
    if (r.ok) {
      const b = (r.data as { block: BoardBlock }).block;
      await read();
      setModal(null);
      announce(t('board.toast.blockAdded', { label: b.label, name: techName(f.technicianId) ?? '', span: spanText(b.start, b.end) }));
      return;
    }
    const text = blockOverlapText(r, techName(f.technicianId));
    setModal((m) => (m?.kind === 'block' ? { ...m, saving: false, overlap: text } : m));
  };
  const confirmDelete = async () => {
    if (modal?.kind !== 'delete' || modal.deleting) return;
    const label = modal.block.label;
    setModal({ ...modal, deleting: true });
    const r = await api.deleteBlock(modal.block.blockId);
    await read();
    setModal(null);
    setPop(null);
    announce(r.ok ? t('board.toast.blockDeleted', { label }) : t('board.delete.already'), r.ok ? 'check' : 'info');
  };

  // --- Mark handled (API-39) -----------------------------------------------------------------------------------------
  // F-1734: each item's own press is held by a ref, not by the render's marking. The press publishes board.refresh, and that event's re-read
  // can draw the board without this row while this press's read is still in flight; the next row's button is then on screen and enabled,
  // and a guard on the render's marking (still this row's id) dropped its press with nothing shown.
  const markingNow = useRef(new Set<string>());
  const markHandled = async (conflictId: string) => {
    if (markingNow.current.has(conflictId)) return;
    markingNow.current.add(conflictId);
    setMarking(conflictId);
    const r = await api.markHandled(conflictId);
    await read();
    markingNow.current.delete(conflictId);
    setMarking((m) => (m === conflictId ? null : m));
    if (r.ok) announce(t('board.toast.handled'));
    else if (r.code === 'already_handled') {
      const at = typeof r.detail.at === 'string' ? timeText(r.detail.at) : '';
      announce(t('board.att.alreadyHandled', { by: String(r.detail.by ?? ''), at }), 'info');
    }
  };

  // --- render --------------------------------------------------------------------------------------------------------
  const today = board?.today ?? date === 'today';
  const go = (d: string | 'today') => {
    window.location.assign(boardHref(branch, d));
  };
  // CTL-OFC-02-20: Week opens SCR-OFC-34 on the week that holds the shown day (P4-WEEK's route).
  const openWeek = () => {
    const q = new URLSearchParams();
    if (branch) q.set('branch', branch);
    if (board) q.set('week', weekParamMonday(board.date) ?? board.date);
    window.location.assign(`/office/board/week?${q.toString()}`);
  };
  const popJob = pop?.kind === 'job' && board ? findJob(board, pop.jobNumber) ?? null : null;
  const popBlock = pop?.kind === 'block' && board ? findBlock(board, pop.blockId) : null;
  const blockView = (f: { block: BoardBlock; technician: string } | null): BlockView | null => (f && board
    ? { label: f.block.label, place: f.block.place, technician: f.technician, date: shortDate(board.date), start: f.block.start, end: f.block.end } : null);

  const summary = board ? (
    <div className="tiles" data-ctl="CTL-OFC-02-06" role="group" aria-label={t('board.summary.label')}>
      <div className="tile"><span className="num">{board.counts.jobs}</span><span className="lb">{t('board.summary.jobs', { today: today ? 'true' : 'false' })}<small>{t('board.summary.jobsSub', { done: board.counts.done, onSite: board.counts.onSite })}</small></span></div>
      <div className="tile" data-ctl="CTL-OFC-02-18">
        <span className="num" ref={(el) => { if (el) el.style.color = 'var(--teal-700)'; }}>{board.onTime7.rate === null ? t('board.summary.notAvailable') : t('board.summary.rate', { rate: Math.round(board.onTime7.rate * 100) })}</span>
        <span className="lb">{t('board.summary.onTime')}<small>{t('board.summary.onTimeSub', { goal: t('board.summary.rate', { rate: Math.round(board.onTime7.goal * 100) }) })}</small><small className="sim">{t(board.onTime7.labelKey as MessageKey)}</small></span>
      </div>
      <div className="tile late"><span className="num">{board.counts.late}</span><span className="lb">{t('board.summary.late')}<small>{t('board.summary.lateSub')}</small></span></div>
      <div className="tile risk"><span className="num">{board.counts.atRisk}</span><span className="lb">{t('board.summary.risk')}<small>{t('board.summary.riskSub')}</small></span></div>
      <div className="tile unas"><span className="num">{board.counts.unassigned}</span><span className="lb">{t('board.summary.unas')}<small>{t('board.summary.unasSub')}</small></span></div>
      <div className="tile flag"><span className="num">{board.counts.flagged}</span><span className="lb">{t('board.summary.flag')}<small>{t('board.summary.flagSub')}</small></span></div>
    </div>
  ) : <div className="tiles" data-ctl="CTL-OFC-02-06" />;

  const attention = board ? (() => {
    const { rows, flagged } = filtered(board, skill).attention;
    const chip = (label: string) => (label === 'status.timing.late' ? 'late' : label === 'status.timing.atRisk' ? 'risk' : 'unas');
    return (
      <div className="att" data-ctl="CTL-OFC-02-15">
        {rows.length === 0 && flagged.length === 0 ? <p className="r1-note bw-att-none">{t('board.att.none')}</p> : null}
        {rows.map((r) => (
          <a key={`${r.label}${r.jobNumber}`} className="row jrow" href={`/office/jobs/${r.jobNumber}`}>
            <span className={`chip ${chip(r.label)}`}><span className="dot" />{t(r.label as MessageKey)}</span>
            <div className="tx"><b>{r.customerName}</b> - {r.area}<small>{r.technician && r.eta
              ? t('board.att.sub', { technician: shortName(r.technician) ?? r.technician, eta: timeText(r.eta), window: shortWindow(r.window.start, r.window.end) })
              : t('board.att.subNoTech', { window: shortWindow(r.window.start, r.window.end) })}</small></div>
          </a>
        ))}
        {flagged.map((f) => (
          <div key={f.conflictId} className="row" data-conflict={f.conflictId}>
            <span className="chip flagc">{t('board.att.flagged')}</span>
            <div className="tx">{f.listed ? <a href={`/office/jobs/${f.jobNumber}`}><b>{t(f.messageKey as MessageKey, flagValues(f.values))}</b></a> : <b>{t(f.messageKey as MessageKey, flagValues(f.values))}</b>}<small>{t('board.att.times', { offline: timeText(f.offlineAt), sent: timeText(f.sentAt) })}</small>{entryLines(f.entry, t).map((line, i) => <small key={i} className="ent bw-att-entry">{line}</small>)}{f.entry && (f.entry.kind === 'photo' || f.entry.kind === 'signature') ? <small className="ent bw-att-entry"><a href={fileSrc(f.entry.key)} target="_blank" rel="noreferrer" data-entry-file={f.entry.kind}><img className="bw-att-tile" src={f.entry.kind === 'photo' ? thumbSrc(f.entry.key) : fileSrc(f.entry.key)} alt="" />{t(f.entry.kind === 'photo' ? 'board.att.entry.photo' : 'board.att.entry.signature')}</a></small> : null}</div>
            {marking === f.conflictId ? (
              <button type="button" className="btn busy sm" aria-busy="true" data-ctl="CTL-OFC-02-16"><span className="r1-spin dark" />{t('board.att.marking')}</button>
            ) : (
              <button type="button" className={offline ? 'btn sm dis' : 'btn sm'} aria-disabled={offline || undefined} data-ctl="CTL-OFC-02-16" onClick={offline ? undefined : () => void markHandled(f.conflictId)}>{t('board.att.markHandled')}</button>
            )}
          </div>
        ))}
      </div>
    );
  })() : null;

  const timeline = (() => {
    if (fixed?.board === 'loading' || (!board && !failed)) {
      return <div className="bw-board-loading" aria-busy="true"><span className="r1-skel bw-w-30" /><span className="r1-skel" /><span className="r1-skel" /><span className="r1-skel" /><span className="r1-skel" /><span className="r1-skel" /></div>;
    }
    if (!board) return <ErrorPanel title={t('board.readError')} hint={t('shell.error.checkConnection')} onRetry={read} />;
    if (board.technicians.length === 0) return <p className="r1-note">{t('board.noTechs', { date: shortDate(board.date) })}</p>;
    return (
      <Timeline
        id="tl"
        board={board}
        now={nowHour}
        moving={moving}
        movingBlocks={movingBlocks}
        paused={offline}
        scene={fixed?.scene ?? null}
        noJobs={board.counts.jobs === 0}
        onOpenJob={(j, el) => setPop({ kind: 'job', jobNumber: j.jobNumber, anchor: el })}
        onOpenBlock={(b, _tech, el) => setPop({ kind: 'block', blockId: b.blockId, anchor: el })}
        onPreview={onPreview}
        onDropJob={onDropJob}
        onDropBlock={onDropBlock}
      />
    );
  })();

  const mapButton = mapHidden ? <button type="button" className="btn sm" data-ctl="CTL-OFC-02-22" onClick={() => hideMap(false)}><Icon name="map" />{t('board.map.show')}</button> : null;

  return (
    <OfficeFrame screen="SCR-OFC-02" {...(me ? { me } : {})} {...(fixed ? { clock: fixed.clock, reader: false as const, appInfo: null } : {})}>
      <title>{t('board.doc')}</title>
      <div className="sumbar">
        <div className="datenav">
          <button type="button" className="bw-btn-reset arrow" aria-label={t('board.prevDay')} data-ctl="CTL-OFC-02-01" onClick={() => board && go(stepDate(board.date, -1))}><Icon name="chevLeft" /></button>
          <span className="d" data-ctl="CTL-OFC-02-04">
            <label className="bw-date">
              <b>{board ? dateText(board.date) : ' '}</b>
              <input type="date" className="bw-date-input" aria-label={t('board.dateField')} value={board?.date ?? ''} onChange={(e) => isDate(e.target.value) && go(e.target.value)} />
            </label>
            <span>
              {nowWire ? `${t('board.live', { time: timeText(nowWire) })} ` : null}
              {board ? <span className="mode" data-ctl="CTL-OFC-02-07">{t(`board.mode.${board.dayMode}` as MessageKey)}</span> : null}
            </span>
          </span>
          <button type="button" className="bw-btn-reset arrow" aria-label={t('board.nextDay')} data-ctl="CTL-OFC-02-03" onClick={() => board && go(stepDate(board.date, 1))}><Icon name="chevRight" /></button>
          {today ? <button type="button" className="btn sm dis" aria-disabled="true" data-ctl="CTL-OFC-02-02">{t('board.today')}</button>
            : <button type="button" className="btn sm" data-ctl="CTL-OFC-02-02" onClick={() => go('today')}>{t('board.today')}</button>}
        </div>
        {summary}
        <a className="btn primary" data-ctl="CTL-OFC-02-05" href={`/office/jobs/new${board ? `?date=${board.date}` : ''}`}><Icon name="plus" />{t('board.newJob')}</a>
      </div>
      {offline ? (
        <div className="offbar" role="alert"><Icon name="alert" />{t('board.offline')}<button type="button" className="btn sm" data-ctl="CTL-CMP-12-02" onClick={() => void read()}>{t('shell.error.tryAgain')}</button></div>
      ) : null}
      <div className={mapLarge && !mapHidden ? 'work maplarge' : 'work'}>
        <section className="panel boardp" aria-label={t('board.technicians')} hidden={mapLarge && !mapHidden}>
          <div className="ph">
            <h2>{t('board.technicians')}</h2>
            <span className="muted small" data-ctl="CTL-OFC-02-19">{board ? t('board.onShift', { count: board.onShift }) : null}</span>
            <div className="seg" role="radiogroup" aria-label={t('board.view')} data-ctl="CTL-OFC-02-20">
              <span className="on" role="radio" aria-checked="true">{t('board.viewDay')}</span>
              <span role="radio" aria-checked="false" tabIndex={0} onClick={openWeek} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWeek(); } }}>{t('board.viewWeek')}</span>
            </div>
            {offline ? <button type="button" className="btn sm dis" aria-disabled="true" data-ctl="CTL-OFC-02-32"><Icon name="clock" />{t('board.addBlock')}</button>
              : <button type="button" className="btn sm" data-ctl="CTL-OFC-02-32" onClick={openAddBlock} disabled={!board || board.technicians.length === 0}><Icon name="clock" />{t('board.addBlock')}</button>}
            <LiveIndicator state={live} onRefresh={() => window.location.reload()} />
            <span className="grow" />
            <div className="legend" data-ctl="CTL-OFC-02-17" role="list" aria-label={t('board.legend')}>
              {(['sched', 'way', 'site', 'done', 'risk', 'late'] as const).map((k) => (
                <span key={k} className="k" role="listitem"><span className={`sw ${k}`} />{t(LEGEND[k])}</span>
              ))}
              <span className="k" role="listitem"><span className="sw off" />{t('board.legend.outside')}</span>
            </div>
            {mapButton}
          </div>
          {timeline}
        </section>
        {mapHidden ? null : (
          <MapPanel branch={branch} board={board} boardFailed={failed} vans={vans} shows={shows} skill={skill} tab={tab} selected={selectedVan} attention={attention}
            large={mapLarge} onLarge={(on) => {
              setMapLarge(on);
              // Safari does not focus a button on a click: the toggle takes focus itself, so it is where the keyboard is in both directions.
              requestAnimationFrame(() => document.querySelector<HTMLElement>('.mapp [data-large-toggle]')?.focus());
            }} onHide={() => hideMap(true)} onShows={setShows} onSkill={setSkill} onTab={setTab} onSelect={setSelectedVan} onRetryVans={readVans} onRetryBoard={read}
            onOpenJob={(jobNumber, el) => setPop({ kind: 'job', jobNumber, anchor: el })} />
        )}
      </div>
      {pop?.kind === 'job' ? (
        <JobPopover job={popJob} technician={popJob ? techName(popJob.technicianId) : null} anchor={pop.anchor} canReassign={!offline && popJob !== null && draggable(popJob)}
          onReassign={() => popJob && void openReassign(popJob)} onClose={() => setPop(null)} />
      ) : null}
      {pop?.kind === 'block' ? (
        <BlockPopover block={blockView(popBlock)} anchor={pop.anchor} online={!offline} onClose={() => setPop(null)}
          onChange={() => openChangeBlock(pop.blockId)}
          onDelete={() => popBlock && setModal({ kind: 'delete', block: popBlock.block, technicianId: popBlock.technicianId, deleting: false })} />
      ) : null}
      {modal?.kind === 'reassign' && board ? (
        <ReassignDialog job={modal.job} current={modal.job.technicianId} state={modal.state} date={shortDate(board.date)}
          onPick={(id) => void pickReassign(id)} onSubmit={submitReassign} onClose={() => setModal(null)} />
      ) : null}
      {modal?.kind === 'conflict' ? (
        <ConflictDialog subject={modal.retry.kind} message={conflictMessage(modal)} again={modal.again} resending={modal.resending} onAnyway={anyway} onKeep={keep} />
      ) : null}
      {modal?.kind === 'block' && board ? (
        <BlockDialog mode={modal.mode} form={modal.form} technicians={workingTechs} dateText={dateText(board.date)} errors={modal.errors} overlap={modal.overlap} saving={modal.saving}
          changed={modal.block !== null && (modal.form.technicianId !== (findBlock(board, modal.block.blockId)?.technicianId ?? '') || modal.form.start !== hhmm(modal.block.start) || modal.form.end !== hhmm(modal.block.end))}
          onChange={(form) => setModal({ ...modal, form, overlap: null })} onSave={() => void saveBlock()} onClose={() => setModal(null)} />
      ) : null}
      {modal?.kind === 'delete' && board ? (
        // F-1787: like the popover, the message reads the block as the board has it now (a move that lands while it is open
        // changes the time it frees); the copy taken at Delete stands in only once the block is gone from the board.
        <DeleteBlockDialog block={blockView(findBlock(board, modal.block.blockId) ?? { block: modal.block, technician: techName(modal.technicianId) ?? '' }) as BlockView} deleting={modal.deleting}
          onConfirm={() => void confirmDelete()} onClose={() => setModal(null)} />
      ) : null}
      {fixed?.extra ?? null}
    </OfficeFrame>
  );
}

const LEGEND = {
  sched: 'status.job.scheduled', way: 'status.job.onTheWay', site: 'status.job.onSite', done: 'status.job.done', risk: 'status.timing.atRisk', late: 'status.timing.late',
} as const satisfies Record<string, MessageKey>;

/** A wire time moved to another HH:MM on the same day and zone (the optimistic block position). */
function retime(wire: string, hm: string): string {
  const z = Temporal.ZonedDateTime.from(wire);
  const [h, m] = hm.split(':').map(Number) as [number, number];
  return z.with({ hour: h, minute: m, second: 0 }).toString();
}
