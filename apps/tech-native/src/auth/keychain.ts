// SPDX-License-Identifier: AGPL-3.0-or-later
// The Keychain through expo-secure-store (SPECIFICATIONS SD-47): readable after the phone's first unlock, so a send that runs while
// the phone is locked still has the token, and kept on this device only (never moved to another phone by a backup).
import * as SecureStore from 'expo-secure-store';
import type { SecretStore } from './session-store.ts';

const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export const keychain: SecretStore = {
  get: (key) => SecureStore.getItemAsync(key, OPTS),
  set: (key, value) => SecureStore.setItemAsync(key, value, OPTS),
  remove: (key) => SecureStore.deleteItemAsync(key, OPTS),
};
