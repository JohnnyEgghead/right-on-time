// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// CMP-03 language switch (CTL-CMP-03-01): "English | Español" in every language (UI-SPECIFICATION 13.1 item 7, F-140),
// the kit's .r1-lang (DK-26). Re-renders the page in the chosen language without losing the user's place, input or
// scroll: the choice goes in the browser cookie and the server components re-render in place (router.refresh keeps
// client state and scroll). Signed-in staff also save it to the profile (API-08); a failed save keeps the switch and
// says so in a toast.
import type { Language } from '@bw/time';
import { useRouter } from 'next/navigation';
import { useAnnounce } from './Announcer.tsx';
import { useT } from './intl.tsx';
import { langCookie } from './lang.ts';
import { createReader } from './reads.ts';

export function LanguageSwitch({ staff = false, onDark = false, className }: { staff?: boolean; onDark?: boolean; className?: string }) {
  const t = useT();
  const router = useRouter();
  const announce = useAnnounce();
  const choose = async (lang: Language) => {
    if (lang === t.lang) return;
    document.cookie = langCookie(lang);
    router.refresh();
    if (staff) {
      const saved = await createReader({ baseUrl: window.location.origin }).read('API-08', { language: lang });
      if (!saved.ok) announce(t('shell.lang.notSaved'), 'info');
    }
  };
  const option = (lang: Language) => (
    <a
      href="#"
      role="button"
      lang={lang}
      className={t.lang === lang ? 'on' : undefined}
      aria-pressed={t.lang === lang}
      onClick={(e) => {
        e.preventDefault();
        void choose(lang);
      }}
      onKeyDown={(e) => {
        if (e.key !== ' ') return;
        e.preventDefault();
        void choose(lang);
      }}
    >
      {t(lang === 'en' ? 'language.name.en' : 'language.name.es')}
    </a>
  );
  const sw = (
    <span className={`r1-lang${className ? ` ${className}` : ''}`} data-ctl="CTL-CMP-03-01" role="group" aria-label={t('language.choose')}>
      {option('en')}
      <span className="sep" aria-hidden="true">
        |
      </span>
      {option('es')}
    </span>
  );
  return onDark ? <span className="on-dark">{sw}</span> : sw;
}
