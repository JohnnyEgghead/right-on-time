// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-GATE-02 in each state its frame shows, for the look comparator (ci/look-values/auth.pw.test.ts)
// and the page walkers. One route per screen so each loads only its own frame's sheets. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { StartScreen, type TechSignIns } from '../../../../src/auth/StartScreen.tsx';
import { APP_INFO, CLOCK_RUNNING } from '../../../../src/shell/preview-fixtures.ts';

export const dynamic = 'force-dynamic';

const OFF = { ...APP_INFO, demoMode: false };
/** The frame's sample sign-ins (r1-gate-a-start SIGNS). Its passwords are placeholders (GAP-20); each stand-in here is one
 * the pre-push secret hook passes as trivial (it contains "example", F-301), chosen by measuring it in the frame's own
 * password cell: Derek's (the widest row, so it sets the column) renders at the frame placeholder's width on Chromium
 * (Mac and Linux) and WebKit (Linux); the others at their row's width on both Chromiums and narrower than Derek's on
 * WebKit. Every th and td of the table keeps its width (.build/evidence/F-301/standin-widths.txt). */
const SIGN_INS: TechSignIns['signIns'] = [
  { name: 'Maria Santos', branch: 'columbus', language: 'en', email: 'maria.santos@brightwater.example', password: 'Example-36ar' },
  { name: 'Luis Ortega', branch: 'columbus', language: 'es', email: 'luis.ortega@brightwater.example', password: 'Example-kkks' },
  { name: 'Ryan Mitchell', branch: 'columbus', language: 'en', email: 'ryan.mitchell@brightwater.example', password: 'example-5gjk' },
  { name: 'Derek Simmons', branch: 'dayton', language: 'en', email: 'derek.simmons@brightwater.example', password: 'example-pAS3' },
  { name: 'Teresa Molina', branch: 'springfield', language: 'es', email: 'teresa.molina@brightwater.example', password: 'Example-3768' },
];

export default async function StartPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const fixed = { reader: false as const, clock: CLOCK_RUNNING };
  switch (name) {
    case 'default':
      return <StartScreen info={OFF} {...fixed} />;
    case 'link':
      return <StartScreen info={APP_INFO} list={{ signIns: SIGN_INS, iosAppLink: 'https://apps.apple.com/us/app/right-on-time/id1234567890' }} {...fixed} />;
    case 'coming':
      return <StartScreen info={APP_INFO} list={{ signIns: SIGN_INS, iosAppLink: null }} {...fixed} />;
    case 'loading':
      return <StartScreen info={APP_INFO} list="loading" {...fixed} />;
    case 'error':
      return <StartScreen info={APP_INFO} list="error" {...fixed} />;
    default:
      notFound();
  }
}
