// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-EML-02 Set a password (frame mockups/pages/r1-eml-setpw.html, DK-130), opened by the password link of an invite or a
// reset email. API-167 says whose password it sets; API-168 stores it as a hash only and opens the sign-in page of the
// user's app with "Your password is set. Sign in." (FR-AUTH-3, FR-AUTH-9, FR-AUTH-12). The rules are SD-29's: 10 to 128
// characters, not the email, not 1 repeated character (the frame's sample rules, GAP-27, are replaced by them).
import { PASSWORD_MAX, PASSWORD_MIN } from '@bw/api';
import { useEffect, useState, type FormEvent } from 'react';
import { branchById } from '../shell/branches.ts';
import type { ClockAnswer } from '../shell/clock.ts';
import type { AppInfo } from '../shell/Footer.tsx';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { callRow, initialsOf, rows, type PasswordLinkInfo } from './api.ts';
import { EmlFrame, MsgBox, Skeleton } from './EmlFrame.tsx';
// The page's own rules load after the kit slices its frame module imports, as the frame page orders its sheets.
import '../../styles/page-r1-eml-setpw.css';

export type SetPasswordState = 'loading' | 'ready' | 'saving' | 'ended' | 'turned_off' | 'not_valid' | 'failed' | 'limited';

export interface SetPasswordProps {
  token: string;
  /** Preview states: the link's answer and the state, fixed. */
  state?: SetPasswordState;
  info?: PasswordLinkInfo;
  typed?: string;
  clock?: ClockAnswer | null;
  appInfo?: AppInfo | null;
}

/** The SD-29 rules in the order the page lists them; each is met or not for the typed text. */
/** The page does not know the address: the server checks it, and `emailRefused` marks that rule unmet after its refusal. */
function passwordRules(typed: string, emailRefused = false): { key: 'length' | 'notEmail' | 'notOneCharacter'; met: boolean }[] {
  return [
    { key: 'length', met: typed.length >= PASSWORD_MIN && typed.length <= PASSWORD_MAX },
    { key: 'notEmail', met: typed.length > 0 && !emailRefused },
    { key: 'notOneCharacter', met: new Set(typed).size > 1 },
  ];
}

const signInAfter = (app: 'office' | 'tech') => `${app === 'tech' ? '/tech/sign-in' : '/sign-in'}?set=1`;

