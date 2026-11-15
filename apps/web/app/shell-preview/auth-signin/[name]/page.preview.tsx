// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-01 in each state its frame shows, for the look comparator (ci/look-values/auth.pw.test.ts)
// and the page walkers. One route per screen so each loads only its own frame's sheets. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { SignInScreen, type SamplePerson, type SignInMessage } from '../../../../src/auth/SignInScreen.tsx';
import { APP_INFO, CLOCK_RUNNING } from '../../../../src/shell/preview-fixtures.ts';

export const dynamic = 'force-dynamic';

const OFF = { ...APP_INFO, demoMode: false };
const PEOPLE: SamplePerson[] = [
  { personId: 'p1', name: 'Dana Ruiz', job: 'Operations manager', role: 'manager', branch: 'columbus', language: 'en' },
  { personId: 'p2', name: 'Keisha Thompson', job: 'Dispatcher', role: 'office', branch: 'columbus', language: 'en' },
  { personId: 'p3', name: 'Ana Gutierrez', job: 'Customer service', role: 'office', branch: 'columbus', language: 'es' },
  { personId: 'p4', name: 'Maria Santos', job: 'Technician', role: 'technician', branch: 'columbus', language: 'en' },
  { personId: 'p5', name: 'Luis Ortega', job: 'Technician', role: 'technician', branch: 'columbus', language: 'es' },
];
/** The message states by name (a state key, not copy: the screen renders the catalog text). */
const STATE: Record<'bad' | 'off' | 'returned', { message: SignInMessage }> = { bad: { message: 'bad' }, off: { message: 'off' }, returned: { message: 'returned' } };
const EMAIL = 'druiz@brightwaterair.com';

export default async function SignInPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const fixed = { reader: false as const, clock: CLOCK_RUNNING };
  switch (name) {
    case 'default':
      return <SignInScreen info={APP_INFO} people={PEOPLE} typedEmail={EMAIL} focusPassword {...fixed} />;
    case 'nodemo':
      return <SignInScreen info={OFF} typedEmail={EMAIL} {...fixed} />;
    case 'busy':
      return <SignInScreen info={OFF} typedEmail={EMAIL} busy {...fixed} />;
    case 'bad':
      return <SignInScreen info={OFF} typedEmail={EMAIL} {...STATE.bad} focusPassword {...fixed} />;
    case 'off':
      return <SignInScreen info={OFF} typedEmail={EMAIL} {...STATE.off} {...fixed} />;
    case 'returned':
      return <SignInScreen info={OFF} typedEmail={EMAIL} {...STATE.returned} {...fixed} />;
    case 'loading':
      return <SignInScreen info={APP_INFO} people="loading" {...fixed} />;
    case 'error':
      return <SignInScreen info={APP_INFO} people="error" {...fixed} />;
    default:
      notFound();
  }
}
