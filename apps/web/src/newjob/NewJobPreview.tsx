// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Harness build only (imported by app/shell-preview/newjob/[state]/page.preview.tsx): SCR-OFC-04 in each state DK-89 draws, with the
// frame's fixed data (preview-data.ts) and handlers that do nothing, for the look comparator (ci/look-values/newjob.pw.test.ts) and the
// page walkers. Each state is the page itself (the same NewJobView the release route draws), never a copy.
import '../shell/css/office.ts';
import '../../styles/page-office-new-job.css';
import '../../styles/app/new-job.css';
import { ToastView } from '../shell/Announcer.tsx';
import { OfficeFrame } from '../shell/Frames.tsx';
import { useT } from '../shell/intl.tsx';
import { APP_INFO, CLOCK_RUNNING, MANAGER } from '../shell/preview-fixtures.ts';
import { NO_PICKS, type Picks } from './model.ts';
import type { NewJobPreviewState } from './preview-data.ts';
import { NJ_CUSTOMER, NJ_DAYS, NJ_DAYS_NONE, NJ_PICKED, NJ_SERVICES, NJ_TECHS } from './preview-data.ts';
import { DoneTrail } from './DoneTrail.tsx';
import { NewJobView, type ViewProps } from './NewJobView.tsx';


const nop = () => undefined;
const FRAME = { clock: CLOCK_RUNNING, appInfo: APP_INFO, reader: false } as const;
const ON: ViewProps['on'] = {
  query: nop, pickHit: nop, retrySearch: nop, retryCustomer: nop, newCustomer: nop, change: nop, service: nop, equipment: nop, problem: nop, day: nop, window: nop,
  technician: nop, retryDays: nop, retryTechs: nop, retryServices: nop, schedule: nop, leave: nop,
};
const BASE: ViewProps = {
  query: '', search: { kind: 'idle' }, customer: { kind: 'picked', detail: NJ_CUSTOMER }, services: NJ_SERVICES, picks: NJ_PICKED, days: NJ_DAYS,
  techs: { kind: 'ready', technicians: NJ_TECHS.technicians, serviceSkill: NJ_TECHS.serviceSkill }, saving: false, shown: null, branchName: 'Columbus', today: '2026-09-15', on: ON,
};

function viewOf(state: NewJobPreviewState): ViewProps {
  switch (state) {
    case 'start': return { ...BASE, customer: { kind: 'none' }, picks: NO_PICKS, days: null, techs: { kind: 'waiting' } };
    case 'no-match': return { ...BASE, customer: { kind: 'none' }, query: 'hendrix', search: { kind: 'none' }, picks: NO_PICKS, days: null, techs: { kind: 'waiting' } };
    case 'no-windows': {
      const picks: Picks = { ...NJ_PICKED, day: '2026-09-16', windowId: null, technicianId: null };
      return { ...BASE, picks, days: NJ_DAYS_NONE, techs: { kind: 'waiting' } };
    }
    case 'saving': return { ...BASE, saving: true };
    case 'input-kept': {
      // The window filled a moment ago: it turns Full, its pick is dropped, every other field keeps its value.
      const days = NJ_DAYS.map((d) => (d.date === NJ_PICKED.day ? { ...d, windows: d.windows.map((w) => (w.windowId === 'w12' ? { ...w, state: 'full' as const, left: 0 } : w)) } : d));
      return { ...BASE, days, picks: { ...NJ_PICKED, windowId: null, technicianId: null }, techs: { kind: 'waiting' }, shown: { key: 'job.refused.windowFull' } };
    }
    default: return BASE;
  }
}

/**
 * Done: the new job's page (SCR-OFC-03, P4-JOB's look cases) opens with its Jobs / Job <n> trail and CMP-11's words about the confirmation
 * text. The page itself is not drawn here: its sheet would replace this one's rules. The trail, the same component the job page draws, and
 * the toast are, in the frame's place for them.
 */
function Done() {
  const t = useT();
  return (
    <OfficeFrame screen="SCR-OFC-04" me={MANAGER} {...FRAME}>
      <div className="bw-hosted" data-bw-hosted="done"><DoneTrail jobNumber={24877} /><ToastView text={t('newjob.done.sent', { n: 24877, name: 'Harold' })} /></div>
    </OfficeFrame>
  );
}

export function NewJobPreview({ state }: { state: NewJobPreviewState }) {
  if (state === 'done') return <Done />;
  return (
    <OfficeFrame screen="SCR-OFC-04" me={MANAGER} {...FRAME}>
      <NewJobView {...viewOf(state)} />
    </OfficeFrame>
  );
}