export function SetPasswordScreen({ token, state: given, info: givenInfo, typed = '', clock, appInfo }: SetPasswordProps) {
  const t = useT();
  const [state, setState] = useState<SetPasswordState>(given ?? 'loading');
  const [info, setInfo] = useState<PasswordLinkInfo | null>(givenInfo ?? null);
  const [password, setPassword] = useState(typed);
  const [show, setShow] = useState(false);
  const [focused, setFocused] = useState(given === 'ready');
  const [broken, setBroken] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    if (given) return;
    void callRow(rows.passwordLink, { passwordToken: token }).then((r) => {
      if (r.ok) {
        setInfo(r.data);
        setState('ready');
      } else setState(r.code === 'gone' ? 'ended' : r.code === 'account_turned_off' ? 'turned_off' : r.code === 'not_found' || r.code === 'validation_failed' ? 'not_valid' : 'failed');
    });
  }, [given, token]);

  const ruleList = passwordRules(password, refused !== null && refused === password);
  const allMet = ruleList.every((r) => r.met);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (state !== 'ready' || !info) return;
    if (!allMet) {
      setBroken(true);
      return;
    }
    setState('saving');
    const r = await callRow(rows.setPassword, { passwordToken: token, password });
    if (r.ok) {
      window.location.assign(signInAfter(r.data.app));
      return;
    }
    if (r.code === 'validation_failed') {
      setBroken(true);
      setRefused(password);
      setState('ready');
    } else setState(r.code === 'gone' ? 'ended' : r.code === 'account_turned_off' ? 'turned_off' : r.code === 'not_found' ? 'not_valid' : r.code === 'rate_limited' ? 'limited' : 'failed');
  };

  const invite = info?.kind !== 'reset';
  const branch = info ? branchById(info.user.branch).name : '';
  const body = (() => {
    switch (state) {
      case 'loading':
        return <Skeleton widths={['bw-w-40', null, 'bw-w-80']} />;
      case 'ended':
        return <MsgBox kind="warnbox" icon="clock" role="alert">{t('accounts.setpw.ended')}</MsgBox>;
      case 'turned_off':
        return <MsgBox kind="warnbox" icon="lock" role="alert">{t('accounts.setpw.turnedOff')}</MsgBox>;
      case 'not_valid':
        return <MsgBox kind="warnbox" icon="alert" role="alert">{t('accounts.setpw.notValid')}</MsgBox>;
      default:
        return null;
    }
  })();

  return (
    <EmlFrame
      screen="SCR-EML-02" title={t('accounts.setpw.doc')} {...(info ? { branch: info.user.branch } : {})}
      {...(clock !== undefined ? { clock } : {})} {...(appInfo !== undefined ? { appInfo } : {})}
    >
      <div className="pcard pw">
        <h1>{invite ? t('accounts.setpw.title') : t('accounts.setpw.titleReset')}</h1>
        <p className="lead">{t('accounts.setpw.lead')}</p>
        {body}
        {info && (state === 'ready' || state === 'saving' || state === 'failed' || state === 'limited') ? (
          <form onSubmit={(e) => void save(e)} noValidate>
            <div className="who" data-ctl="CTL-EML-02-01">
              <span className="av" translate="no">{initialsOf(info.user.name)}</span>
              <span>
                <b>{t.rich(invite ? 'accounts.setpw.for' : 'accounts.setpw.forReset', { name: info.user.name, who: (c) => <span translate="no">{c}</span> })}</b>
                <span>{t('shell.role.withBranch', { role: t(`shell.role.${info.user.role}`), branch })}</span>
              </span>
            </div>
            <div className="r1-field" data-ctl="CTL-EML-02-02">
              <label htmlFor="sp-password">
                {t('accounts.setpw.label')} <span className="muted">{t('accounts.field.required')}</span>
              </label>
              <div className={`r1-input${broken && !allMet ? ' bad' : focused ? ' focus' : ''}`}>
                <Icon name="lock" />
                <input
                  id="sp-password" name="password" type={show ? 'text' : 'password'} className="bw-field-input" autoComplete="new-password"
                  value={password} maxLength={PASSWORD_MAX} aria-describedby="sp-rules" aria-invalid={(broken && !allMet) || undefined}
                  onChange={(e) => setPassword(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
                />
                <button type="button" className="tail bw-btn-reset" data-ctl="CTL-EML-02-03" aria-pressed={show} onClick={() => setShow(!show)}>
                  {show ? t('accounts.setpw.hide') : t('accounts.setpw.show')}
                </button>
              </div>
              <ul className="rules" id="sp-rules">
                {ruleList.map((r) => (
                  <li key={r.key} className={r.met ? undefined : 'no'}>
                    <Icon name="check" sw={2.6} />
                    {t(`accounts.setpw.rule.${r.key}`, { min: PASSWORD_MIN })}
                  </li>
                ))}
              </ul>
              {broken && !allMet ? (
                <div className="r1-fmsg" role="alert">
                  <Icon name="alert" />
                  {t('accounts.setpw.broken')}
                </div>
              ) : null}
            </div>
            {state === 'failed' ? <MsgBox kind="warnbox" icon="alert" role="alert">{t('accounts.setpw.failed')}</MsgBox> : null}
            {state === 'limited' ? <MsgBox kind="warnbox" icon="alert" role="alert">{t('auth.error.limited')}</MsgBox> : null}
            <button type="submit" className={`btn primary lg save${state === 'saving' ? ' busy' : ''}`} aria-busy={state === 'saving' || undefined} data-ctl="CTL-EML-02-04">
              {state === 'saving' ? <span className="r1-spin" /> : null}
              {state === 'saving' ? t('accounts.setpw.saving') : t('accounts.setpw.save')}
            </button>
          </form>
        ) : null}
      </div>
    </EmlFrame>
  );
}
