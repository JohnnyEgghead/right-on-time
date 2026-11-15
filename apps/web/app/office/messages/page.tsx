// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-08 Messages: text log at `/office/messages` (UI-SPECIFICATION 2.4). The page gate has already decided who may open it.
import { Suspense } from 'react';
import { MessagesScreen } from '../../../src/messages/MessagesScreen.tsx';

export const dynamic = 'force-dynamic';

export default function MessagesPage() {
  // The screen reads ?branch= and ?date= (useSearchParams), so it renders inside a Suspense boundary, as the billing list does.
  return (
    <Suspense>
      <MessagesScreen />
    </Suspense>
  );
}
