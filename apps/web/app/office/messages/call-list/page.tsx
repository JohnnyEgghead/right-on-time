// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-09 Messages: call list at `/office/messages/call-list` (UI-SPECIFICATION 2.4). The page gate has already decided who may open it.
import { Suspense } from 'react';
import { CallListScreen } from '../../../../src/messages/CallListScreen.tsx';

export const dynamic = 'force-dynamic';

export default function CallListPage() {
  return (
    <Suspense>
      <CallListScreen />
    </Suspense>
  );
}
