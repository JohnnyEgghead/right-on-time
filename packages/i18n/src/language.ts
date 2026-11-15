// SPDX-License-Identifier: AGPL-3.0-or-later
// Choosing the language (UI-SPECIFICATION section 13.2). Pure: callers pass what they know.
export type Language = 'en' | 'es';
export const LANGUAGES: readonly Language[] = ['en', 'es'];

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'es';
}

export type LanguageSurface =
  | 'staff' // signed-in staff: the profile's language
  | 'booking' // booking site: the browser's stored choice, else English
  | 'customer-text' // live map, reschedule page, inbox: the customer's text language
  | 'public' // gate, start, sign-in, forgot password, email and set-password pages, install guide
  | 'native'; // native app: profile after sign-in, device language before

export type LanguageInputs = {
  /** The language the user chose in this browser (kept in the browser). */
  browserChoice?: unknown;
  /** The signed-in profile's language (API-08). */
  profile?: unknown;
  /** The customer's text language. */
  customerText?: unknown;
  /** The device language, native app only (a tag such as "es-MX"). */
  device?: unknown;
};

function fromTag(tag: unknown): Language | undefined {
  if (typeof tag !== 'string') return undefined;
  const base = tag.toLowerCase().split(/[-_]/)[0];
  return isLanguage(base) ? base : undefined;
}

export function chooseLanguage(surface: LanguageSurface, inputs: LanguageInputs = {}): Language {
  const stored = isLanguage(inputs.browserChoice) ? inputs.browserChoice : undefined;
  switch (surface) {
    case 'staff':
      return fromTag(inputs.profile) ?? 'en';
    case 'booking':
    case 'public':
      return stored ?? 'en';
    case 'customer-text':
      // The customer's text language, until the customer switches in the browser.
      return stored ?? fromTag(inputs.customerText) ?? 'en';
    case 'native':
      return fromTag(inputs.profile) ?? fromTag(inputs.device) ?? 'en';
  }
}
