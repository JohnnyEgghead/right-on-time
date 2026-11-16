// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-TEC-01 Technician sign-in at `/tech/sign-in` (frame DK-106 mockups/pages/tech-signin.html; UI-SPECIFICATION 8): the email or
// employee number and password form over API-03 (CTL-TEC-01-01 to -04, -07, -08, -09), the demo Sign in as list over API-04 and API-05
// (CTL-TEC-01-05; demo mode on and the access code entered or off), and the sign-in name locked to the waiting technician while items
// wait (UD-20). Stay signed in is off by default and rides on Sign in and Sign in as (FR-AUTH-10). A technician lands on Today (UD-14).
import '../shell/css/phone.ts';
import '../../styles/page-tech-signin.css';
import '../../styles/app/tech-signin.css';
import { DexieItemStore } from '@bw/outbox/src/items/index.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { safeReturn } from '../auth/return-path.ts';
import type { SamplePerson } from '../auth/SignInScreen.tsx';
import type { ClockAnswer } from '../shell/clock.ts';
import { branchById } from '../shell/branches.ts';
import { DemoStrip } from '../shell/DemoStrip.tsx';
import { fieldFlag, fieldText } from '../shell/early-form.ts';
import type { AppInfo } from '../shell/Footer.tsx';
import { Icon, Mark } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { PhoneFoot } from '../inbox/PhoneParts.tsx';
import { LanguageSwitch } from '../shell/LanguageSwitch.tsx';
import { createReader, type Reader } from '../shell/reads.ts';
import { TechFrame } from '../shell/TechFrame.tsx';
import { savedDay, signInRecorded } from './local.ts';
import { loginKey } from './model.ts';
import { clearSignOutOwed } from './session.ts';

export type TechSignInMessage = 'bad' | 'off' | 'set' | 'returned' | 'limited' | 'failed' | 'unsaved' | null;
export const LOGIN_KEY = 'bw.tech.login';
/** A person picked from the sample list (Sign in as) is kept under LOGIN_KEY as this prefix and the person's id, so a different pick also forgets the last person's copies (F-1017). */
const PICKED = 'as:';
const OFFICE_PHONE = '(614) 555-0100';
/** The version the app footer names (CTL-TEC-01-09); the web app is the pilot's first release. */
export const APP_VERSION = '1.0.1';

export interface TechSignInProps {
  returnTo?: string | null;
  returned?: boolean;
  /** SCR-EML-02 saved a password and opened this page with `?set=1` (F-616): "Your password is set. Sign in." */
  passwordSet?: boolean;
  /** Preview states (the harness build): API-02's answer, the list, the message, the busy button and the typed values, fixed. */
  info?: AppInfo | null;
  people?: SamplePerson[] | null;
  message?: TechSignInMessage;
  busy?: boolean;
  typed?: string;
  typedPassword?: boolean;
  stay?: boolean;
  focusPassword?: boolean;
  /** Preview: items wait for this technician (UD-20). */
  waiting?: { count: number; name: string } | null;
  clock?: ClockAnswer | null;
  reader?: Reader | false;
  /** A preview tile: drawn as the frames' states boards draw a state (`.screen.r1p-mini`). */
  mini?: boolean;
}

const HOME: Record<SamplePerson['role'], string> = { manager: '/office/board', office: '/office/board', technician: '/tech' };

/** UD-20: items wait on this phone for the technician who signed in last: the sign-in name is theirs. */
interface WaitLock {
  /** Items waiting; 0 when the item store could not be read (F-1067), which keeps the lock without a count. */
  count: number;
  name: string;
  login: string;
  /** The person id when the saved login is a Sign in as pick (F-1066), else null. */
  pick: string | null;
}


