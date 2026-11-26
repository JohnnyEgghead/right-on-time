// SPDX-License-Identifier: AGPL-3.0-or-later
// The job screens' half of the XCUITest seam (src/screens/Probe.tsx; only with "-bwProbe 1"): Open job opens the Job screen (SCR-TEC-04) for the probe
// job, and Damage an item writes 1 waiting-item file that does not parse into the item store's
// directory, by the store's own name rule (F-985: what a power loss right after Saved can leave), so the suite can show that the
// waiting count, SCR-TEC-09 and the sign-out guard all count it. The store's rules are not touched: the file is only named like an item.
import { useNavigation, type NavigationProp, type ParamListBase } from '@react-navigation/native';
import { randomUUID } from 'expo-crypto';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeApp } from '../../core.ts';
import { expoDir } from '../../store/expo-dir.ts';
import { useT } from '../../ui/intl.tsx';
import { lk } from '../../ui/look.ts';
import { color, type } from '../../ui/tokens.ts';

export function JobProbe(props: { app: NativeApp; job: number }) {
  const t = useT();
  const nav = useNavigation<NavigationProp<ParamListBase>>();
  const damage = () => {
    expoDir('bw-items').create(`i-${'9'.repeat(12)}-${randomUUID().toLowerCase()}-000001.json`, '{"key": "unfinished');
    void props.app.sync();
  };
  return (
    <View style={s.row}>
      <Pressable {...lk('probe.openJob', s.button)} onPress={() => nav.navigate('Job', { jobNumber: props.job })} accessibilityRole="button">
        <Text style={s.text}>{t('tech.job.number', { job: props.job })}</Text>
      </Pressable>
      <Pressable {...lk('probe.damage', s.button)} onPress={damage} accessibilityRole="button">
        <Text style={s.text}>{t('tech.waiting.damaged')}</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', columnGap: 10, paddingHorizontal: 18 },
  button: { flex: 1, height: 44, borderRadius: 11, backgroundColor: color.teal700, alignItems: 'center', justifyContent: 'center' },
  text: type(650, 15, 18, color.white),
});
