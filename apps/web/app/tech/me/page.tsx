// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-10 Me at `/tech/me` (UI-SPECIFICATION 2.3; role T): the technician's van, today's hours, sync, settings and Sign out
// (P5-TWA-MAP-ME; FR-TECH-15). F-1775: the profile line (the name, initials and role, F-1740) comes from API-07, read here on the server
// with the person's own session cookie (forwarded to the web process's own API, as app/tech/page.tsx reads API-100), so Reading the phone,
// Loading and Day not loaded name the person from the first paint, whatever the day read does. The page then carries the header
// X-Bw-Server-State and the service worker never keeps it (F-980; src/tech/server-state.ts); its shell variant (`?bw-shell=1`) reads nothing.
import { headers } from 'next/headers';
import type { Profile } from '../../../src/tech/local.ts';
import { profileOf } from '../../../src/tech/model.ts';
import { shellVariant } from '../../../src/tech/server-state.ts';
import { TechMeScreen } from '../../../src/tech/TechMeScreen.tsx';

export const dynamic = 'force-dynamic';

/** API-07 as the signed-in person; any failure leaves the profile to the phone's kept copy and its own read. */
async function readProfile(): Promise<Profile | null> {
  const cookie = (await headers()).get('cookie');
  if (!cookie) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/api/v1/me`, { headers: { cookie, accept: 'application/json' }, cache: 'no-store' });
    return res.ok ? profileOf(((await res.json()) as { data: { name: string; skill: string | null } }).data) : null;
  } catch {
    return null;
  }
}

export default async function TechMePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  return <TechMeScreen profile={shellVariant(q) ? null : await readProfile()} />;
}
