// SPDX-License-Identifier: AGPL-3.0-or-later
// CTL-CMP-03-01 on the native app (ruling D5a-1; DK-59): an in-place 2-option segmented control, English and Español, that re-renders
// the screen in the chosen language without leaving it.
import { Pressable, StyleSheet, View } from 'react-native';
import { T as Text, useBigText } from './text-size.tsx';
import type { Language } from '@bw/i18n/src/language.ts';
import { useT } from './intl.tsx';
import { lk } from './look.ts';
import { color, type } from './tokens.ts';

export function LanguageSegments(props: { id: string; value: Language; onChange: (l: Language) => void; width?: number }) {
  const t = useT();
  const big = useBigText(); // 14.2 item 2: at the largest sizes the 2 options stack and take the row's whole width
  const opts: [Language, string][] = [['en', t('language.name.en')], ['es', t('language.name.es')]];
  return (
    <View {...lk(props.id, [s.seg, big ? s.segBig : props.width ? { width: props.width } : null])} accessibilityRole="radiogroup">
      {opts.map(([lang, label]) => {
        const on = props.value === lang;
        return (
          <Pressable key={lang} {...lk(`${props.id}.${lang}`, [s.btn, big ? s.btnBig : null, on ? s.on : null])} onPress={() => props.onChange(lang)}
            accessibilityRole="radio" accessibilityState={{ selected: on }}>
            <Text {...lk(`${props.id}.${lang}.text`, [s.text, { color: on ? color.ink900 : color.ink800 }])}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  seg: { flexDirection: 'row', backgroundColor: '#eceef1', borderRadius: 9, padding: 2, height: 48 },
  btn: { flex: 1, borderRadius: 7, paddingVertical: 1, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center', height: 44 },
  segBig: { flexDirection: 'column', height: undefined, alignSelf: 'stretch' },
  btnBig: { height: undefined, minHeight: 44, flex: 0, paddingVertical: 4 },
  on: { backgroundColor: color.white, shadowColor: '#101828', shadowOpacity: 0.15, shadowRadius: 1.5, shadowOffset: { width: 0, height: 1 } },
  text: { ...type(600, 15, 18, color.ink900), textAlign: 'center' },
});
