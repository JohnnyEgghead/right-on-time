// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-01 native sign-in, as DK-117 option B draws it (mockups/pages/r1-ios-b.html), its states from DK-106 (ruling D5b-1): the teal hero
// with the mark, a normal email or employee number and password (FR-AUTH-7; no Sign in as list and no sample-data wording, FR-IOS-4,
// OA-60), Show for the password (CTL-TEC-01-03), Stay signed in on this phone as an iOS switch (CTL-TEC-01-08, ruling D5a-1; off by default;
// its value rides on API-03 as keepSignedIn), Forgot password? (CTL-TEC-01-07), the language as the in-place segmented control
// (CTL-CMP-03-01), the Server row (CTL-TEC-01-06) that opens SCR-TEC-12 and shows the saved address, and the version footer (CTL-TEC-01-09).
// The fields are the shipped ones in every launch, the XCUITest one (-bwLook) included: a secure password field with the password content
// type, which Show turns into plain text (F-1105; TodayUITests test0 types into it).
// States: Default, Signing in, Wrong details, Turned off, Items waiting (the name locked to the waiting technician, UD-20), Server unreachable.
import { useIsFocused } from '@react-navigation/native';
import Constants from 'expo-constants';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StatusBar, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import type { NativeApp, SignInResult } from '../core.ts';
import { shownAddress } from '../net/origin.ts';
import { Icon } from '../ui/Icon.tsx';
import { useT } from '../ui/intl.tsx';
import { Field, FieldMessage, Message, SettingsRow } from '../ui/kit.tsx';
import { dumpLook, lk, LOOK_ON, traceLook } from '../ui/look.ts';
import { LanguageSegments } from '../ui/Segmented.tsx';
import { useBigText } from '../ui/text-size.tsx';
import { color, type } from '../ui/tokens.ts';
import { tone } from './today/palette.ts';
import { waitingPerson } from './today/person.ts';

type Failure = Exclude<SignInResult, { ok: true }>['code'];
const FAIL: Record<Failure, MessageKey> = {
  credentials_invalid: 'tech.signin.bad',
  account_turned_off: 'auth.signin.off',
  unreachable: 'tech.signin.unreachable',
  failed: 'auth.signin.failed',
};

/** The Brightwater mark (DK-117 BW_MARK): a cool water drop holding a warm flame. */
const MARK = `<svg viewBox="0 0 32 32">
<defs><linearGradient id="bwDrop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a8aa5"/><stop offset="1" stop-color="#0c4b5d"/></linearGradient>
<linearGradient id="bwFlame" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb35c"/><stop offset="1" stop-color="#e2580c"/></linearGradient></defs>
<path d="M16 1.8C16 1.8 5.4 13.2 5.4 19.9C5.4 25.8 10.1 30.2 16 30.2C21.9 30.2 26.6 25.8 26.6 19.9C26.6 13.2 16 1.8 16 1.8Z" fill="url(#bwDrop)"/>
<path d="M9.4 15.2C10.4 12.9 12 10.6 13.4 8.9" stroke="#ffffff" stroke-opacity=".35" stroke-width="1.6" fill="none" stroke-linecap="round"/>
<path d="M16.9 11.6C17.6 15.2 21.4 17.1 21.4 21.6C21.4 24.8 19.1 27.1 16 27.1C12.9 27.1 10.6 24.9 10.6 21.9C10.6 19.3 12.2 17.6 13.5 16.4C13.5 18.3 14.3 19.5 15.5 20C15.1 17.1 15.6 14 16.9 11.6Z" fill="url(#bwFlame)"/>
<path d="M16.3 19.4C16.7 21.1 18.4 22 18.4 24C18.4 25.4 17.4 26.3 16.1 26.3C14.8 26.3 13.8 25.4 13.8 24.1C13.8 22.9 14.6 22.2 15.2 21.6C15.2 22.4 15.6 23 16.1 23.2C15.9 21.9 16 20.5 16.3 19.4Z" fill="#fff3e0"/>
</svg>`;

