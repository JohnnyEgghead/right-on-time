// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Harness build only (imported by app/shell-preview/job/[state]/page.preview.tsx): SCR-OFC-03 and its 7 dialogs in each state
// DK-87 draws, on the frame's own job (preview-fixtures.ts), for the look comparator (ci/look-values/job.pw.test.ts) and the page
// walkers. Each state is fixed: the reads answer the frame's data, a write never answers, there is no live stream.
import type { ReactNode } from 'react';
import { HostedScreenAttr } from '../board/Dialogs.tsx';
import { ToastView } from '../shell/Announcer.tsx';
import { OfficeFrame } from '../shell/Frames.tsx';
import { useT } from '../shell/intl.tsx';
import type { Me } from '../shell/OfficeTopBar.tsx';
import { APP_INFO, CLOCK_RUNNING, MANAGER } from '../shell/preview-fixtures.ts';
import { CancelDialog, EditDetailsDialog, EquipmentDialog, NoteDialog, RescheduleDialog, TextDialog } from './Dialogs.tsx';
import { FinishDialog } from './FinishDialog.tsx';
import { JobScreen } from './JobScreen.tsx';
import { CONTROL_CONTRACT, type Job, type Lines } from './model.ts';
import { HAROLD, HAROLD_WAY, previewApi, RESCHEDULE_DONE_LINE, type JobPreviewState } from './preview-fixtures.ts';
import { wireAt } from '../board/preview-fixtures.ts';

/** The frame's signed-in person, Dana R. (Manager), with every role-gated control of the page (F-565). */
export const JOB_MANAGER: Me = { ...MANAGER, permissions: [...MANAGER.permissions, ...Object.values(CONTROL_CONTRACT)] };

const nop = () => undefined;
const FRAME = { clock: CLOCK_RUNNING, appInfo: APP_INFO, reader: false } as const;
const T1 = 'Hi Harold, Maria is running about 10 minutes behind her last job. Thanks for your patience. Brightwater';
const T2 = 'Hi Harold, Maria is running about 10 minutes behind her last job, which took longer than planned because of a stuck valve. She is on her way now and will text when she is close. Brightwater';
const FILTER: Lines['parts'][number] = { partId: 'p-flt', name: 'Furnace filter 16x25x4 MERV 11', code: 'FLT-16254', quantity: 1 };
const LABOR = (parts: Lines['parts'] = []): Lines => ({ parts, noPartsUsed: false, hours: '1', minutes: '05' });

const closed = (status: Job['job']['status'], extra: Partial<Job['job']> = {}, rest: Partial<Job> = {}): Job =>
  ({ ...HAROLD, ...rest, job: { ...HAROLD.job, status, confirmed: false, ...extra } });
const DONE = closed('done', { endedAt: wireAt(12 + 49 / 60) }, {
  finish: { parts: [], noPartsUsed: true, laborMinutes: 65, workDone: ['Tune-up done, all readings normal', 'Cleaned the flame sensor', 'Replaced the 16x25x4 filter'] },
  // A preview holds no stored file: an empty key draws the line without the image, as DK-87 Done does.
  signature: { key: '', signedBy: 'Harold Jenkins', at: wireAt(12 + 49 / 60) }, billing: { state: 'in_billing', reasonKey: null },
});

/** The dialog or toast of a hosted state, drawn in place (DK-87 draws each in its own tile). */
function Hosted({ state }: { state: JobPreviewState }): ReactNode {
  const t = useT();
  const j = HAROLD;
  const c = { job: j, api: previewApi(), onClose: nop, onDone: nop, inline: true };
  const rs = { today: '2026-09-15', horizon: '2026-09-26' };
  const fin = (start: NonNullable<Parameters<typeof FinishDialog>[0]['start']>) => <FinishDialog mode="finish" jobNumber={j.job.jobNumber} job={j} api={previewApi()} onClose={nop} onDone={nop} inline start={start} />;
  switch (state) {
    case 'reschedule-loading': return <RescheduleDialog {...c} {...rs} api={previewApi({ availability: 'loading' })} />;
    case 'reschedule-choosing': return <RescheduleDialog {...c} {...rs} start={{ day: '2026-09-17', win: 'w10' }} />;
    case 'reschedule-no-room': return <RescheduleDialog {...c} {...rs} api={previewApi({ availability: 'full' })} />;
    case 'reschedule-saving': return <RescheduleDialog {...c} {...rs} start={{ day: '2026-09-17', win: 'w10', saving: true }} />;
    case 'reschedule-done': return <ToastView text={RESCHEDULE_DONE_LINE} />;
    case 'cancel-asking': return <CancelDialog {...c} />;
    case 'cancel-canceling': return <CancelDialog {...c} start={{ saving: true }} />;
    case 'cancel-done': return <ToastView text={t('job.cancel.done')} />;
    case 'finish-empty': return fin({ lines: LABOR() });
    case 'finish-no-match': return fin({ lines: LABOR(), find: 'flame rod' });
    case 'finish-invalid': return fin({ lines: LABOR(), msg: { on: 'parts', key: 'job.finish.partsRequired' } });
    case 'finish-saving': return fin({ lines: LABOR([FILTER]), saving: true });
    case 'finish-done': return <ToastView text={t('job.finish.done')} />;
    case 'edit-editing': return <EditDetailsDialog {...c} />;
    case 'edit-saving': return <EditDetailsDialog {...c} start={{ serviceId: 'heating_or_ac_fix', saving: true }} />;
    case 'edit-done': return <ToastView text={t('job.edit.done')} />;
    case 'text-empty': return <TextDialog {...c} />;
    case 'text-typing': return <TextDialog {...c} start={{ body: T1 }} />;
    case 'text-too-long': return <TextDialog {...c} start={{ body: T2 }} />;
    case 'text-sending': return <TextDialog {...c} start={{ body: T1, saving: true }} />;
    case 'text-sent': return <ToastView text={t('job.text.sent')} />;
    case 'text-held': return <ToastView text={t('job.text.held')} />;
    case 'text-refused': return <TextDialog {...c} start={{ body: T1, shown: { key: 'job.text.textsOff' } }} />;
    case 'note-empty': return <NoteDialog {...c} />;
    case 'note-typing': return <NoteDialog {...c} start={{ body: 'Gate code changed to 4471.' }} />;
    case 'note-saving': return <NoteDialog {...c} start={{ body: 'Gate code changed to 4471.', saving: true }} />;
    case 'changed': return <ToastView text={t('job.changed')} icon="info" />;
    case 'note-saved': return <ToastView text={t('job.note.saved')} />;
    case 'equipment-editing': return <EquipmentDialog {...c} equipmentId="eq-furnace" />;
    case 'equipment-saving': return <EquipmentDialog {...c} equipmentId="eq-furnace" start={{ details: '80,000 BTU, 96% efficient; filter 16x25x4 MERV 11', saving: true }} />;
    case 'equipment-saved': return <ToastView text={t('job.equipment.saved')} />;
    default: return null;
  }
}

