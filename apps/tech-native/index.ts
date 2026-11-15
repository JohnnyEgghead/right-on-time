// SPDX-License-Identifier: AGPL-3.0-or-later
// The native app's entry (P6-NATIVE-SHELL; F-141): the Hermes Intl polyfills of R7 section 3.1 install before the first render (the
// catalog's plurals, numbers, dates, relative times and lists format through them), then the app renders. A polyfill that fails to
// load still lets the app open: the platform's own Intl answers what it can.
import { registerRootComponent } from 'expo';
import { createElement, useEffect, useState } from 'react';
import { installIntlPolyfills } from '@bw/i18n/src/polyfills.ts';
import App from './src/App.tsx';

const polyfills = installIntlPolyfills();

function Entry() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void polyfills.then(() => setReady(true), () => setReady(true));
  }, []);
  return ready ? createElement(App) : null;
}

registerRootComponent(Entry);
