// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-GATE-01 in each state its frame shows, for the look comparator (ci/look-values/auth.pw.test.ts)
// and the page walkers. One route per screen so each loads only its own frame's sheets. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { AccessCodeScreen } from '../../../../src/auth/AccessCodeScreen.tsx';
import { APP_INFO } from '../../../../src/shell/preview-fixtures.ts';

export const dynamic = 'force-dynamic';

const OFF = { ...APP_INFO, demoMode: false };

export default async function GatePreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  switch (name) {
    case 'empty':
      return <AccessCodeScreen appInfo={OFF} reader={false} />;
    case 'checking':
      return <AccessCodeScreen state="checking" typed="brightwater-2026" appInfo={OFF} reader={false} />;
    case 'wrong':
      return <AccessCodeScreen state="wrong" typed="brightwatr-2026" appInfo={OFF} reader={false} />;
    case 'failed':
      return <AccessCodeScreen state="failed" typed="brightwater-2026" appInfo={OFF} reader={false} />;
    default:
      notFound();
  }
}