/**
 * F-988, F-1111: the XCUITest rig's sign-in seams (the probe sign-in and the fill buttons) live in SignInRig.tsx, required only when the
 * bundle is made with EXPO_PUBLIC_BW_RIG=1 (xcuitest/run.sh). Metro inlines the variable and drops the dead branch and its dependency, so
 * the TestFlight bundle has neither.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a bundle-time conditional require is how Metro leaves the module out
const Rig: typeof import('./SignInRig.tsx') | null = process.env.EXPO_PUBLIC_BW_RIG === '1' ? require('./SignInRig.tsx') : null;

export function SignIn(props: { app: NativeApp; server: string; language: 'en' | 'es'; onServer: () => void; onForgot?: () => void; saved: boolean }) {
  const t = useT();
  const top = useSafeAreaInsets().top;
  const waiting = waitingPerson(props.app.snapshot.outbox.waiting, props.app.person.read());
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [stay, setStay] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [empty, setEmpty] = useState<{ login: boolean; password: boolean }>({ login: false, password: false });
  const [focus, setFocus] = useState<'login' | 'password' | null>(null);
  const passwordField = useRef<ComponentRef<typeof TextInput>>(null);
  const typed = waiting ? waiting.person.login : login.trim();

  // The look dump of the state on screen (ci/look-values/native-today-cases.ts): the frame's Default has the form filled and the password
  // field in focus; the others are the frames' fragments.
  // The Default frame has the form filled and the password field in focus. This is a look-only seam: under -bwLook a filled form draws the focus
  // ring. It was added for a focus iOS would not hand over, which fix pass 1 root-caused to the kit Field's outline ring (ui/kit.tsx), so whether
  // the seam is still needed is unproven; the dump relies on it, so it stays until a run shows the fill taking the real focus.
  const pwFocus = focus === 'password' || (LOOK_ON && login !== '' && password !== '' && error === null && !busy);
  const state = busy ? 'signin-busy'
    : error === 'tech.signin.bad' ? 'signin-wrong'
      : error === 'auth.signin.off' ? 'signin-off'
        : error === 'tech.signin.unreachable' ? 'signin-unreachable'
          : waiting ? 'signin-waiting'
            : login !== '' && password !== '' && !show && pwFocus ? 'signin'
              : props.saved ? 'saved' : null;
  // `focused` re-runs this when the Server screen closes over the sign-in (SCR-TEC-12 Save): the Saved state is drawn on return.
  const focused = useIsFocused();
  useEffect(() => {
    traceLook(`signin state=${state} focused=${focused} saved=${props.saved}`);
    if (!LOOK_ON || state === null || !focused) return;
    const h = setTimeout(() => void dumpLook(state), 900);
    return () => clearTimeout(h);
  }, [state, focused]);

  // The rig's fill seam (SignInRig.tsx): a fill sets the fields and asks for the password field's focus.
  const filled = (c: { login: string; password: string }) => {
    setLogin(c.login);
    setPassword(c.password);
    setError(null);
    setEmpty({ login: false, password: false });
    // the Default frame has the password field in focus: asked for twice, as iOS may refuse the first while the fill's tap settles
    for (const ms of [150, 1200]) setTimeout(() => { if (!passwordField.current?.isFocused()) passwordField.current?.focus(); }, ms);
  };

  const submit = async () => {
    const missing = { login: typed === '', password: password === '' };
    setEmpty(missing);
    if (missing.login || missing.password) return;
    setBusy(true);
    setError(null);
    const r = await props.app.signIn(typed, password, stay);
    setBusy(false);
    if (!r.ok) return setError(FAIL[r.code]);
    const s = props.app.snapshot.session;
    if (s) props.app.person.write({ userId: s.userId, name: s.name, login: typed });
  };

  const toggleShow = () => {
    setShow((v) => !v);
    passwordField.current?.focus(); // the person keeps typing where they were
  };
  const version = String(Constants.expoConfig?.version ?? '1.0.0');

  // 14.2 item 2: at the largest text sizes the hero scrolls away with the form (it stays pinned above it at every other size), so the form
  // is never squeezed into a strip under a hero that fills the screen.
  const big = useBigText();
  const hero = (
    <View {...lk('signin.hero', [s.hero, { paddingTop: top + 4 }])}>
      <View {...lk('signin.appicon', s.appicon)}>
        <SvgXml xml={MARK} width={42} height={42} />
      </View>
      <Text {...lk('signin.co', s.co)}>{`${t('brand.name')} ${t('brand.trade')}`}</Text>
      <Text {...lk('signin.product', s.product)} accessibilityRole="header">{t('brand.product')}</Text>
      <Text {...lk('signin.app', s.app)}>{t('tech.signin.app')}</Text>
    </View>
  );

  return (
    <KeyboardAvoidingView behavior="padding" style={s.screen}>
      <StatusBar barStyle="light-content" />
      {big ? null : hero}
      <ScrollView keyboardShouldPersistTaps="handled">
        {big ? hero : null}
        <View {...lk('signin.form', s.form)}>
          <Text {...lk('signin.h2', s.h2)} accessibilityRole="header">{t('auth.signIn')}</Text>
          <Text {...lk('signin.lead', s.lead)}>{t('tech.signin.lead')}</Text>
          {waiting ? <InfoBox id="signin.info" icon="cloud" text={t('tech.signin.waiting', { n: waiting.count, name: waiting.person.name })} /> : null}
          {error ? (
            <Message id="signin.error" tone="bad" icon={error === 'auth.signin.off' ? 'lock' : error === 'tech.signin.unreachable' ? 'signal' : 'alert'}
              text={t(error, { address: shownAddress(props.server) })} {...(error === 'tech.signin.unreachable' ? { link: { label: t('tech.server.label'), onPress: props.onServer } } : {})} />
          ) : null}
          <View style={s.gap0}>
            <Field id="signin.login" label={t('tech.signin.login')} icon={waiting ? 'lock' : 'user'}
              state={waiting ? 'locked' : empty.login ? 'bad' : focus === 'login' ? 'focus' : 'rest'}
              below={empty.login && !waiting ? <FieldMessage id="signin.login.msg" text={t('tech.signin.loginEmpty')} /> : null}
              input={{
                value: waiting ? waiting.person.name : login, onChangeText: (v) => { setLogin(v); setEmpty((e) => ({ ...e, login: false })); },
                onFocus: () => setFocus('login'), onBlur: () => setFocus(null), autoCapitalize: 'none', autoCorrect: false, textContentType: 'username',
                accessibilityLabel: t('tech.signin.login'), returnKeyType: 'next', onSubmitEditing: () => passwordField.current?.focus(), submitBehavior: 'submit',
                editable: !waiting,
              }} />
          </View>
          <View style={s.gap}>
            <Field id="signin.password" label={t('auth.signin.passwordLabel')} icon="lock" state={empty.password ? 'bad' : pwFocus ? 'focus' : 'rest'} inputRef={passwordField}
              below={empty.password ? <FieldMessage id="signin.password.msg" text={t('auth.signin.passwordEmpty')} /> : null}
              right={
                <Pressable {...lk('signin.show', s.show)} onPress={toggleShow} accessibilityRole="button" accessibilityLabel={t(show ? 'auth.signin.hide' : 'auth.signin.show')}>
                  <Text {...lk('signin.show.text', s.showText)}>{t(show ? 'auth.signin.hide' : 'auth.signin.show')}</Text>
                </Pressable>
              }
              input={{
                value: password, onChangeText: (v) => { setPassword(v); setEmpty((e) => ({ ...e, password: false })); }, onFocus: () => setFocus('password'), onBlur: () => setFocus(null),
                secureTextEntry: !show, textContentType: 'password', autoCapitalize: 'none', autoCorrect: false, returnKeyType: 'go', onSubmitEditing: () => void submit(),
                accessibilityLabel: t('auth.signin.passwordLabel'),
              }} />
          </View>
          <View {...lk('signin.stay.card', s.stay)}>
            <View style={s.stayTx}>
              <Text {...lk('signin.stay.title', s.stayTitle)}>{t('tech.signin.stay')}</Text>
              <Text {...lk('signin.stay.note', s.stayNote)}>{t('tech.signin.stayNote')}</Text>
            </View>
            <Switch {...lk('signin.stay')} value={stay} onValueChange={setStay} trackColor={{ false: color.ink400, true: color.teal600 }} accessibilityLabel={t('tech.signin.stay')} />
          </View>
          <Pressable {...lk('signin.submit', [s.primary, busy ? s.busy : null])} onPress={() => void submit()} disabled={busy} accessibilityRole="button"
            accessibilityState={{ busy }} accessibilityLabel={t(busy ? 'auth.signin.busy' : 'auth.signIn')}>
            {busy ? <View {...lk('signin.spin', s.spin)} /> : <Icon id="signin.submit.icon" name="lock" size={19} color={color.white} />}
            <Text {...lk('signin.submit.text', s.primaryText)}>{t(busy ? 'auth.signin.busy' : 'auth.signIn')}</Text>
          </Pressable>
          <Pressable {...lk('signin.forgot', s.forgot)} onPress={() => props.onForgot?.()} accessibilityRole="link">
            <Text {...lk('signin.forgot.text', s.forgotText)}>{t('auth.signin.forgot')}</Text>
          </Pressable>
          <View {...lk('signin.server.grp', s.setg)}>
            <View {...lk('signin.lang.row', [s.setrow, big ? s.setrowBig : null])}>
              <Icon id="signin.lang.icon" name="globe" size={19} color={color.teal700} />
              <Text {...lk('signin.lang.key', [s.setKey, big ? s.setKeyBig : null])}>{t('tech.me.language')}</Text>
              <LanguageSegments id="signin.lang" value={props.language} onChange={(l) => void props.app.setLanguage(l)} width={170} />
            </View>
            <View {...lk('signin.sep', s.sep)} />
            <SettingsRow id="signin.server" icon="cloud" label={t('tech.server.row')} value={shownAddress(props.server)} onPress={props.onServer} bare />
          </View>
          <Text {...lk('signin.ver', s.ver)}>{`${t('tech.signin.phones')} - ${t('tech.signin.version', { version })}`}</Text>
          {Rig ? <Rig.RigSignIn app={props.app} onFilled={filled} /> : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** .infobox (DK-56 family): a neutral notice under the heading (Items waiting; SCR-EML-03 Not available). */
