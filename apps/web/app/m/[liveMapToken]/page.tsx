// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-CUS-04 Live map: on the way, and SCR-CUS-05 Live map: ended, at the live map link path `/m/{liveMapToken}` (UI-SPECIFICATION 2.3, GAP-11; SD-17).
// The page gate answers this route with no caching, and with status 410 once the link has ended (API-115, FR-TEXT-4); the screen reads API-116
// (the data under the same path) every 10 seconds and whenever it is shown again. The shell holds no position: it draws what API-116 answers.
import { headers } from 'next/headers';
import { LiveMapScreen } from '../../../src/livemap/LiveMapScreen.tsx';

export const dynamic = 'force-dynamic';

/**
 * The branch office number of the link, read on the server so the page carries it from its first load (API-115, CTL-CUS-04-06): Call shows
 * in Loading and in a first read that failed, before any read in the browser answers. API-116 answers it with a live link (200) and an ended
 * one (410); a link that is not valid answers none, and any failure leaves the number out (the page then draws no Call until a read answers).
 * F-1160: the read forwards the visitor's own cookie (the access code, FR-AUTH-6) and address (X-Forwarded-For, so the limiter counts the visitor,
 * not 127.0.0.1), so it gets the answer the visitor's own API-116 read gets and never hands the number to a caller the code would refuse. It
 * waits at most 2 seconds.
 */
async function readOfficePhone(token: string): Promise<string | null> {
  try {
    const incoming = await headers();
    const forward: Record<string, string> = { accept: 'application/json' };
    for (const name of ['cookie', 'x-forwarded-for']) {
      const value = incoming.get(name);
      if (value) forward[name] = value;
    }
    const res = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/m/${encodeURIComponent(token)}/data`, { headers: forward, cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (res.status !== 200 && res.status !== 410) return null;
    const body = (await res.json()) as { data?: { officePhone?: unknown }; officePhone?: unknown };
    const phone = res.status === 200 ? body.data?.officePhone : body.officePhone;
    return typeof phone === 'string' && phone !== '' ? phone : null;
  } catch {
    return null;
  }
}

export default async function LiveMapPage({ params }: { params: Promise<{ liveMapToken: string }> }) {
  const { liveMapToken } = await params;
  return <LiveMapScreen token={liveMapToken} officePhone={await readOfficePhone(liveMapToken)} />;
}
