// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-EML-02 in each state its frame shows (ci/look-values/accounts.pw.test.ts, the walkers).
import { notFound } from 'next/navigation';
import { DEREK_LINK } from '../../../../src/accounts/preview-fixtures.ts';
import { SetPasswordScreen, type SetPasswordState } from '../../../../src/accounts/SetPasswordScreen.tsx';
import { APP_INFO, CLOCK_RUNNING } from '../../../../src/shell/preview-fixtures.ts';

export const dynamic = 'force-dynamic';

const STATES: Record<string, SetPasswordState> = { ready: 'ready', loading: 'loading', saving: 'saving', ended: 'ended', off: 'turned_off', notvalid: 'not_valid' };
// The frame's Ready shows 14 dots: a typed stand-in of that length that meets every rule.
const TYPED = 'harbor lantern';

export default async function SetPasswordPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = STATES[name];
  if (!state) notFound();
  const withInfo = state === 'ready' || state === 'saving';
  return (
    <SetPasswordScreen
      token="preview" state={state} {...(withInfo ? { info: DEREK_LINK, typed: TYPED } : {})} clock={CLOCK_RUNNING} appInfo={APP_INFO}
    />
  );
}
