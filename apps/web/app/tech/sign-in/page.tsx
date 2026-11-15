// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-01 Technician sign-in at `/tech/sign-in` (UI-SPECIFICATION 2.3); it answers before the access code (SD-47 step 1). `return` is the
// page the person was sent from (page gate redirect): kept only when it is a path on this origin. `set=1` is SCR-EML-02's landing after a
// password is saved (F-616): "Your password is set. Sign in."
import { safeReturn } from '../../../src/auth/return-path.ts';
import { TechSignIn } from '../../../src/tech/TechSignIn.tsx';

export const dynamic = 'force-dynamic';

export default async function TechSignInPage({ searchParams }: { searchParams: Promise<{ return?: string | string[]; set?: string | string[] }> }) {
  const q = await searchParams;
  const raw = q.return;
  const back = safeReturn(Array.isArray(raw) ? raw[0] : raw);
  return <TechSignIn returnTo={back} returned={back !== null} passwordSet={q.set === '1'} />;
}
