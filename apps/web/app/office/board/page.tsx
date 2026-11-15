// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-02 Dispatch board at `/office/board?branch=<id>&date=<yyyy-mm-dd or today>` (UI-SPECIFICATION 2.3, section 6).
// The page gate (policy page('SCR-OFC-02', '/office/board', OFFICE)) decides before this renders. The board reads in the
// browser (API-20, API-10, API-09): its blocks are placed through the style property, which the page's CSP allows only
// from script. P4-WEEK's week board links here with the picked date; P4-BOARD-MAP fills the map panel.
import { Suspense } from 'react';
import { BoardScreen } from '../../../src/board/BoardScreen.tsx';

export const dynamic = 'force-dynamic';

export default function BoardPage() {
  return (
    <Suspense>
      <BoardScreen />
    </Suspense>
  );
}
