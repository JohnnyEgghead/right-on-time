// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-10 Jobs not in billing at `/office/billing` (UI-SPECIFICATION 2.4). The page gate has already decided who may open it.
import { Suspense } from 'react';
import { BillingScreen } from '../../../src/billing/BillingScreen.tsx';

export const dynamic = 'force-dynamic';

export default function BillingPage() {
  // The screen reads ?branch= (useSearchParams), so it renders inside a Suspense boundary, as the week board does.
  return (
    <Suspense>
      <BillingScreen />
    </Suspense>
  );
}
