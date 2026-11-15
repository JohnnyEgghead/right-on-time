// SPDX-License-Identifier: AGPL-3.0-or-later
import { catalogs } from '@bw/i18n';
import { describe, expect, it } from 'vitest';
import { formatCatalog } from './i18n-server.ts';
import { langCookie, langFromCookie } from './lang.ts';

describe('page language', () => {
  // why: FR-LANG-1 public pages keep the visitor's choice in the browser (UI-SPECIFICATION 13.2, UD-32)
  it('uses the browser choice on public pages, else English', () => {
    expect(langFromCookie('es')).toBe('es');
    expect(langFromCookie('en')).toBe('en');
    expect(langFromCookie(undefined)).toBe('en');
    expect(langFromCookie('fr')).toBe('en');
    expect(langFromCookie('en', 'es-MX')).toBe('es');
    expect(langCookie('es')).toMatch(/^bw_lang=es; Path=\/; Max-Age=\d+; SameSite=Lax$/);
  });

  // why: F-140 UI-SPECIFICATION 13.1 item 7: the language names are the only words shown in the other language
  it('shows the language choices as English and Español in both languages', () => {
    for (const lang of ['en', 'es'] as const) {
      expect(catalogs[lang]['language.name.en']).toBe('English');
      expect(catalogs[lang]['language.name.es']).toBe('Español');
    }
  });

  // why: FR-LANG-3 a page shown in Spanish holds no English fallback
  it('throws on a missing key on the server, never falling back to English', () => {
    expect(() => formatCatalog('es', 'planted.missing.key')).toThrow(/missing in es/);
    expect(formatCatalog('es', 'shell.footer.demo')).toBe('Modo demo activado');
  });
});
