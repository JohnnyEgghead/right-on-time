// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-INB-01 Text inbox at `/inbox/{inboxToken}` (UI-SPECIFICATION 2.3). The page renders its shell and reads the thread in the browser
// (API-120): the token is the customer's own, never sent to another origin.
import { InboxScreen } from '../../../src/inbox/InboxScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function InboxPage({ params }: { params: Promise<{ inboxToken: string }> }) {
  const { inboxToken } = await params;
  return <InboxScreen token={inboxToken} />;
}
