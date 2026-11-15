// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-EML-01 in each state its frame shows (ci/look-values/accounts.pw.test.ts, the walkers).
import { notFound } from 'next/navigation';
import { EmailScreen, type EmailState } from '../../../../src/accounts/EmailScreen.tsx';
import { RESET_EMAIL } from '../../../../src/accounts/preview-fixtures.ts';
import { APP_INFO, CLOCK_RUNNING } from '../../../../src/shell/preview-fixtures.ts';

export const dynamic = 'force-dynamic';

const STATES: Record<string, EmailState> = { shown: 'shown', loading: 'loading', used: 'used', notvalid: 'not_valid' };

export default async function EmailPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = STATES[name];
  if (!state) notFound();
  return <EmailScreen token="preview" state={state} email={RESET_EMAIL} clock={CLOCK_RUNNING} appInfo={APP_INFO} />;
}
