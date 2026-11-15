// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-12 Server address (FR-IOS-3; UI-SPECIFICATION SCR-TEC-12; DK-117 option B): reached signed out from the sign-in screen's
// Server row. The field starts at the saved address (the hosted demo until another is saved). Check connection asks the typed
// origin who it is (API-105); Save stays off until the address on the field checked out, then stores it and returns (Saved). Use the
// default server puts the hosted demo back; Cancel returns with no change. States, as the frames show them: Default, Checking,
// Reachable, Unreachable, Not this product and Not a web address.
import { useState } from 'react';
import { ScrollView, StatusBar, StyleSheet, View } from 'react-native';
import type { NativeApp } from '../core.ts';
import { DEFAULT_SERVER, parseOrigin } from '../net/origin.ts';
import type { ServerCheck } from '../net/server-check.ts';
import { useT } from '../ui/intl.tsx';
import { Field, FieldMessage, Hint, Message, NavBar, WideButton } from '../ui/kit.tsx';
import { lk, useLookDump } from '../ui/look.ts';
import { color } from '../ui/tokens.ts';

type Checked = { origin: string; result: ServerCheck } | null;

/** The screen's state name, as the frames caption it (the look dump is named by it). */
export function serverState(text: string, focused: boolean, busy: boolean, checked: Checked): string {
  if (busy) return 'checking';
  const origin = parseOrigin(text);
  if (origin === null && text.trim() !== '' && !focused) return 'not-address';
  if (checked && checked.origin === origin) {
    if (checked.result.kind === 'reachable') return 'reachable';
    return checked.result.kind === 'unreachable' ? 'unreachable' : 'not-product';
  }
  return origin === DEFAULT_SERVER ? 'default' : 'typed';
}

export function ServerAddress(props: { app: NativeApp; initial: string; onDone: () => void }) {
  const t = useT();
  const [text, setText] = useState(props.initial);
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<Checked>(null);
  const origin = parseOrigin(text);
  const state = serverState(text, focused, busy, checked);
  useLookDump(state);

  const check = async () => {
    if (origin === null) return;
    setBusy(true);
    try {
      setChecked({ origin, result: await props.app.check(origin) });
    } finally {
      setBusy(false);
    }
  };
  const canSave = checked !== null && checked.origin === origin && checked.result.kind === 'reachable';
  const [refused, setRefused] = useState<{ n: number; damaged: boolean } | null>(null);
  const save = () => {
    if (!canSave || origin === null) return;
    void props.app.saveServer(origin).then((r) => {
      if (r.ok) props.onDone();
      else setRefused({ n: r.waiting, damaged: r.damaged });
    });
  };

  return (
    <View {...lk('srv.screen', s.screen)}>
      <StatusBar barStyle="light-content" />
      <NavBar id="srv.nav" title={t('tech.server.title')}
        left={{ id: 'srv.cancel', label: t('common.cancel'), onPress: props.onDone }}
        right={{ id: 'srv.save', label: t('common.save'), onPress: save, disabled: !canSave }} />
      <ScrollView keyboardShouldPersistTaps="handled">
        <View {...lk('srv.body', s.body)}>
          <Field id="srv.field" label={t('tech.server.label')} icon="globe" state={state === 'not-address' ? 'bad' : focused ? 'focus' : 'rest'}
            input={{
              value: text, onChangeText: setText, onFocus: () => setFocused(true), onBlur: () => setFocused(false),
              autoCapitalize: 'none', autoCorrect: false, keyboardType: 'url', textContentType: 'URL', returnKeyType: 'done',
              accessibilityLabel: t('tech.server.label'),
            }}
            below={state === 'not-address'
              ? <FieldMessage id="srv.fmsg" text={t('tech.server.notAddress')} />
              : <Hint id="srv.hint" text={t('tech.server.hint')} />} />
          <WideButton id="srv.check" label={t(busy ? 'tech.server.checking' : 'tech.server.check')} icon="refresh" busy={busy}
            disabled={origin === null} onPress={() => void check()} />
          {state === 'reachable' && checked?.result.kind === 'reachable'
            ? <Message id="srv.ok" tone="ok" icon="check" text={t('tech.server.connected', { version: checked.result.version })} /> : null}
          {state === 'unreachable' ? <Message id="srv.err" tone="bad" icon="signal" text={t('tech.server.unreachable')} /> : null}
          {state === 'not-product' ? <Message id="srv.err" tone="bad" icon="alert" text={t('tech.server.notProduct')} /> : null}
          <WideButton id="srv.default" label={t('tech.server.useDefault')} icon={origin === DEFAULT_SERVER ? undefined : 'back'} ghost
            disabled={origin === DEFAULT_SERVER}
            onPress={() => { setText(DEFAULT_SERVER); setChecked(null); }} />
          <Hint id="srv.defaultHint" center marginTop={2}
            text={origin === DEFAULT_SERVER ? t('tech.server.isDefault') : t('tech.server.defaultIs', { address: DEFAULT_SERVER })} />
          {refused !== null ? <Message id="srv.refused" tone="bad" icon="alert" text={refused.damaged ? t('tech.server.damagedHeld', { n: refused.n }) : t('tech.me.signOutWaiting', { n: refused.n })} /> : null}
          <Hint id="srv.saveOff" text={t('tech.server.saveOff')} />
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.screen },
  body: { paddingTop: 18, paddingHorizontal: 18 },
});
