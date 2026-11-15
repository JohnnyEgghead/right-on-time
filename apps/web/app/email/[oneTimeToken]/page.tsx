// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-EML-01 Email inbox: 1 email at `/email/{oneTimeToken}` (UI-SPECIFICATION 2.3). The page renders its shell and opens the
// email once in the browser (API-166, one-time): a server render never spends the link, so a prefetch cannot either.
import { EmailScreen } from '../../../src/accounts/EmailScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function EmailPage({ params }: { params: Promise<{ oneTimeToken: string }> }) {
  const { oneTimeToken } = await params;
  return <EmailScreen token={oneTimeToken} />;
}
