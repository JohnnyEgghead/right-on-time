// SPDX-License-Identifier: AGPL-3.0-or-later
// Opening a tab of the technician app (CMP-09; F-1232). router.push asks the server for the next screen's data and waits for the answer with no
// time limit of its own, so on an origin that takes the request and never answers (a weak or dead signal that drops packets) the tab waits for
// the browser's own timeout and the phone shows nothing new. After TAB_OPEN_MS the tab opens by a full page load instead, which the worker
// answers from the page it kept when the origin is silent (sw.js networkFirst, F-952) or with the app's no-signal page.
export const TAB_OPEN_MS = 2500;

let lastTapped = '';

// The route is watched every WATCH_MS until TAB_OPEN_MS. Any move off the page the tap started on (the tab opened, a job opened over it, Back)
// ends the wait, so the full load happens only when the tab's screen never opened at all (F-1240: a tab that opened fast and was left again
// inside the window is never pulled back).
const WATCH_MS = 100;

/** `push` is the router's; the full load is skipped when the route moved at all by then or another tab was tapped since. */
export function openTab(push: (href: string) => void, href: string, loc: Pick<Location, 'pathname' | 'assign'> = window.location): void {
  lastTapped = href;
  const from = loc.pathname;
  push(href);
  if (from === href) return;
  let waited = 0;
  const watch = (): void => {
    if (lastTapped !== href || loc.pathname !== from) return;
    waited += WATCH_MS;
    if (waited >= TAB_OPEN_MS) loc.assign(href);
    else window.setTimeout(watch, WATCH_MS);
  };
  window.setTimeout(watch, WATCH_MS);
}