export function TechSignIn(p: TechSignInProps) {
  const t = useT();
  const preview = p.info !== undefined;
  const [info, setInfo] = useState<AppInfo | null>(p.info ?? null);
  const [people, setPeople] = useState<SamplePerson[] | null>(p.people ?? null);
  // F-1037 (shell/early-form.ts): the 2 fields are uncontrolled; `kept` is what they hold after the form's reset, the values the last submit sent.
  // F-1063: Stay signed in is a native checkbox too, read from the tap's FormData (a tap before hydration ticks it with no script), and from the box itself for Sign in as.
  const [kept, setKept] = useState({ login: p.typed ?? '', password: p.typedPassword ? 'password-sample' : '', stay: p.stay ?? false });
  const stayField = useRef<HTMLInputElement>(null);
  const loginField = useRef<HTMLInputElement>(null);
  const passwordField = useRef<HTMLInputElement>(null);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(p.busy ?? false);
  const [pressed, setPressed] = useState<string | null>(null);
  const [focus, setFocus] = useState<'login' | 'password' | null>(p.focusPassword ? 'password' : null);
  const [message, setMessage] = useState<TechSignInMessage>(p.message ?? (p.passwordSet ? 'set' : p.returned ? 'returned' : null));
  const [empty, setEmpty] = useState<{ login?: boolean; password?: boolean }>({});
  const [waiting, setWaiting] = useState<{ count: number; name: string; pick?: string | null } | null>(p.waiting ?? null);
  // F-1064: the in-flight guard is a ref: React replays every submit it held before hydration in 1 task, each reading the same render's busy.
  const sending = useRef(false);
  const read = useCallback(() => p.reader || createReader({ baseUrl: window.location.origin }), [p.reader]);

  useEffect(() => {
    if (preview || p.reader === false) return;
    void read().read<AppInfo>('API-02').then((r) => {
      if (r.ok) setInfo(r.data);
    });
  }, [preview, p.reader, read]);
  const demo = info?.demoMode === true;
  useEffect(() => {
    if (p.people !== undefined || p.reader === false || !demo) return;
    void read().read<{ people: SamplePerson[] }>('API-04', { app: 'tech' }).then((r) => setPeople(r.ok ? r.data.people : null));
  }, [p.people, p.reader, demo, read]);
  // UD-20: items still wait on this phone, so the name is the waiting technician's and cannot be changed. Asked once: the same answer
  // holds a sign-in sent before it came back (F-1037: a tap made before hydration is replayed as soon as the form hydrates).
  const waitCheck = useRef<Promise<WaitLock | null> | null>(null);
  const waitLock = useCallback((): Promise<WaitLock | null> => {
    if (preview || p.reader === false) return Promise.resolve(null);
    waitCheck.current ??= (async () => {
      try {
        const saved = localStorage.getItem(LOGIN_KEY);
        const named = (count: number): WaitLock => ({
          count,
          login: saved !== null && !saved.startsWith(PICKED) ? saved : '',
          pick: saved !== null && saved.startsWith(PICKED) ? saved.slice(PICKED.length) : null,
          name: savedDay()?.data.technician.name ?? saved ?? '',
        });
        if (typeof indexedDB === 'undefined') return null; // no item store here: nothing waits
        try {
          const items = await new DexieItemStore().waiting();
          return items.length === 0 ? null : named(items.length);
        } catch {
          // F-1067: a read that failed is not "nothing waits": the last person's name stays the only one (UD-20); with nobody saved there is nobody to lock to
          return saved === null ? null : named(0);
        }
      } catch {
        return null; // storage is blocked: nothing is known to wait
      }
    })();
    return waitCheck.current;
  }, [preview, p.reader]);
  useEffect(() => {
    void waitLock().then((lock) => {
      if (lock === null) return;
      if (loginField.current) loginField.current.value = lock.login;
      setKept((k) => ({ ...k, login: lock.login }));
      setWaiting({ count: lock.count, name: lock.name, pick: lock.pick });
    });
  }, [waitLock]);

  const land = (role: SamplePerson['role']) => window.location.assign(safeReturn(p.returnTo) ?? HOME[role]);
  // F-1017: the person's copies (the saved day, the job screens' copies) go when the user signed in is not theirs, compared by user id
  // (local.ts personSignedIn), never by the typed login, which differs for 1 person signing in by email and by employee number.
  const signedIn = async (user: { id: string; role: SamplePerson['role'] }, typed: string) => {
    clearSignOutOwed(); // F-1042: only a sign-in voids a sign-out owed (a job screen's API-07 answer does not)
    await signInRecorded(user.id, () => setMessage('unsaved')); // F-1241: said on this screen; the landing is not held
    try {
      localStorage.setItem(LOGIN_KEY, typed);
    } catch {
      // no storage: the login field starts empty next time
    }
    land(user.role);
  };
  const failed = (code: string | undefined) => {
    sending.current = false;
    setBusy(false);
    setPressed(null);
    if (code === 'credentials_invalid') {
      setMessage('bad');
      if (passwordField.current) passwordField.current.value = '';
      setKept((k) => ({ ...k, password: '' }));
    } else if (code === 'account_turned_off') setMessage('off');
    else if (code === 'rate_limited') setMessage('limited');
    else setMessage('failed');
  };

  // The form's action (F-1037), a tap made before hydration included: React holds that one and replays it here. The fields come from the
  // tap's FormData, and are kept first, so the form's reset after this action gives them back as sent.
  const submit = async (data: FormData) => {
    const typed = { login: fieldText(data, 'login'), password: fieldText(data, 'password'), stay: fieldFlag(data, 'stay') };
    setKept(typed);
    if (sending.current) return;
    const errs = { login: typed.login.trim() === '', password: typed.password === '' };
    setEmpty(errs);
    if (errs.login || errs.password) return;
    sending.current = true;
    setBusy(true);
    setMessage(null);
    // UD-20: a sign-in sent before the waiting-items check answered waits for it, and never signs in another name while items wait.
    // The names compare as the server matches them (F-1065); a refusal says why: the page shows the waiting notice (UD-20).
    const lock = await waitLock();
    if (lock !== null && (lock.pick !== null || loginKey(typed.login) !== loginKey(lock.login))) {
      sending.current = false;
      setBusy(false);
      setWaiting({ count: lock.count, name: lock.name, pick: lock.pick });
      return;
    }
    const r = await read().read<{ user: { id: string; role: SamplePerson['role'] } }>('API-03', { login: typed.login.trim(), password: typed.password, client: 'web', keepSignedIn: typed.stay });
    if (r.ok) await signedIn(r.data.user, typed.login.trim());
    else failed(r.code);
  };
  const signInAs = async (who: SamplePerson) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setPressed(who.personId);
    setMessage(null);
    // UD-20 (F-1065, F-1066): with items waiting, only the waiting technician's own pick signs in; the check is waited for like the form's.
    const lock = await waitLock();
    if (lock !== null && lock.pick !== who.personId) {
      sending.current = false;
      setBusy(false);
      setPressed(null);
      setWaiting({ count: lock.count, name: lock.name, pick: lock.pick });
      return;
    }
    const r = await read().read<{ user: { id: string; role: SamplePerson['role'] } }>('API-05', { personId: who.personId, keepSignedIn: stayField.current?.checked ?? kept.stay });
    if (r.ok) await signedIn(r.data.user, `${PICKED}${who.personId}`);
    else failed(r.code);
  };

  const formBusy = busy && pressed === null;
  const calm = message === 'set' || message === 'returned';
  const words: Record<NonNullable<TechSignInMessage>, string> = {
    bad: t('tech.signin.bad'), off: t('auth.signin.off'), set: t('auth.signin.passwordSet'), returned: t('auth.signin.returned'), limited: t('auth.error.limited'), failed: t('auth.signin.failed'), unsaved: t('auth.signin.unsaved'),
  };
  const locked = waiting !== null;
  // F-1066: locked to a Sign in as pick, the list holds that person alone; locked to a typed name, no list.
  const pickId = waiting?.pick ?? null;
  const shownPeople = !locked ? people ?? [] : pickId !== null ? (people ?? []).filter((w) => w.personId === pickId) : [];

  return (
    <TechFrame screen="SCR-TEC-01" noClock {...(p.reader !== undefined ? { reader: p.reader } : {})} {...(p.clock !== undefined ? { clock: p.clock } : {})}>
      <title>{t('auth.signin.doc')}</title>
      <div className={`screen bw-tech bw-tech-signin${p.mini ? ' r1p-mini' : ''}`}>
        <div className="hero">
          <div className="bigmark"><Mark /></div>
          <div className="co">{t('brand.name')} {t('brand.trade')}</div>
          <h1>{t('brand.product')}</h1>
          <div className="d">{t('tech.signin.app')}</div>
          <DemoStrip variant="header" {...(p.clock !== undefined ? { initial: p.clock } : {})} {...(p.reader === false ? { reader: false as const } : {})} />
          <LanguageSwitch className="hlang" />
        </div>
        <form className="form" action={(data) => void submit(data)} noValidate>
          <h2>{t('auth.signIn')}</h2>
          <p className="lead">{t('tech.signin.lead')}</p>
          {message ? <div className={`msg ${calm ? 'info' : 'bad'}`} role={calm ? 'status' : 'alert'}><Icon name={message === 'off' ? 'lock' : message === 'set' ? 'check' : calm ? 'info' : 'alert'} /><span>{words[message]}</span></div> : null}
          {/* F-1126: a lock with count 0 is the failed item-store read (F-1067): the name is still locked, so the page says why without a count. */}
          {waiting ? <div className="msg info" role="status"><Icon name="info" /><span>{waiting.count > 0 ? t('tech.signin.waiting', { n: waiting.count, name: waiting.name }) : t('tech.signin.waitingUnknown', { name: waiting.name })}</span></div> : null}
          <div className="fld" data-ctl="CTL-TEC-01-01">
            <div className="lbl" id="ts-login-l">{t('tech.signin.login')}</div>
            <div className={`inp${message === 'bad' ? ' bad' : ''}${locked ? ' locked' : ''}${focus === 'login' ? ' focus' : ''}`}>
              <Icon name={locked ? 'lock' : 'user'} />
              <input ref={loginField} id="ts-login" aria-labelledby="ts-login-l" name="login" type="text" inputMode="email" className="bw-field-input" autoComplete="username" autoCapitalize="none" spellCheck={false}
                defaultValue={kept.login} readOnly={locked} aria-invalid={empty.login || undefined} translate="no"
                onFocus={() => setFocus('login')} onBlur={() => setFocus(null)} />
            </div>
            {empty.login ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{t('tech.signin.loginEmpty')}</div> : null}
          </div>
          <div className="fld" data-ctl="CTL-TEC-01-02">
            <div className="lbl" id="ts-password-l">{t('auth.signin.passwordLabel')}</div>
            <div className={`inp${message === 'bad' ? ' bad' : ''}${focus === 'password' ? ' focus' : ''}`}>
              <Icon name="lock" />
              <input ref={passwordField} id="ts-password" aria-labelledby="ts-password-l" name="password" type={show ? 'text' : 'password'} className="bw-field-input dots" autoComplete="current-password"
                defaultValue={kept.password} aria-invalid={empty.password || undefined}
                onFocus={() => setFocus('password')} onBlur={() => setFocus(null)} />
              <span className="show" role="button" tabIndex={0} aria-pressed={show} data-ctl="CTL-TEC-01-03" onClick={() => setShow(!show)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShow(!show); } }}>
                {show ? t('auth.signin.hide') : t('auth.signin.show')}
              </span>
            </div>
            {empty.password ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{t('auth.signin.passwordEmpty')}</div> : null}
          </div>
          <label className="stay">
            <input type="checkbox" name="stay" className="bw-stay-cb" defaultChecked={kept.stay} ref={stayField} data-ctl="CTL-TEC-01-08" />
            <span className="box" aria-hidden="true"><Icon name="check" sw={3} /></span>
            <div><b>{t('tech.signin.stay')}</b><small>{t('tech.signin.stayNote')}</small></div>
          </label>
          <button type="submit" className={`go${formBusy ? ' busy' : ''}`} aria-busy={formBusy || undefined} data-ctl="CTL-TEC-01-04">
            {formBusy ? <span className="r1-spin" /> : <Icon name="lock" sw={2.2} />}
            {formBusy ? t('auth.signin.busy') : t('auth.signIn')}
          </button>
          {demo && people && people.length > 0 && shownPeople.length > 0 ? (
            <div className="sia" data-ctl="CTL-TEC-01-05">
              <h3>{t('tech.signin.demo')}</h3>
              {shownPeople.map((who) => (
                <div className="r" key={who.personId} role="button" tabIndex={0} aria-busy={pressed === who.personId || undefined}
                  onClick={() => void signInAs(who)} onKeyDown={(e) => { if (e.key === 'Enter') void signInAs(who); }}>
                  <b translate="no">{who.name}</b>
                  {/* F-1138 (owner ruling 6c62973f, "Español everywhere"; DK-106 v0.8, "Columbus - Español"): a person's language is shown by its own
                      name in either page language, as the office sign-in does; the branch is shown as the frame draws it. */}
                  <small>{branchById(who.branch).name} - {t(who.language === 'es' ? 'language.name.es' : 'language.name.en')}</small>
                  <Icon name="chevRight" />
                </div>
              ))}
            </div>
          ) : null}
          <div className="forgot">
            <a href="/forgot-password?app=tech" data-ctl="CTL-TEC-01-07">{t('auth.signin.forgot')}</a>
            <br /><b>{t('tech.signin.call', { phone: OFFICE_PHONE })}</b>
          </div>
          <div className="foot" data-ctl="CTL-TEC-01-09"><Icon name="phone" />{t('tech.signin.phones')}<br />{t('tech.signin.version', { version: APP_VERSION })}</div>
          <PhoneFoot {...(p.info ? { info: p.info } : {})} {...(p.reader === false ? { reader: false as const } : {})} brk />
        </form>
      </div>
    </TechFrame>
  );
}
