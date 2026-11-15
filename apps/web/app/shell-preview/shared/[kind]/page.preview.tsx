// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only: the 3 shared pages with the data their frames show (r1-shr-403/404/500), for the look
// comparator. They load only the shared pages' kit set (SharedPages.tsx), as the frames do.
import { notFound } from 'next/navigation';
import { APP_INFO, CLOCK_RUNNING } from '../../../../src/shell/preview-fixtures.ts';
import { SharedPage, type SharedKind } from '../../../../src/shell/SharedPages.tsx';
import { SignedInNotFound } from './SignedIn.tsx';

export const dynamic = 'force-dynamic';

const KINDS: Record<string, SharedKind> = { '403': 'no-access', '404': 'not-found', '500': 'failed' };

export default async function SharedPreview({ params }: { params: Promise<{ kind: string }> }) {
  const name = (await params).kind;
  // 404-in: the frame's state (SCR-SHR-02 Missing draws "Go to your home page", a signed-in reader's way on).
  if (name === '404-in') return <SignedInNotFound />;
  const kind = KINDS[name];
  if (!kind) notFound();
  return <SharedPage kind={kind} clock={CLOCK_RUNNING} appInfo={APP_INFO} reader={false} />;
}
