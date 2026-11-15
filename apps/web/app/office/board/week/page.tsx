// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-34 Week board at `/office/board/week?branch=<id>&week=<Monday's date>` (UI-SPECIFICATION 2.3; Roles O, M: the page gate
// of the policy table refuses anyone else). The screen reads API-132 and the event stream in the browser.
import { Suspense } from 'react';
import { WeekScreen } from '../../../../src/week/WeekScreen.tsx';

export const dynamic = 'force-dynamic';

export default function WeekBoardPage() {
  return (
    <Suspense>
      <WeekScreen />
    </Suspense>
  );
}
