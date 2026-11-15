// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-07 Technicians at `/office/technicians?branch=<id>` (UI-SPECIFICATION 2.3; Roles O, M: the page gate of the policy table refuses anyone
// else). The screen reads API-31 in the browser.
import { Suspense } from 'react';
import { TechniciansScreen } from '../../../src/technicians/TechniciansScreen.tsx';

export const dynamic = 'force-dynamic';

export default function TechniciansPage() {
  // The screen reads ?branch= (useSearchParams), so it renders inside a Suspense boundary, as the jobs list does.
  return (
    <Suspense>
      <TechniciansScreen />
    </Suspense>
  );
}
