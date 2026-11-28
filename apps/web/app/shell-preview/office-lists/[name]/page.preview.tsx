// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): the office list screens rendered LIVE (not a fixed state), so ci/page-walkers/office-lists.pw.test.ts can
// answer their reads one at a time and count them (P10-OFFICE-LISTS). Never a release route; the page walkers' wiring does not list it.
// F-2075: it renders the real pages (the real checks of `customer` and `date` included), not a copy of their code.
import { notFound } from 'next/navigation';
import JobsPage from '../../../office/jobs/page.tsx';
import NewJobPage from '../../../office/jobs/new/page.tsx';

export const dynamic = 'force-dynamic';

export default async function OfficeListsPreview({ params, searchParams }: { params: Promise<{ name: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { name } = await params;
  switch (name) {
    case 'jobs':
      return <JobsPage />;
    case 'new-job':
      return <NewJobPage searchParams={searchParams} />;
    default:
      notFound();
  }
}
