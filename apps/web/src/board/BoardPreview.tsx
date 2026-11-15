// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Harness build only (imported by app/shell-preview/board/[state]/page.preview.tsx): SCR-OFC-02 and its 6 hosted screens in
// each state DK-85 draws, on the frame's own sample day (preview-fixtures.ts), for the look comparator
// (ci/look-values/board.pw.test.ts) and the page walkers. Each state is fixed: no read, no stream, no write.
import type { ReactNode } from 'react';
import { ToastView } from '../shell/Announcer.tsx';
import { OfficeFrame } from '../shell/Frames.tsx';
import { useT } from '../shell/intl.tsx';
import { CLOCK_RUNNING, MANAGER } from '../shell/preview-fixtures.ts';
import type { Suggested } from './api.ts';
import { BoardScreen } from './BoardScreen.tsx';
import {
  BlockDialog, BlockPopover, ConflictDialog, DeleteBlockDialog, HostedScreenAttr, JobPopover, ReassignDialog, useConflictText, type BlockView, type ReassignState,
} from './Dialogs.tsx';
import type { Board, BoardJob } from './model.ts';
import { flaggedWithEntries, sampleBoard, sampleVans, subBoard, wireAt } from './preview-fixtures.ts';
import { Timeline, type Drag } from './Timeline.tsx';

import { type BoardPreviewState } from './preview-fixtures.ts';

const nop = () => undefined;
const reyes = (b: Board): BoardJob => b.technicians.flatMap((x) => x.jobs).find((j) => j.customerName === 'Reyes') as BoardJob;
const carmen = (b: Board): BoardJob => ({ ...reyes(b), jobNumber: 24805, customerName: 'Carmen Reyes' });
const luisDrag = (b: Board): Drag => ({ kind: 'job', job: reyes(b), target: { kind: 'tech', id: 'ortega' }, preview: { state: 'ok', arrivesAbout: wireAt(11.58), insideWindow: true } });

/** DK-85 reassign list: Greg Hoffman (now), Luis Ortega, Kevin Doyle, 4 of 5 each. */
const LIST: Suggested[] = [
  ['hoffman', 'Greg Hoffman', '5', 'plumbing'], ['ortega', 'Luis Ortega', '18', 'heating_cooling'], ['doyle', 'Kevin Doyle', '27', 'plumbing'],
].map(([id, name, van, skill]) => ({ id: id!, name: name!, van: van!, skills: [skill!], minutesFromStopBefore: 12, stopBefore: null, load: { jobs: 4, capacity: 5 }, room: true, suggested: true, reason: null }));
const choosing = (pick: string | undefined, preview: number | null, saving = false): ReassignState => ({
  step: 'choosing', list: LIST, pick, saving, message: null, preview: preview === null ? null : { arrivesAbout: wireAt(preview), insideWindow: true, window: { start: wireAt(10), end: wireAt(12) } },
});
const SUPPLY = (start: number, end: number, label = 'Supply run'): BlockView => ({ label, place: 'Supply house', technician: 'Kevin Doyle', date: 'Tue, Sep 15', start: wireAt(start), end: wireAt(end) });
const CONFLICT = { by: 'Keisha Thompson', byKind: 'office' as const, change: 'assigned', technician: 'Kevin Doyle', at: wireAt(10 + 29 / 60), currentVersion: 3 };
const AGAIN = { by: 'Tanya Brooks', byKind: 'office' as const, change: 'assigned', technician: null, at: wireAt(10.5), currentVersion: 4 };

