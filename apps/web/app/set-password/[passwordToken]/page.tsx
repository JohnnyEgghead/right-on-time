// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-EML-02 Set a password at `/set-password/{passwordToken}` (UI-SPECIFICATION 2.3); the screen reads API-167 and saves by
// API-168 with the token from the path.
import { SetPasswordScreen } from '../../../src/accounts/SetPasswordScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function SetPasswordPage({ params }: { params: Promise<{ passwordToken: string }> }) {
  const { passwordToken } = await params;
  return <SetPasswordScreen token={passwordToken} />;
}
