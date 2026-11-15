// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-06 Add photo at `/tech/jobs/{jobNumber}/photo` (UI-SPECIFICATION 2.3; role T): the sheet over SCR-TEC-04, as DK-110
// draws it (src/tech/job/JobScreen.tsx). No API answer is in the page.
import { notFound } from 'next/navigation';
import { JobScreen } from '../../../../../src/tech/job/JobScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ jobNumber: string }> }) {
  const { jobNumber } = await params;
  // A malformed number never reaches the read: SCR-SHR-02 (an unknown job is the screen's own No longer yours, from API-101).
  if (!/^[1-9]\d{0,9}$/.test(jobNumber) || Number(jobNumber) > 2_147_483_647) notFound();
  return <JobScreen jobNumber={Number(jobNumber)} photo />;
}
