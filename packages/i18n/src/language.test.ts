// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { chooseLanguage } from './language.ts';

// The language rules, row by row: staff, booking and public pages, customer text pages, and the native app (UI-SPECIFICATION section 13.2).
describe('chooseLanguage', () => {
  // why: FR-LANG-1
  it('staff use the profile language', () => {
    expect(chooseLanguage('staff', { profile: 'es' })).toBe('es');
    expect(chooseLanguage('staff', { profile: 'es', browserChoice: 'en' })).toBe('es');
    expect(chooseLanguage('staff', {})).toBe('en');
  });

  // why: FR-LANG-1
  it('booking and public pages use the browser choice, else English', () => {
    for (const surface of ['booking', 'public'] as const) {
      expect(chooseLanguage(surface, { browserChoice: 'es' })).toBe('es');
      expect(chooseLanguage(surface, { browserChoice: 'fr', customerText: 'es' })).toBe('en');
      expect(chooseLanguage(surface, {})).toBe('en');
    }
  });

  // why: FR-TEXT-6
  it('customer text pages use the text language until switched in the browser', () => {
    expect(chooseLanguage('customer-text', { customerText: 'es' })).toBe('es');
    expect(chooseLanguage('customer-text', { customerText: 'es', browserChoice: 'en' })).toBe('en');
    expect(chooseLanguage('customer-text', {})).toBe('en');
  });

  // why: FR-LANG-1
  it('native uses the profile after sign-in and the device language before', () => {
    expect(chooseLanguage('native', { profile: 'en', device: 'es-MX' })).toBe('en');
    expect(chooseLanguage('native', { device: 'es-MX' })).toBe('es');
    expect(chooseLanguage('native', { device: 'fr-FR' })).toBe('en');
  });
});
