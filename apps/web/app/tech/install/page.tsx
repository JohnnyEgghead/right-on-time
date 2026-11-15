// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-11 Install the app at `/tech/install` (UI-SPECIFICATION 2.3; anyone, behind the access code by the page gate's route order, OI-18):
// the steps that put the web technician app on the phone's home screen (P5-TWA-MAP-ME; NFR-09, OA-19).
import { TechInstallScreen } from '../../../src/tech/TechInstallScreen.tsx';

export const dynamic = 'force-dynamic';

export default function TechInstallPage() {
  return <TechInstallScreen />;
}
