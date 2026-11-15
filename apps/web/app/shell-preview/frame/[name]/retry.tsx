// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The CMP-12 preview's panel: a server component cannot hand a retry function to a client one, so this wraps it.
import { ErrorPanel } from '../../../../src/shell/Panels.tsx';

export function RetryLater({ title, hint }: { title: string; hint: string }) {
  return <ErrorPanel title={title} hint={hint} onRetry={() => undefined} />;
}
