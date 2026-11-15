// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-08 Directions at `/tech/jobs/{jobNumber}/directions` (UI-SPECIFICATION 2.3; role T): the route to the job on the app's own street map,
// with the drive time (P5-TWA-MAP-ME; FR-TECH-5, FR-TECH-13). `?from=<jobNumber>` starts the route at another job of the day (CTL-TEC-04-04).
import { notFound } from 'next/navigation';
import { TechDirectionsScreen } from '../../../../../src/tech/TechDirectionsScreen.tsx';

export const dynamic = 'force-dynamic';

const JOB_MAX = 2_147_483_647;
const jobOf = (v: unknown): number | null => (typeof v === 'string' && /^[1-9]\d{0,9}$/.test(v) && Number(v) <= JOB_MAX ? Number(v) : null);

export default async function TechDirectionsPage({ params, searchParams }: { params: Promise<{ jobNumber: string }>; searchParams: Promise<{ from?: string | string[] }> }) {
  const { jobNumber } = await params;
  const job = jobOf(jobNumber);
  if (job === null) notFound();
  const from = jobOf((await searchParams).from);
  return <TechDirectionsScreen jobNumber={job} {...(from !== null ? { from } : {})} />;
}
