// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-EML-03 Forgot password at `/forgot-password?app=<office or tech>` (UI-SPECIFICATION 2.3), behind the access code (UD-46).
import { ForgotScreen } from '../../src/accounts/ForgotScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function ForgotPage({ searchParams }: { searchParams: Promise<{ app?: string | string[] }> }) {
  const raw = (await searchParams).app;
  const app = (Array.isArray(raw) ? raw[0] : raw) === 'tech' ? 'tech' : 'office';
  return <ForgotScreen app={app} />;
}
