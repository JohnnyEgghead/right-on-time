// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-EML-03 Forgot password, web (frame mockups/pages/r1-eml-forgot.html, DK-131). Opened from the staff sign-in page and
// the technician app (`?app=office|tech`, CTL-EML-03-05 goes back to that app's sign-in page). API-165 answers sent with a
// one-time link (shown here once, opened in a new tab), or why nothing was sent: no account, turned off, or reset
// protection on (FR-AUTH-9, OI-21, OI-45; owner ruling 5a554f12 refuses sample people while demo mode is on).
import { useRef, useState } from 'react';
import type { ClockAnswer } from '../shell/clock.ts';
import { fieldText } from '../shell/early-form.ts';
import type { AppInfo } from '../shell/Footer.tsx';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { callRow, rows } from './api.ts';
import { EmlFrame, MsgBox } from './EmlFrame.tsx';
// The page's own rules load after the kit slices its frame module imports, as the frame page orders its sheets.
import '../../styles/page-r1-eml-forgot.css';

export type ForgotState = 'default' | 'sending' | 'sent' | 'no_account' | 'turned_off' | 'not_available' | 'limited' | 'failed';

export interface ForgotScreenProps {
  app: 'office' | 'tech';
  /** Preview states (the harness build). */
  state?: ForgotState;
  email?: string;
  link?: string | null;
  clock?: ClockAnswer | null;
  appInfo?: AppInfo | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ForgotScreen({ app, state: given, email: givenEmail = '', link: givenLink = null, clock, appInfo }: ForgotScreenProps) {
  const t = useT();
  const [state, setState] = useState<ForgotState>(given ?? 'default');
  // F-1037 (shell/early-form.ts): the email field is uncontrolled; `kept` is what it holds after the form's reset, the text the last submit sent.
  const [kept, setKept] = useState(givenEmail);
  const [sentTo, setSentTo] = useState(givenEmail);
  const [link, setLink] = useState<string | null>(givenLink);
  const [linkUsed, setLinkUsed] = useState(false);
  const [bad, setBad] = useState(false);
  const busy = state === 'sending';
  // F-1064: the in-flight guard is a ref; React replays every submit it held before hydration in 1 task, each reading the same render's busy.
  const sending = useRef(false);

  // The form's action (F-1037), a tap made before hydration included: React holds that one and replays it here, with the email as typed.
  const submit = async (data: FormData) => {
    const email = fieldText(data, 'email');
    setKept(email);
    if (sending.current) return;
    const typed = email.trim();
    if (!EMAIL.test(typed)) {
      setBad(true);
      return;
    }
    setBad(false);
    sending.current = true;
    setState('sending');
    setLinkUsed(false);
    const r = await callRow(rows.requestReset, { email: typed, app }).finally(() => {
      sending.current = false;
    });
    if (!r.ok) {
      setLink(null);
      setState(r.code === 'rate_limited' ? 'limited' : r.code === 'validation_failed' ? (setBad(true), 'default') : 'failed');
      return;
    }
    setSentTo(typed);
    setLink(r.data.emailLink);
    setState(r.data.sent ? 'sent' : r.data.reason === 'no_account' ? 'no_account' : r.data.reason === 'account_turned_off' ? 'turned_off' : 'not_available');
  };

  const result = (() => {
    switch (state) {
      case 'sent':
        return (
          <MsgBox kind="okbox" icon="check">
            <b>{t.rich('accounts.forgot.sent', { address: sentTo, addr: (c) => <span translate="no">{c}</span> })}</b>
            {link && !linkUsed ? (
              <a href={link} target="_blank" rel="noopener noreferrer" data-ctl="CTL-EML-03-04" onClick={() => setLinkUsed(true)}>
                <Icon name="message" />
                {t('accounts.forgot.open')}
              </a>
            ) : (
              <span className="bw-used">{t('accounts.linkUsed')}</span>
            )}
          </MsgBox>
        );
      case 'no_account':
        return <MsgBox kind="infobox2" icon="info">{t('accounts.forgot.noAccount')}</MsgBox>;
      case 'turned_off':
        return <MsgBox kind="infobox2" icon="lock">{t('accounts.forgot.turnedOff')}</MsgBox>;
      case 'not_available':
        return <MsgBox kind="infobox2" icon="lock">{t('accounts.forgot.notAvailable')}</MsgBox>;
      case 'limited':
        return <MsgBox kind="warnbox" icon="alert">{t('auth.error.limited')}</MsgBox>;
      case 'failed':
        return <MsgBox kind="warnbox" icon="alert">{t('accounts.forgot.failed')}</MsgBox>;
      default:
        return null;
    }
  })();

  return (
    <EmlFrame screen="SCR-EML-03" title={t('accounts.forgot.doc')} {...(clock !== undefined ? { clock } : {})} {...(appInfo !== undefined ? { appInfo } : {})}>
      <div className="pcard fp">
        <h1>{t('accounts.forgot.title')}</h1>
        <p className="lead">{t('accounts.forgot.lead')}</p>
        <form action={(data) => void submit(data)} noValidate>
          <div className="r1-field" data-ctl="CTL-EML-03-01">
            <label htmlFor="fp-email">
              {t('accounts.field.email')} <span className="muted">{t('accounts.field.required')}</span>
            </label>
            <div className={`r1-input${bad ? ' bad' : ''}`}>
              <Icon name="message" />
              <input
                id="fp-email" name="email" type="email" className="bw-field-input" autoComplete="email" spellCheck={false} translate="no"
                defaultValue={kept} aria-invalid={bad || undefined} aria-describedby={bad ? 'fp-email-msg' : undefined}
              />
            </div>
            {bad ? (
              <div className="r1-fmsg" role="alert" id="fp-email-msg">
                <Icon name="alert" />
                {t('accounts.field.notEmail')}
              </div>
            ) : null}
          </div>
          <button type="submit" className={`btn primary lg${busy ? ' busy' : ''}`} aria-busy={busy || undefined} data-ctl="CTL-EML-03-02">
            {busy ? <span className="r1-spin" /> : null}
            {busy ? t('accounts.forgot.sending') : t('accounts.forgot.send')}
          </button>
        </form>
        <div className="res" role="status" aria-live="polite" data-ctl="CTL-EML-03-03">
          {result}
        </div>
        <a className="backl" href={app === 'tech' ? '/tech/sign-in' : '/sign-in'} data-ctl="CTL-EML-03-05">
          <Icon name="back" />
          {t('accounts.forgot.back')}
        </a>
      </div>
    </EmlFrame>
  );
}
