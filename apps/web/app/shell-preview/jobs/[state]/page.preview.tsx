// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-30 in each state its frame shows (success, loading, empty tab, no results, exporting, error, live
// row), for the look comparator (ci/look-values/jobs.pw.test.ts) and the page walkers. Every state is fixed; the release route is /office/jobs.
import { notFound } from 'next/navigation';
import { JobsView, type JobsViewProps } from '../../../../src/jobs/JobsView.tsx';
import { JOBS_EMPTY, JOBS_LIVE, JOBS_LIVE_CHANGED, JOBS_NO_RESULTS, JOBS_SERVICE_WORDS, JOBS_SUCCESS, JOBS_SUCCESS_ES } from '../../../../src/jobs/jobs-fixtures.ts';
import { OfficeFrame } from '../../../../src/shell/Frames.tsx';
import { requestLang } from '../../../../src/shell/i18n-server.ts';
import { APP_INFO, CLOCK_RUNNING, MANAGER } from '../../../../src/shell/preview-fixtures.ts';

export const dynamic = 'force-dynamic';

const BASE: JobsViewProps = {
  state: 'ready', data: JOBS_SUCCESS, branch: 'columbus', tab: 'all', query: '', date: 'upcoming', technicianId: '', status: '', serviceId: '', sort: 'attention', page: 1,
  live: 'live', serviceWords: JOBS_SERVICE_WORDS,
};

export default async function JobsPreview({ params }: { params: Promise<{ state: string }> }) {
  const { state } = await params;
  // F-1736: the rows' problem words in the page's language, as the service words are.
  const base: JobsViewProps = (await requestLang()) === 'es' ? { ...BASE, data: JOBS_SUCCESS_ES } : BASE;
  let view: JobsViewProps;
  switch (state) {
    case 'success':
      view = base;
      break;
    case 'loading':
      view = { ...BASE, state: 'loading', data: null };
      break;
    case 'empty':
      view = { ...BASE, tab: 'late', data: JOBS_EMPTY };
      break;
    case 'noresults':
      view = { ...BASE, query: 'Hendricks', data: JOBS_NO_RESULTS };
      break;
    case 'exporting':
      view = { ...base, exporting: true };
      break;
    case 'error':
      view = { ...BASE, state: 'error', data: null };
      break;
    case 'live':
      view = { ...BASE, tab: 'not-in-billing', data: JOBS_LIVE, changed: new Set(JOBS_LIVE_CHANGED) };
      break;
    default:
      notFound();
  }
  return (
    <OfficeFrame screen="SCR-OFC-30" me={MANAGER} clock={CLOCK_RUNNING} appInfo={APP_INFO} reader={false} bar={{ alertCount: 2, currentPath: '/office/jobs' }}>
      <JobsView {...view} />
    </OfficeFrame>
  );
}
