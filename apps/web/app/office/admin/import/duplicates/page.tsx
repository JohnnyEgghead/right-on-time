// SPDX-License-Identifier: AGPL-3.0-or-later
// The admin import page that shows possible duplicate customers, SCR-OFC-14 (UI-SPECIFICATION 2.3).
import { DuplicatesScreen } from '../../../../../src/import/DuplicatesScreen.tsx';

export const dynamic = 'force-dynamic';

export default function DuplicatesPage() {
  return <DuplicatesScreen />;
}
