// SPDX-License-Identifier: AGPL-3.0-or-later
// The Technician sign-in page's preview states (SCR-TEC-01; harness build only): the frame's default and its other tiles (DK-106 mockups/pages/tech-signin.html).
import type { SamplePerson } from '../auth/SignInScreen.tsx';
import type { ClockAnswer } from '../shell/clock.ts';
import { APP_INFO, CLOCK_RUNNING } from '../shell/preview-fixtures.ts';
import type { TechSignInProps } from './TechSignIn.tsx';

export const SIGNIN_PREVIEWS = ['default', 'signing-in', 'wrong', 'off', 'waiting'] as const;
export type SignInPreviewName = (typeof SIGNIN_PREVIEWS)[number];

const CLOCK: ClockAnswer = { ...CLOCK_RUNNING, demoNow: '2026-09-15T07:41:00-04:00[America/New_York]' };
const PEOPLE: SamplePerson[] = [
  { personId: 'p1', name: 'Maria Santos', job: 'Technician', role: 'technician', branch: 'columbus', language: 'en' },
  { personId: 'p2', name: 'Luis Ortega', job: 'Technician', role: 'technician', branch: 'columbus', language: 'es' },
  { personId: 'p3', name: 'Derek Simmons', job: 'Technician', role: 'technician', branch: 'dayton', language: 'en' },
];

export function signInPreview(name: SignInPreviewName): TechSignInProps {
  const base: TechSignInProps = { info: APP_INFO, people: PEOPLE, clock: CLOCK, reader: false, typed: '40712', typedPassword: true };
  switch (name) {
    case 'default': return { ...base, stay: true, focusPassword: true };
    case 'signing-in': return { ...base, busy: true, people: null, mini: true };
    case 'wrong': return { ...base, message: 'bad', people: null, focusPassword: true, typedPassword: false, mini: true };
    case 'off': return { ...base, message: 'off', people: null, mini: true };
    case 'waiting': return { ...base, waiting: { count: 3, name: 'Maria Santos' }, people: null, mini: true };
  }
}
