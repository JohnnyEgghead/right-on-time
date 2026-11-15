// SPDX-License-Identifier: AGPL-3.0-or-later
// The item entry seam for a driver with no entry screen of its own (as the web app's window.__bwTechOutbox): only when the app is
// launched with "-bwProbe 1" and a job number ("-bwProbeJob <n>"), the Today tab shows a note box. Its Save opens the native confirm
// sheet, and the confirm enters the note through the same engine.enter() the note screen (P6-NATIVE-JOB) will call, so the stamp,
// the file store and the background upload under test are the real ones. It shows the waiting count and the last key it entered.
import { useNavigation, type NavigationProp, type ParamListBase } from '@react-navigation/native';
import { useState } from 'react';
import { Keyboard, Pressable, Settings, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AppState, NativeApp } from '../core.ts';
import { useT } from '../ui/intl.tsx';
import { lk } from '../ui/look.ts';
import { color, type } from '../ui/tokens.ts';
import { confirmStep } from './Confirm.tsx';
import { JobProbe } from './job/JobProbe.tsx';

export const PROBE_ON = String(Settings.get('bwProbe') ?? '') === '1';
const PROBE_JOB = Number(Settings.get('bwProbeJob') ?? 0);
/** The rig's control origin (xcuitest/signal-relay.mjs), which hands the probe the sample sign-in so no password rides in a launch argument. */
const PROBE_CONTROL = String(Settings.get('bwProbeControl') ?? '');

/**
 * The sign-in half of the seam: the iOS Simulator gives a secure text field no keyboard focus under XCUITest (P6-NATIVE-SHELL report),
 * so in probe mode the sign-in screen also offers this button. It fetches the rig's sample sign-in and calls the same app.signIn the
 * form calls: API-03 with client native and Stay signed in on, the bearer token into the Keychain.
 */
export function ProbeSignIn(props: { app: NativeApp }) {
  const t = useT();
  const [failed, setFailed] = useState('');
  if (!PROBE_ON || PROBE_CONTROL === '') return null;
  const go = async () => {
    try {
      const r = await fetch(`${PROBE_CONTROL}/probe/credentials`);
      const c = (await r.json()) as { login: string; password: string };
      const out = await props.app.signIn(c.login, c.password, true);
      setFailed(out.ok ? '' : out.code);
    } catch (e) {
      setFailed((e as Error).name);
    }
  };
  return (
    <View style={s.box}>
      <Pressable {...lk('probe.signin', s.button)} onPress={() => void go()} accessibilityRole="button">
        <Text style={s.buttonText}>{t('auth.signIn')}</Text>
      </Pressable>
      <Text {...lk('probe.signinError')} accessibilityLabel={failed}>{failed}</Text>
    </View>
  );
}

export function Probe(props: { app: NativeApp; state: AppState }) {
  const t = useT();
  const nav = useNavigation<NavigationProp<ParamListBase>>();
  const [text, setText] = useState('');
  const [last, setLast] = useState('');
  const [failed, setFailed] = useState('');
  const queue = async () => {
    Keyboard.dismiss(); // the keyboard would cover the tab bar the driver taps next
    if (!(await confirmStep(nav, { title: 'common.save', confirm: 'common.ok', cancel: 'common.cancel' }))) return;
    try {
      const item = await props.app.enter({ jobNumber: PROBE_JOB, baseVersion: 1, body: { kind: 'note', payload: { text } } });
      setLast(item.key);
      setFailed('');
    } catch (e) {
      setFailed((e as Error).name);
    }
  };
  const n = props.state.outbox.waiting.length;
  return (
    <View style={s.box}>
      <TextInput {...lk('probe.note', s.input)} value={text} onChangeText={setText} multiline accessibilityLabel={t('common.save')} />
      <Pressable {...lk('probe.queue', s.button)} onPress={() => void queue()} accessibilityRole="button">
        <Text style={s.buttonText}>{t('common.save')}</Text>
      </Pressable>
      <Text {...lk('probe.count')} accessibilityLabel={String(n)}>{n}</Text>
      <Text {...lk('probe.key')} accessibilityLabel={last}>{last}</Text>
      <Text {...lk('probe.error')} accessibilityLabel={failed}>{failed}</Text>
      <JobProbe app={props.app} job={PROBE_JOB} />
    </View>
  );
}

const s = StyleSheet.create({
  box: { padding: 18, rowGap: 10 },
  input: { ...type(400, 17, 23.8, color.ink900), minHeight: 80, backgroundColor: color.white, borderWidth: 1, borderColor: color.ink400, borderRadius: 12, padding: 12 },
  button: { height: 44, borderRadius: 11, backgroundColor: color.teal700, alignItems: 'center', justifyContent: 'center' },
  buttonText: type(650, 15, 18, color.white),
});
