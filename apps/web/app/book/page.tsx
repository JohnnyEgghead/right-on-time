// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-CUS-01 Book a visit and SCR-CUS-02 Window just taken at `/book` (UI-SPECIFICATION 2.3; public, FR-AUTH-2). The page gate (policy
// page('SCR-CUS-01', '/book', PUBLIC)) decides before this renders. `new=1` (CTL-CUS-03-05, Book another visit) opens it empty.
import { BookingScreen } from '../../src/booking/BookingScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function BookPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  return <BookingScreen fresh={q['new'] === '1'} />;
}
