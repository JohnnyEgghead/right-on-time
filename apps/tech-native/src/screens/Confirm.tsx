// SPDX-License-Identifier: AGPL-3.0-or-later
// The native sheet for a confirm step (SD-47 Native app "native sheets for confirm steps"; UI-SPECIFICATION 8.1 platform idiom): a
// form sheet of the root stack (react-native-screens: a UIKit sheet with a grabber, dismissed by a swipe). confirmStep() opens it and
// answers true for the confirm button, false for Cancel or a swipe away. The confirm steps themselves (On my way, Arrived, No one home)
// are P6-NATIVE-TODAY's; their words come in as catalog keys.
import { useNavigation, useRoute, type NavigationProp, type ParamListBase, type RouteProp } from '@react-navigation/native';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import { useT } from '../ui/intl.tsx';
import { lk } from '../ui/look.ts';
import { color, type } from '../ui/tokens.ts';

export interface ConfirmParams {
  id: string;
  title: MessageKey;
  confirm: MessageKey;
  cancel: MessageKey;
}

const pending = new Map<string, (ok: boolean) => void>();
let next = 0;

export function confirmStep(nav: NavigationProp<ParamListBase>, words: Omit<ConfirmParams, 'id'>): Promise<boolean> {
  const id = `confirm-${next++}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    nav.navigate('Confirm', { ...words, id });
  });
}

function settle(id: string, ok: boolean): void {
  pending.get(id)?.(ok);
  pending.delete(id);
}

export function ConfirmSheet() {
  const t = useT();
  const nav = useNavigation();
  const p = useRoute<RouteProp<{ Confirm: ConfirmParams }, 'Confirm'>>().params;
  useEffect(() => () => settle(p.id, false), [p.id]); // dismissed by a swipe: not confirmed
  const close = (ok: boolean) => {
    settle(p.id, ok);
    nav.goBack();
  };
  return (
    <View {...lk('confirm.sheet', s.sheet)}>
      <Text style={s.title} accessibilityRole="header">{t(p.title)}</Text>
      <Pressable {...lk('confirm.ok', s.primary)} onPress={() => close(true)} accessibilityRole="button">
        <Text style={s.primaryText}>{t(p.confirm)}</Text>
      </Pressable>
      <Pressable {...lk('confirm.cancel', s.cancel)} onPress={() => close(false)} accessibilityRole="button">
        <Text style={s.cancelText}>{t(p.cancel)}</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: color.white, paddingHorizontal: 20, paddingTop: 24, rowGap: 12 },
  title: type(700, 20, 28, color.ink900),
  primary: { height: 52, borderRadius: 14, backgroundColor: color.teal700, alignItems: 'center', justifyContent: 'center' },
  primaryText: type(700, 18, 25.2, color.white),
  cancel: { height: 44, alignItems: 'center', justifyContent: 'center' },
  cancelText: type(650, 16, 22.4, color.teal700),
});
