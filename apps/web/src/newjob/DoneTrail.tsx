// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The New job page's Done state (SCR-OFC-04): the trail of the job page that Schedule opens, Jobs / Job <n> (CTL-OFC-04-12, CTL-OFC-03-01; DK-89's Done tile
// draws the slash). Jobs opens SCR-OFC-30 and Job <n> is the page shown, not a link. Its own file so the job page draws it without this
// page's view.
import { useT } from '../shell/intl.tsx';

export function DoneTrail({ jobNumber }: { jobNumber: number }) {
  const t = useT();
  return (
    <div className="crumbs" data-ctl="CTL-OFC-04-12">
      <a href="/office/jobs">{t('newjob.crumb.jobs')}</a>{' / '}<span>{t('job.crumb.job', { job: jobNumber })}</span>
    </div>
  );
}
