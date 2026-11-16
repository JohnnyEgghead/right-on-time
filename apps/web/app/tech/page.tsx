// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-02 Today at `/tech` (UI-SPECIFICATION 2.3; role T: the page gate refuses anyone else). The day's jobs are API-100: this page
// reads it on the server for the first paint (the person's own session cookie, forwarded to the web process's own API), so the list
// is there with no skeleton, and the answer rides in the page. Such a page carries the header X-Bw-Server-State and the service worker
// never keeps it (F-980; src/tech/server-state.ts); the worker keeps this address's shell variant (`?bw-shell=1`: no read) for an open
// with no signal, and the screen then shows the day saved on the phone (src/tech/today/TodayScreen.tsx).
import type { TodayAnswer } from '@bw/api';
import { headers } from 'next/headers';
import { shellVariant } from '../../src/tech/server-state.ts';
import { TodayScreen } from '../../src/tech/today/TodayScreen.tsx';

export const dynamic = 'force-dynamic';

/** API-100 as the signed-in person; any failure leaves the first paint to the screen's own read. */
async function readToday(): Promise<TodayAnswer | null> {
  const cookie = (await headers()).get('cookie');
  if (!cookie) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/api/v1/tech/day`, { headers: { cookie, accept: 'application/json' }, cache: 'no-store' });
    return res.ok ? ((await res.json()) as { data: TodayAnswer }).data : null;
  } catch {
    return null;
  }
}

export default async function TechTodayPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  return <TodayScreen initial={shellVariant(q) ? null : await readToday()} />;
}
