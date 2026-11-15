// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-01 Staff sign-in at `/sign-in` (UI-SPECIFICATION 2.3); it answers before the access code (SD-47 step 1). `return` is the
// page the person was sent from (page gate redirect): kept only when it is a path on this origin.
import { safeReturn } from '../../src/auth/return-path.ts';
import { SignInScreen } from '../../src/auth/SignInScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ return?: string | string[]; set?: string | string[] }> }) {
  const q = await searchParams;
  const raw = q.return;
  const back = safeReturn(Array.isArray(raw) ? raw[0] : raw);
  // P4-ACCOUNTS: SCR-EML-02 opens this page with ?set=1 once a password is saved.
  return <SignInScreen returnTo={back} returned={back !== null} passwordSet={q.set === '1'} />;
}
