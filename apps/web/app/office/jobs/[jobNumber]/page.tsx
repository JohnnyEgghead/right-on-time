// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-03 Job detail at `/office/jobs/{jobNumber}` (UI-SPECIFICATION 2.3). The page gate (policy page('SCR-OFC-03',
// '/office/jobs/{jobNumber}', OFFICE)) decides before this renders; the screen reads in the browser (API-23, API-135, API-09).
import { notFound } from 'next/navigation';
import { JobScreen } from '../../../../src/job/JobScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function JobPage({ params }: { params: Promise<{ jobNumber: string }> }) {
  const { jobNumber } = await params;
  // An unknown job number is SCR-SHR-02: a malformed one never reaches the read.
  if (!/^[1-9]\d{0,9}$/.test(jobNumber) || Number(jobNumber) > 2_147_483_647) notFound();
  return <JobScreen jobNumber={Number(jobNumber)} />;
}
