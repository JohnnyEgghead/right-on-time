// SPDX-License-Identifier: AGPL-3.0-or-later
// The native technician app's root (P6-NATIVE-SHELL; SPECIFICATIONS 6.12, SD-47 Native app): the catalog (the native subset, F-1199) in the chosen language, the
// safe areas, and 1 root stack. Signed out: the sign-in screen, the server address (SCR-TEC-12) over it as a full-screen modal
// with its own Cancel and Save, and Forgot password (SCR-EML-03). Signed in: the tabs, and the sheets (form sheets) over them.
import { NavigationContainer, useNavigation } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BwIntlProviderFrom } from '@bw/i18n/src/provider-core.tsx';
import { ConfirmSheet } from './screens/Confirm.tsx';
import { ServerAddress } from './screens/ServerAddress.tsx';
import { SignIn } from './screens/SignIn.tsx';
import { Tabs } from './screens/Tabs.tsx';
import { ForgotScreen } from './screens/Forgot.tsx';
import { ROOT_SCREENS } from './screens/job/routes.tsx';
import { TextSized } from './screens/mapme/index.tsx';
import { nativeCatalogs } from './ui/catalog.ts';
import { color } from './ui/tokens.ts';
import { useApp } from './useApp.ts';

const Root = createNativeStackNavigator();

function SignInRoute() {
  const { app, state } = useApp();
  const nav = useNavigation<{ navigate(name: 'Server' | 'Forgot'): void }>();
  return <SignIn app={app} server={state.server} language={state.language} onServer={() => nav.navigate('Server')} onForgot={() => nav.navigate('Forgot')}
    saved={useSyncExternalStore(savedOnce.subscribe, () => savedOnce.value)} />;
}

/** Set when SCR-TEC-12's Save returned to the sign-in screen (the frames' Saved state, for the look dump). */
const savedOnce = {
  value: false,
  listeners: new Set<() => void>(),
  subscribe: (fn: () => void) => {
    savedOnce.listeners.add(fn);
    return () => void savedOnce.listeners.delete(fn);
  },
  set: () => {
    savedOnce.value = true;
    for (const fn of savedOnce.listeners) fn();
  },
};

function ServerRoute() {
  const { app, state } = useApp();
  const nav = useNavigation();
  const [initial] = useState(state.server);
  return <ServerAddress app={app} initial={initial} onDone={() => {
    if (app.snapshot.server !== initial) savedOnce.set(); // the sign-in screen re-renders: its Saved state is what the look dump reads
    nav.goBack();
  }} />;
}

/** SCR-EML-03 Forgot password (CTL-TEC-01-07), a native screen over the sign-in; Back to sign in (CTL-EML-03-05) returns to it. */
function ForgotRoute() {
  const { app } = useApp();
  const nav = useNavigation();
  return <ForgotScreen app={app} onBack={() => nav.goBack()} />;
}

export default function App() {
  const { state } = useApp();
  return (
    <BwIntlProviderFrom catalogs={nativeCatalogs} locale={state.language}>
      <SafeAreaProvider>
        {state.ready ? (
          <TextSized>
          <NavigationContainer>
            <Root.Navigator screenOptions={{ headerShown: false }}>
              {state.session ? (
                <>
                  <Root.Screen name="Tabs" component={Tabs} />
                  <Root.Screen name="Confirm" component={ConfirmSheet}
                    options={{ presentation: 'formSheet', sheetAllowedDetents: [0.32], sheetGrabberVisible: true }} />
                  {ROOT_SCREENS.map((x) => <Root.Screen key={x.name} name={x.name} component={x.component} {...(x.options ? { options: x.options } : {})} />)}
                </>
              ) : (
                <>
                  <Root.Screen name="SignIn" component={SignInRoute} />
                  <Root.Screen name="Server" component={ServerRoute} options={{ presentation: 'fullScreenModal' }} />
                  <Root.Screen name="Forgot" component={ForgotRoute} />
                </>
              )}
            </Root.Navigator>
          </NavigationContainer>
          </TextSized>
        ) : (
          <View style={{ flex: 1, backgroundColor: color.screen }} />
        )}
      </SafeAreaProvider>
    </BwIntlProviderFrom>
  );
}
