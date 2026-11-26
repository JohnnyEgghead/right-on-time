// SPDX-License-Identifier: AGPL-3.0-or-later
// The office customer page: the equipment, notes and jobs of 1 customer, SCR-OFC-06 (UI-SPECIFICATION 2.3).
import { CustomerScreen } from '../../../../src/customers/CustomerScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function CustomerPage({ params }: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await params;
  return <CustomerScreen customerId={customerId} />;
}
