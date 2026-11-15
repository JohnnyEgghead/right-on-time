// SPDX-License-Identifier: AGPL-3.0-or-later
// The BwBrowser native module's JavaScript face (ios/BwBrowserModule.swift): the in-app browser (SFSafariViewController). Absent in a build
// without it, open answers false and the caller says the page could not open; the system browser is never used in its place.
import { requireOptionalNativeModule } from 'expo';

const mod = requireOptionalNativeModule<{ open(address: string): Promise<boolean> }>('BwBrowser');

/** Opens an http(s) page of the app's server in the in-app browser; true once it is on screen. */
export async function openInApp(address: string): Promise<boolean> {
  return mod ? mod.open(address) : false;
}
