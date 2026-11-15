// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-CUS-06 Change your visit time at `/r/{rescheduleToken}` (SPECIFICATIONS SD-17, GAP-11). The page renders its shell and reads the
// visit in the browser (API-117): the token is this visit's own and holds no phone number or address.
import { RescheduleScreen } from '../../../src/inbox/RescheduleScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function ReschedulePage({ params }: { params: Promise<{ rescheduleToken: string }> }) {
  const { rescheduleToken } = await params;
  return <RescheduleScreen token={rescheduleToken} />;
}
