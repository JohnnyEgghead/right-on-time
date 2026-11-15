// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-SHR-03 Something went wrong: the error boundary of every route (a server render that throws answers 500).
// Try again (CTL-SHR-03-02) re-runs the page's reads; if it fails again the page stays.
import { useRouter } from 'next/navigation';
import { startTransition } from 'react';
import { SharedPage } from '../src/shell/SharedPages.tsx';

export default function RouteError({ reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <SharedPage
      kind="failed"
      onRetry={() =>
        startTransition(() => {
          router.refresh();
          reset();
        })
      }
    />
  );
}
