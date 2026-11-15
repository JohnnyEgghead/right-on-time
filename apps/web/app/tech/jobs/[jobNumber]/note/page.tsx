// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-05 Add note at `/tech/jobs/{jobNumber}/note` (UI-SPECIFICATION 2.3; role T; DK-111). The draft and the note live in the
// phone's store (src/tech/job/NoteScreen.tsx); no API answer is in the page.
import { notFound } from 'next/navigation';
import { NoteScreen } from '../../../../../src/tech/job/NoteScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ jobNumber: string }> }) {
  const { jobNumber } = await params;
  // A malformed number never reaches the read: SCR-SHR-02 (an unknown job is the screen's own No longer yours, from API-101).
  if (!/^[1-9]\d{0,9}$/.test(jobNumber) || Number(jobNumber) > 2_147_483_647) notFound();
  return <NoteScreen jobNumber={Number(jobNumber)} />;
}
