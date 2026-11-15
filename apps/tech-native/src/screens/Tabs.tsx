// SPDX-License-Identifier: AGPL-3.0-or-later
// The signed-in app (SD-47 Native app: a tab bar and a stack per tab): Today, Map, Parts and Me (CMP-09). The tab screens' content is
// the later native tasks' (P6-NATIVE-TODAY, P6-NATIVE-JOB, P6-NATIVE-MAP-ME); the shell gives each tab its stack, its title and the
// waiting count, and Me the language and Sign out (CTL-TEC-10-04: refused while items wait, UD-20).
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar, StyleSheet, View } from 'react-native';
import { T as Text } from '../ui/text-size.tsx';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import { waitingTotal, type AppState, type NativeApp } from '../core.ts';
import { useT } from '../ui/intl.tsx';
import { lk, useLookDump } from '../ui/look.ts';
import { TabBar, TABS } from '../ui/TabBar.tsx';
import { color, type } from '../ui/tokens.ts';
import { useApp } from '../useApp.ts';
import { DirectionsRoute, MapBody, MeBody, PartsBody } from './mapme/index.tsx';
import { openWaiting } from './job/nav.ts';
import { TAB_SCREENS } from './job/routes.tsx';
import { useNavigation, type NavigationProp, type ParamListBase } from '@react-navigation/native';
import { TodayScreen } from './today/TodayScreen.tsx';

const Tab = createBottomTabNavigator();

function Header(props: { title: MessageKey; state: AppState }) {
  const t = useT();
  const top = useSafeAreaInsets().top;
  const n = waitingTotal(props.state); // F-985: a damaged item still waits on the phone
  const nav = useNavigation<NavigationProp<ParamListBase>>();
  // F-984: no verdict before the store is read; an empty line holds the place until outbox.ready.
  const known = props.state.outbox.ready;
  const line = !known ? '' : n > 0 ? t('tech.sync.waiting', { n }) : t('tech.sync.allSynced');
  return (
    <View style={[s.head, { paddingTop: top + 6 }]}>
      <StatusBar barStyle="light-content" />
      <Text style={s.title} accessibilityRole="header">{t(props.title)}</Text>
      <Text {...lk('sync.count', s.count)} accessibilityLabel={line} accessibilityRole="button" onPress={() => openWaiting(nav)}>
        {line}
      </Text>
    </View>
  );
}

// F-988: the note-entry probe is a rig seam, required only when the bundle is made with EXPO_PUBLIC_BW_RIG=1 (Metro drops it otherwise).
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a bundle-time conditional require is how Metro leaves the module out
const RIG: typeof import('./Probe.tsx') | null = process.env.EXPO_PUBLIC_BW_RIG === '1' ? require('./Probe.tsx') : null;

function TodayBody(props: { app: NativeApp; state: AppState }) {
  useLookDump(props.state.outbox.ready ? 'today' : null);
  return RIG?.PROBE_ON ? <RIG.Probe app={props.app} state={props.state} /> : null;
}

type Body = (p: { app: NativeApp; state: AppState }) => React.ReactNode;
const BODIES: Record<string, Body> = { Today: TodayBody, Map: MapBody, Parts: PartsBody, Me: MeBody };

/** 1 stack per tab, made once (a component made during render would remount the tab on every state change). */
const STACKS = Object.fromEntries(TABS.map((tab) => {
  const Stack = createNativeStackNavigator();
  const Body = BODIES[tab.route] as Body;
  function Root() {
    const { app, state } = useApp();
    // P6-NATIVE-TODAY: the Today tab is SCR-TEC-02 with its own teal bar (its sync pill is this Header's: waitingTotal, and a tap opens
    // SCR-TEC-09); the probe seam (xcuitest ShellUITests, MapMeUITests, JobUITests) keeps the shell's header.
    if (tab.route === 'Today' && !RIG?.PROBE_ON) return <TodayScreen app={app} state={state} />;
    return (
      <View style={s.screen}>
        {tab.route === 'Today' ? <Header title={tab.label} state={state} /> : null}
        <Body app={app} state={state} />
      </View>
    );
  }
  function TabStack() {
    return (
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name={`${tab.route}Root`} component={Root} />
        {(TAB_SCREENS[tab.route] ?? []).map((x) => <Stack.Screen key={x.name} name={x.name} component={x.component} {...(x.options ? { options: x.options } : {})} />)}
        <Stack.Screen name="Directions" component={DirectionsRoute} />
      </Stack.Navigator>
    );
  }
  return [tab.route, TabStack];
}));

export function Tabs() {
  return (
    <Tab.Navigator tabBar={(p) => <TabBar {...p} />} screenOptions={{ headerShown: false }}>
      {TABS.map((tab) => <Tab.Screen key={tab.route} name={tab.route} component={STACKS[tab.route] as () => React.ReactNode} />)}
    </Tab.Navigator>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.screen },
  head: { backgroundColor: color.teal900, paddingHorizontal: 16, paddingBottom: 12 },
  title: type(700, 30, 36, color.white),
  count: { ...type(600, 14, 19.6, color.teal100), marginTop: 3 },
  body: { padding: 18 },
});
