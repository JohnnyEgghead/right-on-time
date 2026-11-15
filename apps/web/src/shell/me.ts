// SPDX-License-Identifier: AGPL-3.0-or-later
// Who is signed in, for the office frames (CMP-07 menu by role, the user button and the "/" switch; CMP-08 admin links):
// API-07 read once on mount through the page's reader. Until it answers, or when it fails, `me` is null and the frame
// shows no top bar: a signed-out person never reaches an office page (the page gate redirects them to sign in).
import { useEffect, useState } from 'react';
import type { Me } from './OfficeTopBar.tsx';
import { createReader, type Reader } from './reads.ts';

/** API-07 with its failure kept (F-704, UI-SPECIFICATION 297): a page with role-gated controls shows CMP-12 in their place when `failed`, and `retry` reads again. */
export function useMeRead(reader?: Reader | false, given?: Me): { me: Me | null; failed: boolean; retry: () => void } {
  const [me, setMe] = useState<Me | null>(given ?? null);
  const [failed, setFailed] = useState(false);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    if (given || reader === false) return;
    let live = true;
    void (reader ?? createReader({ baseUrl: window.location.origin })).read<Me>('API-07').then((r) => {
      if (!live) return;
      if (r.ok) { setMe(r.data); setFailed(false); } else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [reader, given, again]);
  return { me: given ?? me, failed: !given && failed, retry: () => { setFailed(false); setAgain((n) => n + 1); } };
}

export function useMe(reader?: Reader | false, given?: Me): Me | null {
  return useMeRead(reader, given).me;
}
