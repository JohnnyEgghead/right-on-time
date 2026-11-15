// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-17 Admin: demo clock (UI-SPECIFICATION 2.3), with SCR-OFC-27 as its confirm dialog. Managers only (the page gate).
import { ClockScreen } from '../../../../src/clock/ClockScreen.tsx';

export const dynamic = 'force-dynamic';

export default function ClockPage() {
  return <ClockScreen />;
}
