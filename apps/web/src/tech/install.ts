// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-11 Install the app, the pure part (UI-SPECIFICATION CTL-TEC-11-01 to -03; NFR-09): which steps the visitor's browser needs, and the
// phone's note that the guide was seen. No React, so the rules are tested without a browser (install.test.ts).

/** The 4 states of the page: Safari on iPhone; Chrome on Android with the browser's install prompt; Chrome on Android without it; any other browser. */
export const INSTALL_KINDS = ['iphone', 'android-prompt', 'android', 'other'] as const;
export type InstallKind = (typeof INSTALL_KINDS)[number];

/**
 * The state for a browser. Safari on iPhone is an iPhone, iPad or iPod browser that is Safari itself (the other iOS browsers say CriOS, FxiOS and
 * so on in their user agent and cannot add to the home screen the same way); Chrome on Android is Chrome itself (Edge, Opera, Samsung Internet and
 * Firefox are not). `hasPrompt` is whether the browser has offered its install prompt (the beforeinstallprompt event).
 */
export function installKind(userAgent: string, hasPrompt: boolean): InstallKind {
  if (/iPhone|iPad|iPod/.test(userAgent)) return /Safari\//.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(userAgent) ? 'iphone' : 'other';
  if (/Android/.test(userAgent) && /Chrome\//.test(userAgent) && !/EdgA|OPR\/|SamsungBrowser|Firefox|Vivaldi|DuckDuckGo/.test(userAgent)) return hasPrompt ? 'android-prompt' : 'android';
  return 'other';
}

export const INSTALL_SEEN_KEY = 'bw.tech.installSeen';

/** CTL-TEC-11-03 stops the page showing in this browser; a browser that keeps nothing shows it each time. */
export function installSeen(storage: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return storage?.getItem(INSTALL_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markInstallSeen(storage: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(INSTALL_SEEN_KEY, '1');
  } catch {
    // nothing is kept: the page shows again next time
  }
}
