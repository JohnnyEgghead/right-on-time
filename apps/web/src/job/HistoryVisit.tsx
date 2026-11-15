// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1542: a Service history row's visit text (CTL-OFC-03-12, CTL-OFC-06-12). A row that is a job in the app opens that job's
// office job page (SCR-OFC-03) as a real link; a row from the old system has no job page and stays plain text.
import Link from 'next/link';
import type { ReactNode } from 'react';

export const historyJobHref = (jobNumber: number): string => `/office/jobs/${jobNumber}`;

export function HistoryVisit({ jobNumber, children }: { jobNumber: number | null; children: ReactNode }) {
  return jobNumber === null ? <>{children}</> : <Link href={historyJobHref(jobNumber)}>{children}</Link>;
}
