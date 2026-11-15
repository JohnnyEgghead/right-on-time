// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The phone-sized frame parts SCR-INB-01 and SCR-CUS-06 share (frames DK-125 to DK-128): the brand row with the language choice, the
// footer line, and the sheets those frames load, in their order (base, phone, r1-common). The markup is the frames' own, so the page
// rules (a byte copy of each frame's style) apply to it as they do there.
import '../../styles/kit/kit.base.css';
import '../../styles/kit/kit.phone.css';
import '../../styles/kit/kit.r1-common.css';
import '../../styles/app/inbox.css';
import type { Language } from '@bw/time';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Mark } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { langCookie } from '../shell/lang.ts';
import { createReader } from '../shell/reads.ts';
import type { AppInfo } from '../shell/Footer.tsx';
import { Icon } from '../shell/Icon.tsx';
import type { IconName } from '../shell/icon-paths.ts';

/** The brand and the office phone (CMP-14, CTL-CMP-14-01), with the page's own language choice beside them. */
export function BrandRow({ className, phone, lang: Lang }: { className: 'ibrow' | 'brandrow'; phone: string; lang: ReactNode }) {
  const t = useT();
  return (
    <div className={className} data-ctl="CTL-CMP-14-01">
      <span className="brand">
        <Mark />
        <span className="word">{t('brand.name')}</span>
      </span>
      <span className="tel14">{phone}</span>
      {Lang}
    </div>
  );
}

/** The choice goes in the browser cookie and the server components re-render in place (as LanguageSwitch, CMP-03). */
function useChoose() {
  const t = useT();
  const router = useRouter();
  return (lang: Language) => {
    if (lang === t.lang) return;
    document.cookie = langCookie(lang);
    router.refresh();
  };
}

const keyed = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  fn();
};

/** CMP-03 in the inbox's frame form: `English | Español`, the chosen language bold. */
export function InboxLang() {
  const t = useT();
  const choose = useChoose();
  const opt = (lang: Language) =>
    t.lang === lang ? (
      <b lang={lang} aria-current="true">{t(lang === 'en' ? 'language.name.en' : 'language.name.es')}</b>
    ) : (
      <span lang={lang} role="button" tabIndex={0} aria-pressed="false" onClick={() => choose(lang)} onKeyDown={keyed(() => choose(lang))}>
        {t(lang === 'en' ? 'language.name.en' : 'language.name.es')}
      </span>
    );
  return (
    <span className="lang" data-ctl="CTL-CMP-03-01">
      {opt('en')} | {opt('es')}
    </span>
  );
}

/** CMP-03 in the reschedule frame's form: a 2-part segment. */
export function SegLang() {
  const t = useT();
  const choose = useChoose();
  const opt = (lang: Language) => (
    <span lang={lang} role="button" tabIndex={0} className={t.lang === lang ? 'on' : undefined} aria-pressed={t.lang === lang} onClick={() => choose(lang)} onKeyDown={keyed(() => choose(lang))}>
      {t(lang === 'en' ? 'language.name.en' : 'language.name.es')}
    </span>
  );
  return (
    <span className="seg" data-ctl="CTL-CMP-03-01">
      {opt('en')}
      {opt('es')}
    </span>
  );
}

/** CMP-04 in the frames' phone form: the source line, the sample note and the Demo mode marker. */
export function PhoneFoot({ info, reader, brk = false }: { info?: AppInfo | null; reader?: false; brk?: boolean }) {
  const t = useT();
  const [read, setRead] = useState<AppInfo | null>(info ?? null);
  useEffect(() => {
    if (info || reader === false) return;
    void createReader({ baseUrl: window.location.origin }).read<AppInfo>('API-02').then((r) => {
      if (r.ok) setRead(r.data);
    });
  }, [info, reader]);
  return (
    <div className="r1p-foot" data-cmp="CMP-04">
      {read ? (
        <>
          <a href={read.sourceUrl} data-ctl="CTL-CMP-04-01">{t('shell.footer.source')} {read.sourceCommit.slice(0, 7)}</a> -{' '}
        </>
      ) : null}
      <span data-ctl="CTL-CMP-04-02">{t('shell.footer.sample')}</span>
      {brk ? <br /> : ' '}
      {read?.demoMode ? <span className="demo" data-ctl="CTL-CMP-04-03">{t('shell.footer.demo')}</span> : null}
    </div>
  );
}

/** A frame message box (`.imsg` of the inbox, `.msgc` of the reschedule page). */
export function Notice({ className, icon, children, role = 'status', ctl }: { className: string; icon: IconName; children: ReactNode; role?: 'status' | 'alert'; ctl?: string }) {
  return (
    <div className={className} role={role} {...(ctl ? { 'data-ctl': ctl } : {})}>
      <Icon name={icon} />
      <span>{children}</span>
    </div>
  );
}
