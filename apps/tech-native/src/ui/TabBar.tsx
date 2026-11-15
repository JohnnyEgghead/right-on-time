// SPDX-License-Identifier: AGPL-3.0-or-later
// CMP-09 native tab bar (DK-53; DK-117 option B, the Today frame): Today, Map, Parts and Me, the current tab in --teal-700 with the
// orange bar over it, the others in --ink-500. 82 px tall with the home indicator area inside it, as the frame draws it.
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Pressable, StyleSheet, View } from 'react-native';
import { T as Text } from './text-size.tsx';
import { Icon } from './Icon.tsx';
import type { NativeIcon } from './icon-paths.ts';
import { useT } from './intl.tsx';
import { lk } from './look.ts';
import { color, type } from './tokens.ts';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';

/** The 4 tabs in the frame's order, with their controls (CTL-CMP-09-01, -03, -04, -02). */
export const TABS: { route: string; icon: NativeIcon; label: MessageKey; ctl: string }[] = [
  { route: 'Today', icon: 'list', label: 'tech.tab.today', ctl: 'CTL-CMP-09-01' },
  { route: 'Map', icon: 'map', label: 'tech.tab.map', ctl: 'CTL-CMP-09-03' },
  { route: 'Parts', icon: 'box', label: 'tech.tab.parts', ctl: 'CTL-CMP-09-04' },
  { route: 'Me', icon: 'user', label: 'tech.tab.me', ctl: 'CTL-CMP-09-02' },
];

export function TabBar({ state, navigation }: BottomTabBarProps) {
  const t = useT();
  const current = state.routes[state.index]?.name;
  return (
    <View {...lk('tabbar', s.bar)} accessibilityRole="tabbar">
      <View {...lk('tabbar.border', s.border)} />
      {TABS.map((tab) => {
        const on = tab.route === current;
        const fg = on ? color.teal700 : color.ink500;
        const id = `tab.${tab.route.toLowerCase()}`;
        return (
          <Pressable key={tab.route} {...lk(id, s.tab)} onPress={() => navigation.navigate(tab.route)} accessibilityRole="tab"
            accessibilityState={{ selected: on }} accessibilityLabel={t(tab.label)}>
            {on ? <View {...lk(`${id}.mark`, s.mark)} /> : null}
            <Icon id={`${id}.icon`} name={tab.icon} size={25} color={fg} />
            <Text {...lk(`${id}.text`, [s.label, { color: fg }])}>{t(tab.label)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  // The frame's 1 px top border is drawn as a 1 px band (a one-sided border is not a UIKit layer border, so UIKit could not report it).
  bar: { height: 82, backgroundColor: color.white, paddingTop: 8, paddingHorizontal: 8, flexDirection: 'row', justifyContent: 'space-around' },
  border: { position: 'absolute', top: 0, left: 0, right: 0, height: 1, backgroundColor: color.ink200 },
  tab: { width: 88, minHeight: 44, height: 74, alignItems: 'center', rowGap: 3, columnGap: 3 },
  mark: { position: 'absolute', top: -8, width: 38, height: 3, borderBottomLeftRadius: 3, borderBottomRightRadius: 3, backgroundColor: color.orange500 },
  label: { ...type(600, 11, 15.4, color.ink500), textAlign: 'center' },
});
