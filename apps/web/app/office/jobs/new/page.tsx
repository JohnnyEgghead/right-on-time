// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-04 New job at `/office/jobs/new` (UI-SPECIFICATION 2.3). The page gate (policy page('SCR-OFC-04', '/office/jobs/new', OFFICE))
// decides before this renders. `customer` (CTL-OFC-06-01, CTL-OFC-05-14) and `date` (CTL-OFC-02-05) are checked here; a value that is
// not an id or a day is left out, never passed on.
import { NewJobScreen } from '../../../../src/newjob/NewJobScreen.tsx';

export const dynamic = 'force-dynamic';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

export default async function NewJobPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const customer = one(q['customer']);
  const date = one(q['date']);
  return <NewJobScreen customerId={customer && ID.test(customer) ? customer : undefined} date={date && DAY.test(date) ? date : undefined} />;
}
