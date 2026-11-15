// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-15 Map at `/tech/map` (UI-SPECIFICATION 2.3; role T: the page gate refuses anyone else). Today's route on the app's own street map,
// the numbered stops and the next stop's card (P5-TWA-MAP-ME; FR-TECH-10, FR-TECH-11).
import { TechMapScreen } from '../../../src/tech/TechMapScreen.tsx';

export const dynamic = 'force-dynamic';

export default function TechMapPage() {
  return <TechMapScreen />;
}
