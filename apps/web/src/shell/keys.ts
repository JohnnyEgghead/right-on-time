// SPDX-License-Identifier: AGPL-3.0-or-later
// Small decision rules of the shell, kept pure so they are tested without a browser.

/** What the "/" key does (CTL-CMP-07-10, FR-DISP-11, WCAG 2.2 SC 2.1.4). */
export interface KeyTarget {
  tagName: string;
  isContentEditable?: boolean;
  type?: string;
}

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'tel', 'url', 'password', 'number', 'date', 'time']);

/** True when the focused element takes typed text, so "/" must stay in it. */
function isTextField(t: KeyTarget | null | undefined): boolean {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'INPUT' && TEXT_INPUT_TYPES.has((t.type ?? '').toLowerCase());
}

/** "/" moves focus to search only when the user's switch is on and the key was pressed outside any text field. */
export function slashFocusesSearch(
  ev: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
  target: KeyTarget | null | undefined,
  shortcutOn: boolean,
): boolean {
  if (!shortcutOn || ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey) return false;
  return !isTextField(target);
}

/** SD-33: a page counts as a phone when (pointer: coarse) and (hover: none) matches; the server never reads the user agent. */
export const PHONE_QUERY = '(pointer: coarse) and (hover: none)';

export type CallMode = 'dial' | 'reveal';

export function callMode(matchMedia: ((q: string) => { matches: boolean }) | undefined): CallMode {
  return matchMedia?.(PHONE_QUERY).matches ? 'dial' : 'reveal';
}

/** The tel: link for a display number like "(614) 555-0112": digits only, with the US country code. */
export function telHref(number: string): string {
  const digits = number.replace(/\D/g, '');
  return `tel:+${digits.length === 10 ? `1${digits}` : digits}`;
}

/** The search sends the query exactly as typed, trimmed only, and only after 2 characters (CTL-CMP-07-05). */
export function searchQuery(typed: string): string | null {
  const q = typed.trim();
  return q.length >= 2 ? q : null;
}
