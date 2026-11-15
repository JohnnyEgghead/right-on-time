// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-GATE-02 Start page at `/` (UI-SPECIFICATION 2.3). The page gate decides before this renders: with the access code on and
// not entered, SCR-GATE-01 shows in its place (layout.tsx).
import { StartScreen } from '../src/auth/StartScreen.tsx';

export const dynamic = 'force-dynamic';

export default function StartPage() {
  return <StartScreen />;
}
