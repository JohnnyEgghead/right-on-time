// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-EML-03 Forgot password, the native screen (UI-SPECIFICATION 8.1 and 10; FR-AUTH-9), as DK-117 option B draws it (mockups/pages/
// r1-ios-b.html, the eml03 frame: the teal bar with Sign in as its back button, the lead, the Email field, Send reset email and Back to
// sign in; its Sent and Not available tiles). Opened by Forgot password? on the sign-in screen (CTL-TEC-01-07). The behavior is the web
// page's (apps/web/src/accounts/ForgotScreen.tsx; forgot-model.ts): API-165 for the technician app, the answer's result line, and a sent
// email's one-time link opened once, in the in-app browser (CTL-EML-03-04, modules/bw-browser).
import { useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import type { NativeApp } from '../core.ts';
import { openInApp } from '../../modules/bw-browser/index.ts';
import { Icon } from '../ui/Icon.tsx';
import { useT } from '../ui/intl.tsx';
import { Field, FieldMessage, Message } from '../ui/kit.tsx';
import { lk, useLookDump } from '../ui/look.ts';
import { color } from '../ui/tokens.ts';
import { EMAIL, forgotStateOf, openLinkOnce, RESULT, type ForgotState } from './forgot-model.ts';
import { JobBar } from './job/ui.tsx';
import { formStyles as f, InfoBox } from './SignIn.tsx';

export function ForgotScreen(props: { app: NativeApp; onBack: () => void }) {
  const t = useT();
  const intl = useIntl();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<ForgotState>('default');
  const [bad, setBad] = useState(false);
  const [sentTo, setSentTo] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [used, setUsed] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const opening = useRef(false);
  const [focus, setFocus] = useState(false);
  const busy = state === 'sending';

  // The look dump of the state on screen (ci/look-values/native-today-cases.ts): the Default frame has the empty field in focus.
  useLookDump(state === 'default' && !bad && focus && email === '' ? 'forgot'
    : state === 'sent' && link !== null && !used ? 'forgot-sent' : state === 'not_available' ? 'forgot-not-available' : null);

  const submit = async () => {
    if (busy) return;
    const typed = email.trim();
    if (!EMAIL.test(typed)) {
      setBad(true);
      return;
    }
    setBad(false);
    setState('sending');
    setUsed(false);
    setOpenFailed(false);
    const got = forgotStateOf(await props.app.requestReset(typed));
    setSentTo(typed);
    setLink(got.link);
    setBad(got.bad);
    setState(got.state);
  };

  // CTL-EML-03-04: the one-time link opens once; after that the box says it was used.
  const openEmail = async () => {
    if (link === null || used || opening.current) return;
    opening.current = true;
    setOpenFailed(false);
    const r = await openLinkOnce(link, openInApp);
    opening.current = false;
    if (r === 'opened') setUsed(true);
    else setOpenFailed(true);
  };

  const r = RESULT[state];
  const words = r ? String(intl.formatMessage({ id: r.key }, { address: sentTo, addr: (c: string[]) => c.join('') })) : '';
  return (
    <View style={s.screen}>
      <StatusBar barStyle="light-content" />
      <JobBar id="forgot" back={t('auth.signIn')} onBack={props.onBack} title={t('accounts.forgot.title')} />
      <ScrollView keyboardShouldPersistTaps="handled">
        <View {...lk('forgot.form', f.form)}>
          <Text {...lk('forgot.lead', f.lead)}>{t('accounts.forgot.lead')}</Text>
          <Field id="forgot.email" label={t('accounts.field.email')} icon="message" state={bad ? 'bad' : focus ? 'focus' : 'rest'}
            below={bad ? <FieldMessage id="forgot.email.msg" text={t('accounts.field.notEmail')} /> : null}
            input={{
              value: email, onChangeText: (v) => { setEmail(v); setBad(false); }, onFocus: () => setFocus(true), onBlur: () => setFocus(false),
              keyboardType: 'email-address', autoCapitalize: 'none', autoCorrect: false, textContentType: 'emailAddress', returnKeyType: 'send',
              onSubmitEditing: () => void submit(), submitBehavior: 'blurAndSubmit', accessibilityLabel: t('accounts.field.email'),
            }} />
          <Pressable {...lk('forgot.send', [f.primary, busy ? f.busy : null])} onPress={() => void submit()} disabled={busy} accessibilityRole="button"
            accessibilityState={{ busy }} accessibilityLabel={t(busy ? 'accounts.forgot.sending' : 'accounts.forgot.send')}>
            {busy ? <View {...lk('forgot.spin', f.spin)} /> : <Icon id="forgot.send.icon" name="send" size={19} color={color.white} />}
            <Text {...lk('forgot.send.text', f.primaryText)}>{t(busy ? 'accounts.forgot.sending' : 'accounts.forgot.send')}</Text>
          </Pressable>
          {r ? (
            <View style={s.result}>
              {r.box === 'info' ? <InfoBox id="forgot.result" icon={r.icon === 'lock' ? 'lock' : 'info'} text={words} />
                : r.box === 'ok' && link !== null && !used
                  ? <Message id="forgot.result" tone="ok" icon="check" text={openFailed ? `${words}\n${t('accounts.forgot.openFailed')}` : words} link={{ label: t('accounts.forgot.open'), onPress: () => void openEmail(), own: true }} />
                  : <Message id="forgot.result" tone={r.box === 'ok' ? 'ok' : 'bad'} icon={r.icon === 'check' ? 'check' : 'alert'}
                    text={r.box === 'ok' ? `${words}\n${t('accounts.linkUsed')}` : words} />}
            </View>
          ) : null}
          <Pressable {...lk('forgot.back', f.link)} onPress={props.onBack} accessibilityRole="link">
            <Text {...lk('forgot.back.text', f.linkText)}>{t('accounts.forgot.back')}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.screen },
  result: { marginTop: 12 },
});
