// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-30 Jobs at `/office/jobs?tab=<all, unassigned, at-risk, late, not-in-billing>` (UI-SPECIFICATION 2.3; Roles O, M: the page gate of the
// policy table refuses anyone else). The screen reads API-133 and the event stream in the browser.
import { Suspense } from 'react';
import { JobsScreen } from '../../../src/jobs/JobsScreen.tsx';

export const dynamic = 'force-dynamic';

export default function JobsPage() {
  // The screen reads ?tab= and ?branch= (useSearchParams), so it renders inside a Suspense boundary, as the week board does.
  return (
    <Suspense>
      <JobsScreen />
    </Suspense>
  );
}
