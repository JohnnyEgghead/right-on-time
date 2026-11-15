// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-12 Admin: arrival windows at `/office/admin/windows` (UI-SPECIFICATION 2.3), with SCR-OFC-24 as its confirm dialog. Office staff and
// managers (the page gate decides before this renders: policy SCR-OFC-12, OFFICE). The screen reads API-90 itself. It reads ?branch= (the top
// bar's branch) and ?date= (the week board's day-mode menu), so it renders inside Suspense.
import { Suspense } from 'react';
import { WindowsScreen } from '../../../../src/windows/WindowsScreen.tsx';

export const dynamic = 'force-dynamic';

export default function WindowsPage() {
  return (
    <Suspense>
      <WindowsScreen />
    </Suspense>
  );
}
