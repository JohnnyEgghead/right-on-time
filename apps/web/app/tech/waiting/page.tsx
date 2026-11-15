// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-09 Waiting to send at `/tech/waiting` (UI-SPECIFICATION 2.3; role T; DK-111): read from the phone's store only
// (src/tech/job/WaitingScreen.tsx); no API answer is in the page.
import { WaitingScreen } from '../../../src/tech/job/WaitingScreen.tsx';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <WaitingScreen />;
}
