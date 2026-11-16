// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-01 Staff sign-in, with Sign in as (frame mockups/pages/office-signin.html, DK-84): the email and password form
// (CTL-OFC-01-01 to -04, -07, -08) over API-03, the Sign in as list (CTL-OFC-01-05) over API-04 and API-05 only with demo mode
// on (API-02) and the access code entered or off, the notice and help text (CTL-OFC-01-09, -10) and the customer link (-06).
// Office and manager land on the dispatch board (or the page `return` names), a technician on Today (UD-14).
import '../shell/css/signin.ts';
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { branchById } from '../shell/branches.ts';
import { fieldFlag, fieldText } from '../shell/early-form.ts';
import type { AppInfo } from '../shell/Footer.tsx';
import { Icon, Mark } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { LanguageSwitch } from '../shell/LanguageSwitch.tsx';
import type { ClockAnswer } from '../shell/clock.ts';
import { createReader, type Reader } from '../shell/reads.ts';
import { safeReturn } from './return-path.ts';
import { Screen } from '../shell/Surface.tsx';

export interface SamplePerson {
  personId: string;
  name: string;
  job: string;
  role: 'manager' | 'office' | 'technician';
  branch: string;
  language: 'en' | 'es';
}
/** `hidden`: API-04 answered access_code_required, so the list is not shown until the code is entered (CTL-OFC-01-05, OI-28). */
export type PeopleList = 'loading' | 'error' | 'hidden' | SamplePerson[];
export type SignInMessage = 'bad' | 'off' | 'returned' | 'set' | 'limited' | 'failed' | 'unsaved' | null;

export interface SignInScreenProps {
  /** Where to go after signing in: a path on this origin (the page gate's `return`), or none. */
  returnTo?: string | null;
  /** The person was sent back here (the page gate's redirect). */
  returned?: boolean;
  /** P4-ACCOUNTS: SCR-EML-02 saved a password and opened this page (`?set=1`): "Your password is set. Sign in." */
  passwordSet?: boolean;
  /** Preview states (the harness build): API-02's answer, API-04's state, the message and the busy button, fixed. */
  info?: AppInfo | null;
  people?: PeopleList;
  message?: SignInMessage;
  busy?: boolean;
  typedEmail?: string;
  /** Preview: the password field shows focused, as the frame's Default does. */
  focusPassword?: boolean;
  /** Preview: the demo clock's first read, fixed. */
  clock?: ClockAnswer | null;
  reader?: Reader | false;
}

const initials = (name: string) => name.split(/\s+/).map((p) => p[0] ?? '').join('').slice(0, 2).toUpperCase();
const HOME: Record<SamplePerson['role'], string> = { manager: '/office/board', office: '/office/board', technician: '/tech' };

