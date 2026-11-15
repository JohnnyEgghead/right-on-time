// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-EML-03 in each state its frame shows (ci/look-values/accounts.pw.test.ts, the walkers).
import { notFound } from 'next/navigation';
import { ForgotScreen, type ForgotState } from '../../../../src/accounts/ForgotScreen.tsx';
import { APP_INFO, CLOCK_RUNNING } from '../../../../src/shell/preview-fixtures.ts';

export const dynamic = 'force-dynamic';

const STATES: Record<string, ForgotState> = {
  sent: 'sent', default: 'default', sending: 'sending', noaccount: 'no_account', notavailable: 'not_available', off: 'turned_off',
};

export default async function ForgotPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = STATES[name];
  if (!state) notFound();
  const typed = state === 'default' ? '' : 'keisha.t@brightwater.example';
  return <ForgotScreen app="office" state={state} email={typed} link={state === 'sent' ? '/email/preview' : null} clock={CLOCK_RUNNING} appInfo={APP_INFO} />;
}