/** The hosted screen of a state, drawn in place (DK-85 draws each in its own tile). */
function Hosted({ state, board, text }: { state: BoardPreviewState; board: Board; text: (c: typeof CONFLICT | typeof AGAIN) => string }): ReactNode {
  const t = useT();
  const job = carmen(board);
  const greg = 'Greg Hoffman';
  const supply = t('board.blockdlg.suggestSupply');
  const blockForm = (start: string, end: string) => ({ technicianId: 'doyle', label: start ? supply : '', place: start ? 'Supply house' : '', start, end });
  const techs = board.technicians.map((x) => ({ id: x.id, name: x.name }));
  const updated = { ...job, technicianId: 'ortega', status: 'on_the_way' as const, timing: 'onTime' as const, eta: wireAt(11.58), lateTextSent: false };
  switch (state) {
    case 'job-open': return <JobPopover inline job={job} technician={greg} canReassign onReassign={nop} onClose={nop} />;
    case 'job-updated': return <JobPopover inline job={updated} technician="Luis Ortega" canReassign onReassign={nop} onClose={nop} />;
    case 'job-gone': return <JobPopover inline job={null} technician={null} canReassign={false} onReassign={nop} onClose={nop} />;
    case 'reassign-loading': return <ReassignDialog inline job={job} current="hoffman" date="Tue, Sep 15" state={{ step: 'loading' }} onPick={nop} onSubmit={nop} onClose={nop} />;
    case 'reassign-choosing': return <ReassignDialog inline job={job} current="hoffman" date="Tue, Sep 15" state={choosing('hoffman', null)} onPick={nop} onSubmit={nop} onClose={nop} />;
    case 'reassign-previewing': return <ReassignDialog inline job={job} current="hoffman" date="Tue, Sep 15" state={choosing('ortega', 11.58)} onPick={nop} onSubmit={nop} onClose={nop} />;
    case 'reassign-no-others': return <ReassignDialog inline job={job} current="hoffman" date="Tue, Sep 15" state={{ step: 'choosing', list: [], pick: null, preview: null, saving: false, message: null }} onPick={nop} onSubmit={nop} onClose={nop} />;
    case 'reassign-saving': return <ReassignDialog inline job={job} current="hoffman" date="Tue, Sep 15" state={choosing('doyle', 11 + 50 / 60, true)} onPick={nop} onSubmit={nop} onClose={nop} />;
    case 'conflict-shown': return <ConflictDialog inline subject="job" message={text(CONFLICT)} again={false} resending={false} onAnyway={nop} onKeep={nop} />;
    case 'conflict-resending': return <ConflictDialog inline subject="job" message={text(CONFLICT)} again={false} resending onAnyway={nop} onKeep={nop} />;
    case 'conflict-again': return <ConflictDialog inline subject="job" message={text(AGAIN)} again resending={false} onAnyway={nop} onKeep={nop} />;
    case 'conflict-gone': return <ConflictDialog inline subject="job" message={null} again={false} resending={false} onAnyway={nop} onKeep={nop} />;
    case 'block-adding': return <BlockDialog inline focus="label" mode="add" form={blockForm('', '')} technicians={techs} dateText="Tue, Sep 15, 2026" errors={{}} overlap={null} saving={false} changed={false} onChange={nop} onSave={nop} onClose={nop} />;
    case 'block-changing': return <BlockDialog inline mode="change" form={blockForm('14:00', '14:30')} technicians={techs} dateText="Tue, Sep 15, 2026" errors={{}} overlap={null} saving={false} changed={false} onChange={nop} onSave={nop} onClose={nop} />;
    case 'block-saving': return <BlockDialog inline mode="change" form={blockForm('15:00', '15:30')} technicians={techs} dateText="Tue, Sep 15, 2026" errors={{}} overlap={null} saving changed onChange={nop} onSave={nop} onClose={nop} />;
    case 'block-overlap': return <BlockDialog inline mode="change" form={blockForm('13:30', '14:00')} technicians={techs} dateText="Tue, Sep 15, 2026" errors={{}} overlap={t('board.refused.overJob', { technician: 'Kevin Doyle', customer: 'Castillo', span: '1:15-2:45 PM' })} saving={false} changed onChange={nop} onSave={nop} onClose={nop} />;
    case 'blockpop-open': return <BlockPopover inline online block={SUPPLY(14, 14.5, supply)} onChange={nop} onDelete={nop} onClose={nop} />;
    case 'blockpop-updated': return <BlockPopover inline online block={SUPPLY(15, 15.5, supply)} onChange={nop} onDelete={nop} onClose={nop} />;
    case 'blockpop-gone': return <BlockPopover inline online block={null} onChange={nop} onDelete={nop} onClose={nop} />;
    case 'delete-asking': return <DeleteBlockDialog inline block={SUPPLY(14, 14.5, supply)} deleting={false} onConfirm={nop} onClose={nop} />;
    case 'delete-deleting': return <DeleteBlockDialog inline block={SUPPLY(14, 14.5, supply)} deleting onConfirm={nop} onClose={nop} />;
    case 'reassign-done': return <ToastView text={t('board.toast.reassigned', { job: 24825, name: 'Kevin Doyle' })} />;
    case 'conflict-done': return <ToastView text={t('board.toast.moved', { name: 'Luis Ortega', time: '11:35 AM' })} />;
    case 'block-done': return <ToastView text={t('board.toast.blockAdded', { label: supply, name: 'Kevin Doyle', span: '3:00-3:30 PM' })} />;
    case 'delete-done': return <ToastView text={t('board.toast.blockDeleted', { label: supply })} />;
    default: return null;
  }
}

