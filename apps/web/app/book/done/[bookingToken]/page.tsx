// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-CUS-03 You're booked at `/book/done/{bookingToken}` (UI-SPECIFICATION 2.3; public by its token). The token is read from the path and
// passed to the screen, which calls API-114 with it; no phone number or address is in the link (NFR-05).
import { DoneScreen } from '../../../../src/booking/DoneScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function DonePage({ params }: { params: Promise<{ bookingToken: string }> }) {
  const { bookingToken } = await params;
  return <DoneScreen bookingToken={bookingToken} />;
}