export function SignInScreen({ returnTo = null, returned = false, passwordSet = false, info: givenInfo, people: givenPeople, message: givenMessage, busy: givenBusy = false, typedEmail = '', focusPassword = false, clock, reader }: SignInScreenProps) {
  const t = useT();
  const preview = givenInfo !== undefined;
  const [info, setInfo] = useState<AppInfo | null>(givenInfo ?? null);
  const [people, setPeople] = useState<PeopleList>(givenPeople ?? 'loading');
  // F-1037 (shell/early-form.ts): the 2 fields are uncontrolled; `kept` is what they hold after the form's reset, the values the last submit sent.
  // F-1063: Keep me signed in is a native checkbox, read from the tap's FormData (a tap before hydration ticks it with no script), and from the box itself for Sign in as.
  const [kept, setKept] = useState({ email: typedEmail, password: '', keep: false });
  const keepField = useRef<HTMLInputElement>(null);
  const passwordField = useRef<HTMLInputElement>(null);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(givenBusy);
  // F-1064: the in-flight guard is a ref; React replays every submit it held before hydration in 1 task, each reading the same render's busy.
  const sending = useRef(false);
  // F-285: the person whose Sign in as button was pressed; that control is the busy one (UI-SPECIFICATION Signing in), not Sign in.
  const [pressed, setPressed] = useState<string | null>(null);
  const [focus, setFocus] = useState<'email' | 'password' | null>(focusPassword ? 'password' : null);
  const [message, setMessage] = useState<SignInMessage>(givenMessage ?? (passwordSet ? 'set' : returned ? 'returned' : null));
  const [fieldErrors, setFieldErrors] = useState<{ email?: boolean; password?: boolean }>({});
  const read = useCallback(() => reader || createReader({ baseUrl: window.location.origin }), [reader]);

  const loadPeople = useCallback(async () => {
    setPeople('loading');
    const r = await read().read<{ people: SamplePerson[] }>('API-04', { app: 'office' });
    setPeople(r.ok ? r.data.people : r.code === 'access_code_required' ? 'hidden' : 'error');
  }, [read]);

  useEffect(() => {
    if (preview || reader === false) return;
    void read().read<AppInfo>('API-02').then((r) => {
      if (r.ok) setInfo(r.data);
    });
  }, [preview, reader, read]);
  const demo = info?.demoMode === true;
  useEffect(() => {
    if (givenPeople !== undefined || reader === false || !demo) return;
    void loadPeople();
  }, [givenPeople, reader, demo, loadPeople]);

  // A different person than the one whose copies the phone keeps: those copies go before the page moves on (F-1017 class; the
  // technician app's local.ts personSignedIn, loaded only here, after a sign-in, so the sign-in page does not carry it).
  const land = async (user: { id: string; role: SamplePerson['role'] }) => {
    const target = safeReturn(returnTo) ?? HOME[user.role];
    try {
      (await import('../tech/session.ts')).clearSignOutOwed(); // F-1042: a sign-in voids a sign-out owed; personSignedIn (a job screen's API-07 too) no longer does
      if (typeof user.id === 'string') {
        // F-1241 (F-1127 class): a person who lands in the technician app has the item store's user saved too, as the technician sign-in does
        const local = await import('../tech/local.ts');
        if (target.startsWith('/tech')) await local.signInRecorded(user.id, () => setMessage('unsaved'));
        else await local.personSignedIn(user.id);
      }
    } catch {
      // the module or the storage is not there: nothing was kept to forget
    }
    window.location.assign(target);
  };

  const failed = (code: string | undefined) => {
    sending.current = false;
    setBusy(false);
    setPressed(null);
    if (code === 'credentials_invalid') {
      setMessage('bad');
      // the email is kept, the password is cleared
      if (passwordField.current) passwordField.current.value = '';
      setKept((k) => ({ ...k, password: '' }));
    } else if (code === 'account_turned_off') setMessage('off');
    else if (code === 'rate_limited') setMessage('limited');
    else setMessage('failed');
  };

  // The form's action (F-1037), a tap made before hydration included: React holds that one and replays it here. The fields come from the
  // tap's FormData, and are kept first, so the form's reset after this action gives them back as sent.
  const submit = async (data: FormData) => {
    const typed = { email: fieldText(data, 'email'), password: fieldText(data, 'password'), keep: fieldFlag(data, 'keep') };
    setKept(typed);
    if (sending.current) return;
    const errs = { email: typed.email.trim() === '', password: typed.password === '' };
    setFieldErrors(errs);
    if (errs.email || errs.password) return; // empty fields get their messages without a call
    sending.current = true;
    setBusy(true);
    setMessage(null);
    const r = await read().read<{ user: { id: string; role: SamplePerson['role'] } }>('API-03', { login: typed.email.trim(), password: typed.password, client: 'web', keepSignedIn: typed.keep });
    if (r.ok) await land(r.data.user);
    else failed(r.code);
  };

  const signInAs = async (p: SamplePerson) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setPressed(p.personId);
    setMessage(null);
    const r = await read().read<{ user: { id: string; role: SamplePerson['role'] } }>('API-05', { personId: p.personId, keepSignedIn: keepField.current?.checked ?? kept.keep });
    if (r.ok) await land(r.data.user);
    else failed(r.code);
  };

  const formBusy = busy && pressed === null;
  const calm = message === 'returned' || message === 'set';
  const msgIcon = message === 'set' ? 'check' : calm ? 'info' : 'alert';
  const msgText: Record<NonNullable<SignInMessage>, string> = {
    bad: t('auth.signin.bad'), off: t('auth.signin.off'), returned: t('auth.signin.returned'), set: t('auth.signin.passwordSet'), limited: t('auth.error.limited'), failed: t('auth.signin.failed'), unsaved: t('auth.signin.unsaved'),
  };
  const b = (chunks: ReactNode[]) => <b>{chunks}</b>;

  return (
    <Screen
      screen="SCR-OFC-01" surface="SURF-OFC" className="r1k" title={t('auth.signin.doc')} appInfo={info}
      {...(clock !== undefined ? { clock } : {})} {...(reader !== undefined ? { reader } : {})}
    >
      <div className="r1k-in">
        <aside className="side on-dark" data-ctl="CTL-OFC-01-09">
          <span className="brand">
            <Mark />
            <span className="word">{t('brand.name')}</span>
          </span>
          <div className="app">{t('brand.product')}</div>
          <h1>
            {t('auth.tag.a')} <em>{t('auth.tag.b')}</em>
          </h1>
          <p className="lead">{t('auth.signin.lead')}</p>
          <div className="roles">
            {(['office', 'tech', 'manager'] as const).map((r) => (
              <div className="role" key={r}>
                <span className="ri">
                  <Icon name={r === 'office' ? 'grid' : r === 'tech' ? 'truck' : 'gauge'} />
                </span>
                <div>
                  <b>{t(`auth.signin.role.${r}.title`)}</b>
                  <span>{t(`auth.signin.role.${r}.body`)}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="foot">{t('auth.signin.foot')}</div>
          <svg className="wave" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M16 1.8C16 1.8 5.4 13.2 5.4 19.9C5.4 25.8 10.1 30.2 16 30.2C21.9 30.2 26.6 25.8 26.6 19.9C26.6 13.2 16 1.8 16 1.8Z" fill="#fff" />
          </svg>
        </aside>
        <main className="main">
          <LanguageSwitch className="hlang" />
          <div className="duo">
            <div className="box">
              <h2>{t('auth.signIn')}</h2>
              <p className="sub">{t('auth.signin.sub')}</p>
              <form className="form" action={(data) => void submit(data)} noValidate>
                {message ? (
                  <div className={`msgb ${calm ? 'info' : 'bad'}`} role={calm ? 'status' : 'alert'}>
                    <Icon name={msgIcon} />
                    <span>{msgText[message]}</span>
                  </div>
                ) : null}
                <label className="l" htmlFor="si-email">
                  {t('auth.signin.email')}
                </label>
                <div className={`field${fieldErrors.email ? ' bad' : ''}${focus === 'email' ? ' focus' : ''}`} data-ctl="CTL-OFC-01-01">
                  <Icon name="user" />
                  <input
                    id="si-email" name="email" type="email" className="bw-field-input" autoComplete="username" spellCheck={false}
                    defaultValue={kept.email} aria-invalid={fieldErrors.email || undefined} aria-describedby={fieldErrors.email ? 'si-email-msg' : undefined}
                    onFocus={() => setFocus('email')} onBlur={() => setFocus(null)}
                  />
                </div>
                {fieldErrors.email ? (
                  <div className="r1-fmsg" id="si-email-msg" role="alert">
                    <Icon name="alert" />
                    {t('auth.signin.emailEmpty')}
                  </div>
                ) : null}
                <div className="gap" />
                <label className="l" htmlFor="si-password">
                  {t('auth.signin.passwordLabel')}
                </label>
                <div className={`field${fieldErrors.password ? ' bad' : ''}${focus === 'password' ? ' focus' : ''}`} data-ctl="CTL-OFC-01-02">
                  <Icon name="lock" />
                  <input
                    ref={passwordField} id="si-password" name="password" type={show ? 'text' : 'password'} className="bw-field-input" autoComplete="current-password"
                    defaultValue={kept.password} aria-invalid={fieldErrors.password || undefined} aria-describedby={fieldErrors.password ? 'si-password-msg' : undefined}
                    onFocus={() => setFocus('password')} onBlur={() => setFocus(null)}
                  />
                  <button type="button" className="show bw-btn-reset" data-ctl="CTL-OFC-01-03" aria-pressed={show} onClick={() => setShow(!show)}>
                    {show ? t('auth.signin.hide') : t('auth.signin.show')}
                  </button>
                </div>
                {fieldErrors.password ? (
                  <div className="r1-fmsg" id="si-password-msg" role="alert">
                    <Icon name="alert" />
                    {t('auth.signin.passwordEmpty')}
                  </div>
                ) : null}
                <div className="row2">
                  <label className="check">
                    <input type="checkbox" name="keep" className="bw-keep-cb" defaultChecked={kept.keep} ref={keepField} data-ctl="CTL-OFC-01-08" />
                    <span className="bx"><Icon name="check" sw={3} /></span>
                    {t('auth.signin.keep')}
                  </label>
                  <a className="link" href="/forgot-password" data-ctl="CTL-OFC-01-07">
                    {t('auth.signin.forgot')}
                  </a>
                </div>
                <button type="submit" className={`btn primary go${formBusy ? ' busy' : ''}`} aria-busy={formBusy || undefined} data-ctl="CTL-OFC-01-04">
                  {formBusy ? <span className="r1-spin" /> : null}
                  {formBusy ? t('auth.signin.busy') : t('auth.signIn')}
                </button>
                <div className="note" data-ctl="CTL-OFC-01-10">
                  <Icon name="info" />
                  <div>{t('auth.signin.note')}</div>
                </div>
              </form>
              <div className="help" data-ctl="CTL-OFC-01-10">
                {t.rich('auth.signin.help.tech', { b })}
                <br />
                {t('auth.signin.help.customers')}
                <br />
                {t('auth.signin.help.locked', { phone: '(614) 555-0100' })}
              </div>
            </div>
            {demo && people !== 'hidden' ? (
              <aside className="asl" aria-label={t('auth.signin.as')}>
                <h3>{t('auth.signin.as')}</h3>
                <p className="asn">{t('auth.signin.asNote')}</p>
                <PeopleView people={people} pressed={pressed} onPick={(p) => void signInAs(p)} onRetry={() => void loadPeople()} />
                <a className="link cust" href="/book" data-ctl="CTL-OFC-01-06">
                  {t('auth.signin.customer')}
                </a>
              </aside>
            ) : demo ? (
              <a className="link cust" href="/book" data-ctl="CTL-OFC-01-06">
                {t('auth.signin.customer')}
              </a>
            ) : null}
          </div>
        </main>
      </div>
    </Screen>
  );
}

const GROUPS = [
  { role: 'manager', label: 'auth.signin.group.manager' },
  { role: 'office', label: 'auth.signin.group.office' },
  { role: 'technician', label: 'auth.signin.group.tech' },
] as const;

function PeopleView({ people, pressed, onPick, onRetry }: { people: Exclude<PeopleList, 'hidden'>; pressed: string | null; onPick: (p: SamplePerson) => void; onRetry: () => void }) {
  const t = useT();
  if (people === 'loading') {
    return (
      <div className="aslist" data-ctl="CTL-OFC-01-05" aria-busy="true">
        <h4>{t('auth.signin.as')}</h4>
        <span className="r1-skel bw-w-60" />
        <span className="r1-skel" />
        <span className="r1-skel" />
      </div>
    );
  }
  if (people === 'error') {
    return (
      <div className="aslist" data-ctl="CTL-OFC-01-05">
        <h4>{t('auth.signin.as')}</h4>
        <div className="r1-errpanel" role="alert" data-ctl="CTL-CMP-12-01">
          <Icon name="alert" />
          <div>
            <b>{t('auth.signin.peopleError')}</b>
            {t('auth.signin.peopleErrorTodo')}
            <br />
            <button type="button" className="btn sm" data-ctl="CTL-CMP-12-02" onClick={onRetry}>
              {t('shell.error.tryAgain')}
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="aslist" data-ctl="CTL-OFC-01-05">
      {GROUPS.map((g) => {
        const rows = people.filter((p) => p.role === g.role);
        if (rows.length === 0) return null;
        return (
          <Fragment key={g.role}>
            <h4>{t(g.label)}</h4>
            {rows.map((p) => (
              <button type="button" className={`who${pressed === p.personId ? ' busy' : ''}`} key={p.personId} aria-busy={pressed === p.personId || undefined} onClick={() => onPick(p)}>
                <span className="av">{initials(p.name)}</span>
                <span>
                  <b translate="no">{p.name}</b>
                  <small>
                    {`${p.role === 'technician' ? t('shell.role.technician') : p.job}, ${branchById(p.branch).name}, ${t(p.language === 'es' ? 'language.name.es' : 'language.name.en')}`}
                  </small>
                </span>
              </button>
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}
