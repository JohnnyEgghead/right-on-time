// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-04 Job at `/tech/jobs/{jobNumber}` (UI-SPECIFICATION 2.3; role T, own jobs only: the page gate refuses anyone else
// and API-101 answers forbidden for another technician's job). The screen reads in the browser and keeps the job on the phone
// (src/tech/job/JobScreen.tsx), so the page itself carries no API answer and the service worker may keep it (SD-47).
import { notFound } from 'next/navigation';
import { JobScreen } from '../../../../src/tech/job/JobScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ jobNumber: string }> }) {
  const { jobNumber } = await params;
  // A malformed number never reaches the read: SCR-SHR-02 (an unknown job is the screen's own No longer yours, from API-101).
  if (!/^[1-9]\d{0,9}$/.test(jobNumber) || Number(jobNumber) > 2_147_483_647) notFound();
  return <JobScreen jobNumber={Number(jobNumber)} />;
}
