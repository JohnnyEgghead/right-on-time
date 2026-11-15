// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-TEC-01 Technician sign-in on the states its frame shows (DK-106), fixed, for the look
// comparator (ci/look-values/tech-today.pw.test.ts) and the page walkers. Never a release route.
import { notFound } from 'next/navigation';
import { SIGNIN_PREVIEWS } from '../../../../src/tech/signin-preview-data.ts';
import { SignInPreview } from '../../../../src/tech/SignInPreview.tsx';

export const dynamic = 'force-dynamic';

export default async function TechSignInPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = SIGNIN_PREVIEWS.find((s) => s === name);
  if (!state) notFound();
  return <SignInPreview name={state} />;
}
