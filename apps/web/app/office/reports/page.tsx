// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-11 Reports at `/office/reports?branch=<id or all>&technician=<id or all>&from=<week>&to=<week>` (UI-SPECIFICATION 2.3, Roles M: the
// page gate of the policy table refuses anyone else). The screen reads API-50 in the browser and keeps the filters in the address.
import { Suspense } from 'react';
import { ReportsScreen } from '../../../src/reports/ReportsScreen.tsx';

export const dynamic = 'force-dynamic';

export default function ReportsPage() {
  // The screen reads ?branch=, ?technician=, ?from= and ?to= (useSearchParams), so it renders inside a Suspense boundary.
  return (
    <Suspense>
      <ReportsScreen />
    </Suspense>
  );
}
