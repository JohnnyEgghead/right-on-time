// SPDX-License-Identifier: AGPL-3.0-or-later
// Which web technician pages carry an API answer in their HTML (F-980; SPECIFICATIONS SD-47: the service worker never keeps an
// API answer). The web process marks such a page with the header X-Bw-Server-State, and src/tech/sw.js never keeps a marked page.
//
// SCR-TEC-02 Today renders its first read (API-100, the day's jobs) on the server, so a signed-in open paints the list with no
// skeleton; that page is marked. The same address with `?bw-shell=1` is the page's shell alone: no read, no mark. The worker keeps
// that variant under the page's address (sw.js keep), so an open with no signal still opens the app and shows the day saved on the
// phone (UI-SPECIFICATION 4.5). A later technician page that embeds a read is added to SCREENS_WITH_SERVER_STATE.
export const SERVER_STATE_HEADER = 'x-bw-server-state';
export const SHELL_QUERY = 'bw-shell';

export const SCREENS_WITH_SERVER_STATE: ReadonlySet<string> = new Set(['SCR-TEC-02']);

/** Whether the answer for this screen and request URL carries an API read in its HTML. */
export function embedsServerState(screen: string, url: string): boolean {
  if (!SCREENS_WITH_SERVER_STATE.has(screen)) return false;
  return new URL(url, 'http://web').searchParams.get(SHELL_QUERY) !== '1';
}
