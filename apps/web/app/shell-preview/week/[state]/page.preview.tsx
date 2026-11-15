// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-34 in each state its frame shows (success, loading, empty, error, live), for the look
// comparator (ci/look-values/week.pw.test.ts) and the page walkers. Every state is fixed; the release route is /office/board/week.
import { notFound } from 'next/navigation';
import { OfficeFrame } from '../../../../src/shell/Frames.tsx';
import { APP_INFO, CLOCK_RUNNING, MANAGER } from '../../../../src/shell/preview-fixtures.ts';
import { WEEK_EMPTY_FIXTURE, WEEK_FIXTURE, WEEK_LIVE_CHANGED, WEEK_LIVE_FIXTURE } from '../../../../src/week/week-fixtures.ts';
import { WeekView } from '../../../../src/week/WeekView.tsx';

export const dynamic = 'force-dynamic';

export default async function WeekPreview({ params }: { params: Promise<{ state: string }> }) {
  const { state } = await params;
  const common = { branch: 'columbus', week: '2026-09-14', dayFrom: '2026-09-15', liveTime: '10:28 AM', liveState: 'live' as const };
  let view;
  switch (state) {
    case 'success':
      view = <WeekView {...common} state="ready" data={WEEK_FIXTURE} />;
      break;
    case 'live':
      view = <WeekView {...common} state="ready" data={WEEK_LIVE_FIXTURE} changed={new Set(WEEK_LIVE_CHANGED)} />;
      break;
    case 'loading':
      view = <WeekView {...common} state="loading" data={null} />;
      break;
    case 'empty':
      view = <WeekView {...common} branch="springfield" state="empty" data={WEEK_EMPTY_FIXTURE} />;
      break;
    case 'error':
      view = <WeekView {...common} state="error" data={null} />;
      break;
    default:
      notFound();
  }
  return (
    <OfficeFrame screen="SCR-OFC-34" me={MANAGER} clock={CLOCK_RUNNING} appInfo={APP_INFO} reader={false}>
      {view}
    </OfficeFrame>
  );
}
