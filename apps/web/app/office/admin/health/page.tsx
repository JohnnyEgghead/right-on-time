// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-16 Admin: system health at `/office/admin/health` (UI-SPECIFICATION 2.3), managers only: the page gate decides before this
// renders (policy SCR-OFC-16, MANAGER). The screen reads API-70 itself. It reads ?branch= (the top bar's branch), so it renders inside Suspense.
import { Suspense } from 'react';
import { HealthScreen } from '../../../../src/health/HealthScreen.tsx';

export const dynamic = 'force-dynamic';

export default function HealthPage() {
  return (
    <Suspense>
      <HealthScreen />
    </Suspense>
  );
}
