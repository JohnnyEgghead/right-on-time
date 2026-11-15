// SPDX-License-Identifier: AGPL-3.0-or-later
// The XCUITest rig's sign-in seams (F-988, F-1111), kept out of the shipped screen. SignIn.tsx requires this file only when the bundle is
// made with EXPO_PUBLIC_BW_RIG=1 (xcuitest/run.sh), so the TestFlight bundle holds none of it.
// 1. The probe sign-in button (Probe.tsx), under -bwProbe.
// 2. The fill buttons (only with -bwLook and -bwProbeControl <origin>, the rig's control server): the states' sign-ins after the typed one
//    (xcuitest/TodayUITests.swift test0 types into the fields) are filled with a sample sign-in the rig holds (no password in a launch
//    argument), and the test presses Sign in itself.
import { Pressable, Settings, StyleSheet, Text, View } from 'react-native';
import type { NativeApp } from '../core.ts';
import { lk, LOOK_ON } from '../ui/look.ts';
import { color, type } from '../ui/tokens.ts';
import { ProbeSignIn } from './Probe.tsx';

const FILL_CONTROL = LOOK_ON ? String(Settings.get('bwProbeControl') ?? '') : '';

export function RigSignIn(props: { app: NativeApp; onFilled: (c: { login: string; password: string }) => void }) {
  const fill = async (who: string) => {
    const r = await fetch(`${FILL_CONTROL}/probe/credentials?who=${who}`);
    props.onFilled((await r.json()) as { login: string; password: string });
  };
  return (
    <>
      <ProbeSignIn app={props.app} />
      {FILL_CONTROL !== '' ? (
        <View style={s.fills}>
          {['maria', 'reviewer', 'off', 'wrong'].map((who) => (
            <Pressable key={who} {...lk(`fill.${who}`, s.fill)} onPress={() => void fill(who)} accessibilityRole="button" accessibilityLabel={`fill ${who}`}>
              <Text style={s.fillText}>{who}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </>
  );
}

const s = StyleSheet.create({
  fills: { flexDirection: 'row', columnGap: 8, marginTop: 8 },
  fill: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', borderWidth: 1, borderColor: color.ink300, borderRadius: 8 },
  fillText: type(400, 12, 16, color.ink600),
});
