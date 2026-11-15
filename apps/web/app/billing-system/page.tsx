// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-PBS-01 Pretend billing: invoices and mode at `/billing-system` (UI-SPECIFICATION 2.4). The page gate has already decided who may open it.
import { PbsListScreen } from '../../src/billing/PbsScreens.tsx';

export const dynamic = 'force-dynamic';

export default function PretendBillingPage() {
  return <PbsListScreen />;
}
