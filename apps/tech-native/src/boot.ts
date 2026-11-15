// SPDX-License-Identifier: AGPL-3.0-or-later
// The phone's services for the controller (core.ts): the 2 directories, the Keychain, the background uploads, the system clock
// through the seam (@bw/time realNow, with its named uses), the platform's UUID v4 source and the device's language.
import { randomUUID } from 'expo-crypto';
import { Platform, Settings } from 'react-native';
import { realNow } from '@bw/time';
import { keychain } from './auth/keychain.ts';
import { NativeApp } from './core.ts';
import { expoUpload } from './net/expo-upload.ts';
import { expoDir } from './store/expo-dir.ts';
import { LOOK_ON } from './ui/look.ts';

/** The phone's first preferred language (iOS NSUserDefaults AppleLanguages), for "device language before sign-in". */
function deviceLanguage(): string | null {
  const langs = Settings.get('AppleLanguages') as unknown;
  return Array.isArray(langs) && typeof langs[0] === 'string' ? langs[0] : null;
}

let app: NativeApp | null = null;

export function nativeApp(): NativeApp {
  if (app) return app;
  app = new NativeApp({
    itemsDir: expoDir('bw-items'),
    settingsDir: expoDir('bw-settings'),
    jobsDir: expoDir('bw-jobs'),
    mapmeDir: expoDir('bw-mapme'),
    personDir: expoDir('bw-person'),
    secrets: keychain,
    upload: expoUpload(),
    fetch: (input, init) => fetch(input, init),
    deviceNow: () => realNow('device_stamp'),
    bannerNow: () => realNow('tech_waiting_banner').epochMilliseconds,
    uuid: randomUUID,
    deviceLanguage: deviceLanguage(),
    device: `iPhone app (iOS ${String(Platform.Version)})`,
    serverOverride: process.env.EXPO_PUBLIC_BW_RIG === '1' && LOOK_ON ? String(Settings.get('bwServer') ?? '') || null : null,
  });
  return app;
}
