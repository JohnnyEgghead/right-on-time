// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-16 Parts at `/tech/parts` (UI-SPECIFICATION 2.3; role T): the read-only search of the parts list kept on the phone, which works with
// no signal (P5-TWA-MAP-ME; FR-TECH-10).
import { TechPartsScreen } from '../../../src/tech/TechPartsScreen.tsx';

export const dynamic = 'force-dynamic';

export default function TechPartsPage() {
  return <TechPartsScreen />;
}
