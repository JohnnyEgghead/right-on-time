// SPDX-License-Identifier: AGPL-3.0-or-later
// The page language (UI-SPECIFICATION 13.2). Public pages keep the visitor's choice in the browser (UD-32): a cookie,
// so the server renders the chosen language and <html lang> on the first byte (13.1 item 6) with no flash of English.
// Signed-in staff use the profile's language (API-07); until API-07 lands the browser choice stands in for it.
import { chooseLanguage, isLanguage, type Language } from '@bw/i18n';

export const LANG_COOKIE = 'bw_lang';
/** 400 days, the longest lifetime browsers keep (RFC 6265bis). */
const LANG_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

export function langFromCookie(value: string | undefined, profile?: unknown): Language {
  if (profile !== undefined) return chooseLanguage('staff', { profile });
  return chooseLanguage('public', { browserChoice: isLanguage(value) ? value : undefined });
}

/** The Set-Cookie value the language switch writes. */
export function langCookie(lang: Language): string {
  return `${LANG_COOKIE}=${lang}; Path=/; Max-Age=${LANG_COOKIE_MAX_AGE_S}; SameSite=Lax`;
}
