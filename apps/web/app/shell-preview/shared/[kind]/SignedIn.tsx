// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Harness build only: the not-found page as a signed-in reader sees it (the frame's "Go to your home page"). A server
// component cannot hand a reader function to a client one, so this builds the reader that answers API-07 with a Me.
import { APP_INFO, CLOCK_RUNNING, MANAGER } from '../../../../src/shell/preview-fixtures.ts';
import type { Reader } from '../../../../src/shell/reads.ts';
import { SharedPage } from '../../../../src/shell/SharedPages.tsx';

const SIGNED_IN: Reader = {
  read: <T,>() => Promise.resolve({ ok: true as const, data: MANAGER as unknown as T }),
};

export function SignedInNotFound() {
  return <SharedPage kind="not-found" clock={CLOCK_RUNNING} appInfo={APP_INFO} reader={SIGNED_IN} />;
}
