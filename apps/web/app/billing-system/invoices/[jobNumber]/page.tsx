// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-PBS-02 Pretend billing: invoice at `/billing-system/invoices/{jobNumber}` (UI-SPECIFICATION 2.4). A job number that is not a whole
// number of at least 1 has no invoice: the Page not found page (SCR-SHR-02).
import { notFound } from 'next/navigation';
import { PbsInvoiceScreen } from '../../../../src/billing/PbsScreens.tsx';

export const dynamic = 'force-dynamic';

export default async function PretendInvoicePage({ params }: { params: Promise<{ jobNumber: string }> }) {
  const raw = (await params).jobNumber;
  const jobNumber = /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : 0;
  if (jobNumber < 1 || jobNumber > 2_147_483_647) notFound();
  return <PbsInvoiceScreen jobNumber={jobNumber} />;
}
