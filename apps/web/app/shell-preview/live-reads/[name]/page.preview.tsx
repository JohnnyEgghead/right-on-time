// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): the office screens whose reads change with what the person does, rendered LIVE (not a fixed state), so
// ci/page-walkers/newest-answer.pw.test.ts can answer their reads in a chosen order and see which answer the screen shows (P10-NEWEST-ANSWER).
// Never a release route; the page walkers' wiring does not list it (it is a test page, not a screen).
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { BoardScreen } from '../../../../src/board/BoardScreen.tsx';
import { ClockScreen } from '../../../../src/clock/ClockScreen.tsx';
import { UsersScreen } from '../../../../src/accounts/UsersScreen.tsx';
import { DuplicatesScreen } from '../../../../src/import/DuplicatesScreen.tsx';
import { HistoryScreen } from '../../../../src/import/HistoryScreen.tsx';
import { MessagesScreen } from '../../../../src/messages/MessagesScreen.tsx';
import { DemoStrip } from '../../../../src/shell/DemoStrip.tsx';
import { OfficeTopBar } from '../../../../src/shell/OfficeTopBar.tsx';
import { MANAGER } from '../../../../src/shell/preview-fixtures.ts';
import { WindowsScreen } from '../../../../src/windows/WindowsScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function LiveReadsPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  switch (name) {
    case 'windows':
      return <Suspense><WindowsScreen /></Suspense>;
    case 'messages':
      return <Suspense><MessagesScreen /></Suspense>;
    case 'duplicates':
      return <DuplicatesScreen />;
    case 'history':
      return <HistoryScreen />;
    case 'users':
      return <UsersScreen />;
    case 'demo-strip':
      return <DemoStrip live />;
    case 'board':
      return <Suspense><DemoStrip live /><BoardScreen /></Suspense>;
    case 'clock':
      return <ClockScreen />;
    case 'top-bar':
      return <OfficeTopBar me={MANAGER} liveAlerts={false} alertCount={0} />;
    case 'bell':
      return <OfficeTopBar me={MANAGER} />;
    default:
      notFound();
  }
}
