// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-20 Reschedule job as a dialog any office page mounts by job number (UI-SPECIFICATION SCR-OFC-20, Route: none, a dialog on
// SCR-OFC-03 and SCR-OFC-09). It reads the job (API-23), then runs the same RescheduleDialog the job page runs (API-29 days, API-24
// the move). onDone receives API-24's answer, so the host does its own follow-up: the call list (P4-MESSAGES) records its
// Reschedule outcome (API-38, CTL-OFC-20-03) and shows the Outcome not saved state itself when that record fails.
import '../shell/css/office.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '../board/Dialogs.tsx';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { jobApi, type JobApi } from './api.ts';
import { RescheduleDialog, type RescheduleAnswer } from './Dialogs.tsx';
import type { Job, Shown } from './model.ts';

export interface RescheduleJobDialogProps {
  jobNumber: number;
  /** Closed with no change (Cancel, Escape, the close button). */
  onClose: () => void;
  /** SCR-OFC-19's Keep their change: closes and re-reads (default: onClose). */
  onKeep?: () => void;
  /** After API-24 answered 200: its answer, and the toast the job page shows for it (the host may show its own). */
  onDone: (answer: RescheduleAnswer, toast: Shown) => void;
  /** The day range API-29 is read for (default: the server's own range for the office channel). */
  today?: string;
  horizon?: string;
  /** Tests and previews: a stand-in for the calls. */
  api?: JobApi;
}

export function RescheduleJobDialog({ jobNumber, onClose, onKeep, onDone, today = '2000-01-01', horizon = '2999-12-31', api: given }: RescheduleJobDialogProps) {
  const t = useT();
  const api = useMemo(() => given ?? jobApi(), [given]);
  const [job, setJob] = useState<Job | 'loading' | 'error'>('loading');
  const load = () => {
    setJob('loading');
    void api.job(jobNumber).then((r) => setJob(r.ok ? r.data : 'error'));
  };
  useEffect(load, [api, jobNumber]);
  // API-24's answer reaches onRescheduled just before onDone, in the same handler.
  const answer = useRef<RescheduleAnswer | null>(null);
  if (job === 'loading' || job === 'error') {
    return (
      <Dialog title={t('job.reschedule.titlePlain')} closeCtl="CTL-OFC-20-04" onClose={onClose} screen="SCR-OFC-20" wide
        foot={<button type="button" className="btn" data-ctl="CTL-OFC-20-04" onClick={onClose}>{t('common.cancel')}</button>}>
        {job === 'loading'
          ? <><span className="r1-skel bw-w-30" /><span className="r1-skel" /><span className="r1-skel" /><span className="r1-skel" /><span className="r1-skel" /></>
          : <div className="r1-errpanel" role="alert"><Icon name="alert" /><div><b>{t('job.reschedule.loadError')}</b><button type="button" className="btn sm" onClick={load}>{t('job.tryAgain')}</button></div></div>}
      </Dialog>
    );
  }
  return (
    <RescheduleDialog job={job} api={api} today={today} horizon={horizon} onClose={onClose} {...(onKeep ? { onKeep } : {})}
      onRescheduled={(a) => { answer.current = a; }} onDone={(toast) => onDone(answer.current as RescheduleAnswer, toast)} />
  );
}