/** The page state of each page-level preview state (the rest draw the Success page with a hosted dialog or toast over it). */
function pageOf(state: JobPreviewState): { job: Job | 'loading' | 'error'; way?: typeof HAROLD_WAY | null } {
  switch (state) {
    case 'loading': return { job: 'loading' };
    case 'error': return { job: 'error' };
    case 'panel-ended': return { job: closed('on_site', { arrivedAt: wireAt(10 + 39 / 60) }), way: null };
    case 'changed': return { job: { ...HAROLD, job: { ...HAROLD.job, confirmed: false, technician: { id: 'ortega', name: 'Luis Ortega', initials: 'LO', van: '18', skill: 'heating_cooling' } } }, way: { ...HAROLD_WAY, eta: wireAt(10 + 52 / 60), technician: { name: 'Luis Ortega', initials: 'LO', van: '18', skill: 'heating_cooling', phone: '(614) 555-0118' } } };
    case 'canceled': return { job: closed('canceled'), way: null };
    case 'done': return { job: DONE, way: null };
    case 'no-one-home': return { job: closed('no_one_home', {}, {}), way: null };
    // F-1543: a done job with no signature, no equipment, no past visits and no notes: every empty state and status line the page draws.
    case 'bare': return { job: { ...DONE, signature: null, equipment: [], history: { count: 0, fromOldSystem: false, visits: [] }, notes: [], photos: [] }, way: null };
    case 'partial': return { job: { ...HAROLD, photos: [{ key: 'ph1', by: 'Maria Santos', at: wireAt(10 + 41 / 60) }] } };
    default: return { job: HAROLD, way: HAROLD_WAY };
  }
}

const PAGE_STATES: ReadonlySet<JobPreviewState> = new Set(['success', 'loading', 'error', 'panel-ended', 'partial', 'canceled', 'done', 'no-one-home', 'bare']);

/** The screen each solo state draws alone (the page walkers' dialog rows: exactly 1 screen root). */
export const SOLO_SCREEN: Partial<Record<JobPreviewState, string>> = {
  'reschedule-choosing': 'SCR-OFC-20', 'cancel-asking': 'SCR-OFC-21', 'finish-empty': 'SCR-OFC-22', 'edit-editing': 'SCR-OFC-23',
  'text-typing': 'SCR-OFC-35', 'note-typing': 'SCR-OFC-36', 'equipment-editing': 'SCR-OFC-37',
};

export function JobPreview({ state, solo = false }: { state: JobPreviewState; solo?: boolean }) {
  const soloScreen = solo ? SOLO_SCREEN[state] : undefined;
  if (soloScreen) {
    return (
      <HostedScreenAttr.Provider value={false}>
        <OfficeFrame screen={soloScreen} me={JOB_MANAGER} {...FRAME}>
          <div className="bw-hosted" data-bw-hosted={state}><Hosted state={state} /></div>
        </OfficeFrame>
      </HostedScreenAttr.Provider>
    );
  }
  const page = pageOf(state);
  const hosted = PAGE_STATES.has(state) ? null : <div className="bw-hosted" data-bw-hosted={state}><Hosted state={state} /></div>;
  return (
    <JobScreen jobNumber={24830} me={JOB_MANAGER} api={previewApi()}
      fixed={{ job: page.job, onTheWay: page.way ?? null, frame: FRAME, extra: hosted }} />
  );
}
