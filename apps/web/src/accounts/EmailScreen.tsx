// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-EML-01 Email inbox: 1 email (frame mockups/pages/r1-eml-email.html, DK-129). The page opens 1 email by its one-time
// link (API-166, FR-AUTH-8): the first opening shows it, and every later one (a reload, another session) answers gone, so
// the page reads once and keeps the email until the person leaves. The email is a record shown as written, in the
// recipient's language (its lang attribute); the page chrome follows the page language. No email ever leaves the app.
import { useEffect, useRef, useState } from 'react';
import type { ClockAnswer } from '../shell/clock.ts';
import type { AppInfo } from '../shell/Footer.tsx';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { callRow, rows, whenText, type OpenedEmail } from './api.ts';
import { EmlFrame, MsgBox, Skeleton } from './EmlFrame.tsx';
// The page's own rules load after the kit slices its frame module imports, as the frame page orders its sheets.
import '../../styles/page-r1-eml-email.css';

export type EmailState = 'loading' | 'shown' | 'used' | 'not_valid' | 'failed';

export interface EmailScreenProps {
  token: string;
  /** Preview states: the email and the state, fixed. */
  state?: EmailState;
  email?: OpenedEmail;
  clock?: ClockAnswer | null;
  appInfo?: AppInfo | null;
}

/** The email's button words are part of the email, so they are in its own language, not the page's. */
const BUTTON: Record<'en' | 'es', Record<OpenedEmail['links'][number]['kind'], string>> = {
  en: { invite: 'Set your password', reset: 'Choose a new password', system_health: 'Open System health' },
  es: { invite: 'Elija su contraseña', reset: 'Elija una contraseña nueva', system_health: 'Abrir Estado del sistema' },
};
export const LINK_SLOT = '{link}';

export function EmailScreen({ token, state: given, email: givenEmail, clock, appInfo }: EmailScreenProps) {
  const t = useT();
  const [state, setState] = useState<EmailState>(given ?? 'loading');
  const [email, setEmail] = useState<OpenedEmail | null>(givenEmail ?? null);
  // The link opens once: 1 read per page, never repeated (a second read would answer gone).
  const read = useRef(false);

  useEffect(() => {
    if (given || read.current) return;
    read.current = true;
    void callRow(rows.emailByLink, { oneTimeToken: token }).then((r) => {
      if (r.ok) {
        setEmail(r.data);
        setState('shown');
      } else setState(r.code === 'gone' ? 'used' : r.code === 'not_found' || r.code === 'validation_failed' ? 'not_valid' : 'failed');
    });
  }, [given, token]);

  const body = (() => {
    switch (state) {
      case 'loading':
        return <Skeleton widths={['bw-w-50', null, null, 'bw-w-70']} />;
      case 'used':
        return <MsgBox kind="warnbox" icon="lock" role="alert">{t('accounts.email.used')}</MsgBox>;
      case 'not_valid':
        return <MsgBox kind="warnbox" icon="alert" role="alert">{t('accounts.email.notValid')}</MsgBox>;
      case 'failed':
        return <MsgBox kind="warnbox" icon="alert" role="alert">{t('accounts.email.failed')}</MsgBox>;
      default:
        return null;
    }
  })();

  return (
    <EmlFrame screen="SCR-EML-01" title={t('accounts.email.doc')} {...(clock !== undefined ? { clock } : {})} {...(appInfo !== undefined ? { appInfo } : {})}>
      <div className="mail">
        {state === 'shown' && email ? <Shown email={email} /> : body}
      </div>
    </EmlFrame>
  );
}

function Shown({ email }: { email: OpenedEmail }) {
  const t = useT();
  const lang = email.language;
  const paragraphs = email.body.split(/\n\n/);
  const link = email.links[0];
  const button = link ? (
    <a key="link" className="btn primary lg" href={link.href} lang={lang} data-ctl="CTL-EML-01-03">
      {BUTTON[lang][link.kind]}
    </a>
  ) : null;
  const hasSlot = paragraphs.includes(LINK_SLOT);
  return (
    <>
      <div className="whose" data-ctl="CTL-EML-01-01">
        <Icon name="message" />
        <span>{t.rich('accounts.email.whose', { address: email.inboxFor, addr: (c) => <b translate="no">{c}</b> })}</span>
      </div>
      <div className="mailbody" data-ctl="CTL-EML-01-02">
        <div className="mh">
          <h1 lang={lang}>{email.subject}</h1>
          <dl>
            <dt>{t('accounts.email.from')}</dt>
            <dd translate="no">{email.from}</dd>
            <dt>{t('accounts.email.to')}</dt>
            <dd translate="no">{email.to}</dd>
            <dd className="when">{whenText(email.sentAt, t.lang, t)}</dd>
          </dl>
        </div>
        <div className="asis">
          <Icon name="info" />
          <span>{t('accounts.email.asWritten', { name: email.recipientFirstName, language: t(`accounts.email.language.${lang}`) })}</span>
        </div>
        <div className="mb" lang={lang}>
          {paragraphs.map((p, i) => (p === LINK_SLOT ? button : <p key={i}>{p}</p>))}
          {hasSlot ? null : button}
        </div>
      </div>
      <div className="once" data-ctl="CTL-EML-01-04">
        <Icon name="lock" />
        <span>{t('accounts.email.once')}</span>
      </div>
    </>
  );
}