/** The hosted screen each solo state draws alone (the page walkers' host-page rows). */
export const SOLO_SCREEN: Partial<Record<BoardPreviewState, string>> = {
  'job-open': 'SCR-OFC-29', 'reassign-previewing': 'SCR-OFC-18', 'conflict-shown': 'SCR-OFC-19', 'block-adding': 'SCR-OFC-31',
  'blockpop-open': 'SCR-OFC-32', 'delete-asking': 'SCR-OFC-33',
};

/** The frame's block labels, as an office working in the page's language typed them (Pickup, Supply run). */
function localized(b: Board, label: (english: string) => string): Board {
  return { ...b, technicians: b.technicians.map((x) => ({ ...x, blocks: x.blocks.map((bl) => ({ ...bl, label: label(bl.label) })) })) };
}

export function BoardPreview({ state, solo = false }: { state: BoardPreviewState; solo?: boolean }) {
  const t = useT();
  const label = (english: string) => (english === 'Pickup' ? t('board.blockdlg.suggestPickup') : english === 'Supply run' ? t('board.blockdlg.suggestSupply') : english);
  const soloScreen = solo ? SOLO_SCREEN[state] : undefined;
  if (soloScreen) {
    // A hosted screen alone, in an office frame named for it (its own root is the frame's).
    return (
      <HostedScreenAttr.Provider value={false}>
        <OfficeFrame screen={soloScreen} me={MANAGER} clock={CLOCK_RUNNING} reader={false} appInfo={null}>
          <HostedState state={state} board={localized(sampleBoard(), label)} />
        </OfficeFrame>
      </HostedScreenAttr.Provider>
    );
  }
  const full = localized(sampleBoard(), label);
  // The frame's map panel at rest: Maria's van selected, Needs attention open (DK-85's main screen).
  const fixed = { me: MANAGER, clock: CLOCK_RUNNING, vans: sampleVans(full), selected: 'santos' };
  const mini = (ids: string[], extra: Partial<Parameters<typeof Timeline>[0]> = {}, jobs = true) => (
    <div className="mini" data-bw-mini={ids.join(' ')}>
      <Timeline board={subBoard(full, ids, jobs)} who={170} rowH={50} unassigned={false} span={{ start: 8, end: 15 }} now={null} {...extra} />
    </div>
  );
  switch (state) {
    case 'success': return <BoardScreen fixed={{ ...fixed, board: full }} />;
    case 'moving': return <BoardScreen fixed={{ ...fixed, board: full, scene: luisDrag(full), moving: new Map([[reyes(full).jobNumber, '__dragged__']]) }} />;
    case 'loading': return <BoardScreen fixed={{ ...fixed, board: 'loading' }} />;
    case 'no-technicians': return <BoardScreen fixed={{ ...fixed, board: { ...full, date: '2026-09-20', today: false, dayMode: 'closed', onShift: 0, technicians: [], unassigned: [] } }} />;
    case 'marking': return <BoardScreen fixed={{ ...fixed, board: full, marking: 'c-okafor', extra: <div className="bw-hosted"><ToastView text={t('board.toast.handled')} /></div> }} />;
    case 'offline': return <BoardScreen fixed={{ ...fixed, board: full, offline: true }} />;
    case 'previewing': return <BoardScreen fixed={{ ...fixed, board: full, extra: mini(['hoffman', 'ortega'], { span: { start: 7, end: 18 }, scene: luisDrag(full) }) }} />;
    case 'no-jobs': return <BoardScreen fixed={{ ...fixed, board: full, extra: mini(['bell', 'carter', 'doyle'], { noJobs: true }, false) }} />;
    case 'partial': return <BoardScreen fixed={{ ...fixed, board: full, vans: 'failed', selected: null }} />;
    case 'map-hidden': return <BoardScreen fixed={{ ...fixed, board: full, hidden: true }} />;
    case 'jobs-on-map': return <BoardScreen fixed={{ ...fixed, board: full, shows: 'jobs', selected: null }} />;
    case 'skill-filter': return <BoardScreen fixed={{ ...fixed, board: full, skill: 'plumbing', tab: 'all', selected: null }} />;
    case 'flagged-entries': return <BoardScreen fixed={{ ...fixed, board: flaggedWithEntries(full), selected: null }} />;
    default: return <BoardScreen fixed={{ ...fixed, board: full, extra: <HostedState state={state} board={full} /> }} />;
  }
}

/** A hosted state: the dialog or popover in place, with the conflict text the screen itself composes (useConflictText). */
function HostedState({ state, board }: { state: BoardPreviewState; board: Board }) {
  const f = useConflictText();
  const text = (c: typeof CONFLICT | typeof AGAIN) => f(c, { kind: 'job', mine: 'Luis Ortega' }, c === AGAIN);
  return <div className="bw-hosted" data-bw-hosted={state}><Hosted state={state} board={board} text={text} /></div>;
}
