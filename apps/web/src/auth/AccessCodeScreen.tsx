// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-GATE-01 Access code (frame mockups/pages/r1-gate-a-code.html, DK-82; markup DK-60 and DK-61 option A): shown in place of
// any page while the access code is on and not entered (UI-SPECIFICATION 4.2). No product data and no demo clock (UD-13,
// CMP-01 and CMP-02 are not on it). CTL-GATE-01-01 the code field, CTL-GATE-01-02 Enter, CTL-GATE-01-03 the staff Sign in link.
// Enter calls API-01; on success the page that was asked for opens (this page is rendered in its place, so a reload shows it).
import '../shell/css/gate.ts';
import { useEffect, useRef, useState } from 'react';
import { resetEndedSession } from './reset-reason.ts';
import { fieldText } from '../shell/early-form.ts';
import { Icon, Mark } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { LanguageSwitch } from '../shell/LanguageSwitch.tsx';
import { createReader, type Reader } from '../shell/reads.ts';
import { Screen } from '../shell/Surface.tsx';
import { Footer, type AppInfo } from '../shell/Footer.tsx';

export type GateState = 'empty' | 'checking' | 'wrong' | 'failed' | 'limited';

export interface AccessCodeScreenProps {
  /** A preview state (the harness build): the frame's state, with the typed code. */
  state?: GateState;
  typed?: string;
  appInfo?: AppInfo | null;
  reader?: Reader | false;
}

export function AccessCodeScreen({ state: given, typed: givenTyped = '', appInfo, reader }: AccessCodeScreenProps) {
  const t = useT();
  const [state, setState] = useState<GateState | 'idle'>(given ?? 'idle');
  const [empty, setEmpty] = useState(false);
  // F-1037 (shell/early-form.ts): the code field is uncontrolled; `kept` is what it holds after the form's reset, the code the last submit sent.
  const [kept, setKept] = useState(givenTyped);
  const [focused, setFocused] = useState(given === undefined);
  const busy = state === 'checking';
  // A reset ended the session of a person who then lands here: say so (the same words the demo strip uses). A first visit shows nothing.
  const [wasReset, setWasReset] = useState(false);
  useEffect(() => {
    if (given !== undefined || reader === false) return;
    let live = true;
    void resetEndedSession(reader || createReader({ baseUrl: window.location.origin })).then((yes) => {
      if (live && yes) setWasReset(true);
    });
    return () => {
      live = false;
    };
  }, [given, reader]);
  const sending = useRef(false);
  const message = empty ? t('auth.gate.empty') : state === 'wrong' ? t('auth.gate.wrong') : state === 'limited' ? t('auth.error.limited') : null;

  // The form's action (F-1037), an Enter tapped before hydration included: React holds that one and replays it here, with the code as typed.
  const submit = async (data: FormData) => {
    const code = fieldText(data, 'code');
    setKept(code);
    if (sending.current) return; // F-1064: a ref, read by every replayed submit alike
    if (code.trim() === '') {
      setEmpty(true); // an empty field gets its message without a call
      return;
    }
    setEmpty(false);
    sending.current = true;
    setState('checking');
    const r = await (reader || createReader({ baseUrl: window.location.origin })).read('API-01', { code });
    if (r.ok) {
      window.location.reload();
      return;
    }
    sending.current = false;
    setState(r.code === 'code_invalid' ? 'wrong' : r.code === 'rate_limited' ? 'limited' : 'failed');
  };

  return (
    <Screen
      screen="SCR-GATE-01" surface="SURF-GATE" className="g-a code" noClock footer={false} title={t('auth.gate.doc')}
      {...(appInfo !== undefined ? { appInfo } : {})} {...(reader !== undefined ? { reader } : {})}
    >
      <aside className="side on-dark">
        <span className="brand">
          <Mark />
          <span className="word">
            {t('brand.name')}
            <small>{t('brand.trade')}</small>
          </span>
        </span>
        <div className="sideprod">{t('brand.product')}</div>
        <h1 className="tag">
          {t('auth.tag.a')} <em>{t('auth.tag.b')}</em>
        </h1>
        <p className="sidep">{t('auth.gate.side')}</p>
        <svg className="drop" viewBox="0 0 32 32" aria-hidden="true">
          <path d="M16 1.8C16 1.8 5.4 13.2 5.4 19.9C5.4 25.8 10.1 30.2 16 30.2C21.9 30.2 26.6 25.8 26.6 19.9C26.6 13.2 16 1.8 16 1.8Z" fill="#fff" fillOpacity=".06" />
        </svg>
      </aside>
      <main className="mainp">
        <div className="topr">
          <LanguageSwitch />
        </div>
        <div className="box">
          <h2>{t('auth.gate.title')}</h2>
          {wasReset ? <p className="lead" role="status" data-reason="world-reset">{t('alert.world_reset')}</p> : null}
          <p className="lead">{t('auth.gate.why')}</p>
          <form className="codeform" action={(data) => void submit(data)} noValidate>
            <div className="r1-field" data-ctl="CTL-GATE-01-01">
              <label htmlFor="code">{t('auth.gate.label')}</label>
              <div className={`r1-input${message ? ' bad' : focused ? ' focus' : ''}`}>
                <Icon name="lock" />
                <input
                  id="code" name="code" type="password" className="bw-field-input" autoComplete="off" autoFocus={given === undefined}
                  placeholder={t('auth.gate.placeholder')} defaultValue={kept} aria-invalid={message ? true : undefined}
                  onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
                />
              </div>
              {message ? (
                <div className="r1-fmsg" role="alert">
                  <Icon name="alert" />
                  {message}
                </div>
              ) : null}
            </div>
            {state === 'failed' ? (
              <div className="r1-errpanel" role="alert" data-ctl="CTL-GATE-01-02">
                <Icon name="alert" />
                <div>
                  <b>{t('auth.gate.failed.title')}</b>
                  {t('auth.gate.failed.body')}
                </div>
              </div>
            ) : null}
            {/* F-285: the Enter button stays in the failed state, so a pointer or touch user has a retry control (CTL-GATE-01-02). */}
            <button type="submit" className={`btn primary lg enter${busy ? ' busy wide' : ''}`} aria-busy={busy || undefined} data-ctl="CTL-GATE-01-02">
              {busy ? <span className="r1-spin" /> : null}
              {busy ? t('auth.gate.checking') : t('auth.gate.enter')}
            </button>
          </form>
          <p className="staff">
            {t('auth.gate.staff')}{' '}
            <a className="r1-link" href="/sign-in" data-ctl="CTL-GATE-01-03">
              {t('auth.signIn')}
            </a>
          </p>
        </div>
        <Footer demoMarker={false} {...(appInfo !== undefined ? { info: appInfo } : {})} {...(reader !== undefined ? { reader } : {})} />
      </main>
    </Screen>
  );
}