export function InfoBox(props: { id: string; icon: 'cloud' | 'info' | 'lock'; text: string }) {
  return (
    <View {...lk(props.id, s.info)} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Icon id={`${props.id}.icon`} name={props.icon} size={18} color={color.teal900} marginTop={1} />
      <Text {...lk(`${props.id}.text`, s.infoText)}>{props.text}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.screen },
  hero: { backgroundColor: color.teal900, paddingHorizontal: 20, paddingBottom: 18, alignItems: 'center' },
  appicon: { width: 66, height: 66, borderRadius: 16, backgroundColor: color.white, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  co: { ...type(600, 13.5, 18.9, tone.teal200), marginTop: 8 },
  product: { ...type(760, 25, 35, color.white), marginTop: 2, letterSpacing: -0.5 },
  app: { ...type(400, 13.5, 18.9, color.teal100), marginTop: 2 },
  form: { paddingTop: 14, paddingHorizontal: 20, paddingBottom: 30 },
  h2: type(750, 21, 29.4, color.ink900),
  lead: { ...type(400, 14, 19.6, color.ink600), marginTop: 2, marginBottom: 12 },
  gap0: {},
  gap: { marginTop: 12 },
  info: {
    marginBottom: 12, flexDirection: 'row', alignItems: 'flex-start', columnGap: 9, rowGap: 9, borderRadius: 11, paddingVertical: 10, paddingHorizontal: 12,
    backgroundColor: tone.teal50, borderWidth: 1, borderColor: tone.teal200,
  },
  infoText: { ...type(400, 14, 19.6, color.teal900), flexShrink: 1 },
  show: { marginLeft: 'auto', paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: color.ink300, minHeight: 30, justifyContent: 'center' },
  showText: type(700, 14, 19.6, color.teal700),
  stay: {
    marginTop: 12, flexDirection: 'row', alignItems: 'center', columnGap: 12, rowGap: 12, paddingVertical: 10, paddingHorizontal: 14, borderWidth: 1, borderRadius: 12,
    borderColor: color.ink200, backgroundColor: color.white,
  },
  stayTx: { flex: 1, minWidth: 0 },
  stayTitle: type(680, 15, 21, color.ink900),
  stayNote: { ...type(400, 12.5, 16.875, color.ink600), marginTop: 2 },
  primary: {
    marginTop: 14, minHeight: 52, borderRadius: 14, backgroundColor: color.teal700, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    columnGap: 9, rowGap: 9, paddingVertical: 4, paddingHorizontal: 12,
  },
  busy: { opacity: 0.85 },
  spin: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: color.white },
  primaryText: { ...type(720, 18, 25.2, color.white), textAlign: 'center' },
  forgot: { marginTop: 12, minHeight: 44, alignSelf: 'center', justifyContent: 'center' },
  forgotText: type(650, 15, 21, color.teal700),
  setg: { marginTop: 6, backgroundColor: color.white, borderWidth: 1, borderColor: color.ink200, borderRadius: 12, overflow: 'hidden' },
  setrow: { flexDirection: 'row', alignItems: 'center', columnGap: 10, rowGap: 10, paddingVertical: 7, paddingHorizontal: 12, minHeight: 46 },
  setKey: { ...type(600, 15, 21, color.ink900), flex: 1 },
  setrowBig: { flexDirection: 'column', alignItems: 'stretch', paddingVertical: 10 },
  setKeyBig: { flex: 0 },
  sep: { height: 1, backgroundColor: tone.ink150 },
  ver: { ...type(400, 12.5, 17.5, color.ink600), textAlign: 'center', marginTop: 10 },
});

/** The sign-in form's pieces SCR-EML-03 draws too (DK-117 eml03: the same .form, .lead, a.primary and a.forgot). */
export const formStyles = { form: s.form, lead: s.lead, primary: s.primary, primaryText: s.primaryText, busy: s.busy, spin: s.spin, link: s.forgot, linkText: s.forgotText };
