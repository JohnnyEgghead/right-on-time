// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-EML-03 Forgot password's rules on the phone (UI-SPECIFICATION 10, SCR-EML-03; FR-AUTH-9), the web page's (apps/web/src/accounts/
// ForgotScreen.tsx) ported: the address is checked before the call, and API-165's answer is the screen's state. No React here, so the unit
// tests run it on node.
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import type { ResetResult } from '../core.ts';

export type ForgotState = 'default' | 'sending' | 'sent' | 'no_account' | 'turned_off' | 'not_available' | 'limited' | 'failed';

/** The web page's check (CTL-EML-03-01 "not an email: field message"): something@something.something, no spaces. */
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What an answer of API-165 shows. `bad` is the field message again (validation_failed), not a result. */
export function forgotStateOf(r: ResetResult): { state: ForgotState; bad: boolean; link: string | null } {
  if (r.ok) return { state: 'sent', bad: false, link: r.link };
  switch (r.code) {
    case 'bad':
      return { state: 'default', bad: true, link: null };
    case 'no_account':
    case 'turned_off':
    case 'not_available':
    case 'limited':
      return { state: r.code, bad: false, link: null };
    default:
      return { state: 'failed', bad: false, link: null };
  }
}

/**
 * CTL-EML-03-04: the one-time link counts as used only when the in-app browser answers that the page is on screen. An answer of false (no
 * browser module, an address that is not http(s), no screen to present over) or a rejection keeps the link, so the person can try again (F-1119).
 */
export async function openLinkOnce(link: string, open: (address: string) => Promise<boolean>): Promise<'opened' | 'failed'> {
  try {
    return (await open(link)) ? 'opened' : 'failed';
  } catch {
    return 'failed';
  }
}

/** CTL-EML-03-03, the result line of each state (the native app never says "demo", FR-IOS-4). */
export const RESULT: Partial<Record<ForgotState, { key: MessageKey; icon: 'check' | 'info' | 'lock' | 'alert'; box: 'ok' | 'info' | 'bad' }>> = {
  sent: { key: 'accounts.forgot.sent', icon: 'check', box: 'ok' },
  no_account: { key: 'accounts.forgot.noAccount', icon: 'info', box: 'info' },
  turned_off: { key: 'accounts.forgot.turnedOff', icon: 'lock', box: 'info' },
  not_available: { key: 'accounts.forgot.notAvailable', icon: 'info', box: 'info' },
  limited: { key: 'auth.error.limited', icon: 'alert', box: 'bad' },
  failed: { key: 'accounts.forgot.failed', icon: 'alert', box: 'bad' },
};
