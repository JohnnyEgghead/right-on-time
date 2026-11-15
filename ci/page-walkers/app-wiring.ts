// SPDX-License-Identifier: AGPL-3.0-or-later
// App wiring of the page walkers (P2-SHELL, the first UI lane): for each page-inventory row a lane has built, the URL
// of the app that shows it and the status that URL answers. The walkers open the URL on the harness app
// (ci/web-app.ts), check the page's root carries data-screen="<row.screen>" (the shell's convention,
// apps/web/src/shell/Surface.tsx), and run the 5 walkers on it in English and Spanish. The inventory rows themselves are
// never edited here (BUILD_PLAN D-9). A merged row with no entry keeps run-inventory.ts red.
import type { ScreenRow } from './inventory.ts';

export interface Wiring {
  /** Path on the app origin. */
  path: string;
  /** The HTTP status the page answers. */
  status: number;
  /** Further paths of the same screen walked as their own entries (a state the main path cannot show). */
  also?: readonly { path: string; status: number }[];
  /**
   * The page draws CMP-05 (a map): the harness app has no proxy, so /maps/<branch>.pmtiles is answered from .build/data/maps
   * (ci/look-values/map-files.ts, as the stack's proxy answers API-106). Without it the map file read never settles in
   * Chromium and the walk's networkidle load times out. The files must be present (the walker gates fetch them).
   */
  maps?: true;
}

/**
 * The 3 shared pages answer on any route with that status: the 404 is an unknown release route; the 403 and the 500
 * are the harness routes whose read answers `forbidden` and `server_error` through the same enforce() a page calls.
 */
export const APP_WIRING: Readonly<Record<string, Wiring>> = {
  'SCR-SHR-01': { path: '/shell-preview/status/403', status: 403 },
  'SCR-SHR-02': { path: '/this-page-does-not-exist', status: 404 },
  'SCR-SHR-03': { path: '/shell-preview/status/500', status: 500 },
  // P2-AUTH. The sign-in page is its release route (the harness app has no database, so its Sign in as list is absent: demo mode off).
  // The gate answers 403 on any route with the code on and not entered; the harness app runs with the code off, so its preview route
  // shows the screen directly. The start page's preview route shows the demo state (the sign-in list and the install line).
  // F-287: the Sign in as list and its .who buttons show only with demo mode on, so the default preview is walked too.
  'SCR-OFC-01': { path: '/sign-in', status: 200, also: [{ path: '/shell-preview/auth-signin/default', status: 200 }] },
  'SCR-GATE-01': { path: '/shell-preview/auth-gate/empty', status: 200 },
  'SCR-GATE-02': { path: '/shell-preview/auth-start/link', status: 200 },
  // P4-ADMIN-IMPORT. The release routes read the API, which the harness app has no database for, so the walkers open the pages through
  // their preview states: the report, the shown pair and both tables in the data the frames show.
  'SCR-OFC-13': { path: '/shell-preview/import-dry/dry-report', status: 200, also: [{ path: '/shell-preview/import-dry/dry-running', status: 200 }, { path: '/shell-preview/import-dry/dry-failed', status: 200 }] },
  'SCR-OFC-14': { path: '/shell-preview/import-dups/dups-success', status: 200, also: [{ path: '/shell-preview/import-dups/dups-done', status: 200 }] },
  // The dialogs are walked open in their tile (a host page's dialog row has no route of its own).
  'SCR-OFC-25': { path: '/shell-preview/import-dry/dlg-asking', status: 200 },
  'SCR-OFC-26': { path: '/shell-preview/import-hist/undo-asking', status: 200 },
  'SCR-OFC-15': { path: '/shell-preview/import-hist/hist-success', status: 200, also: [{ path: '/shell-preview/import-hist/hist-running', status: 200 }] },
  // P4-ACCOUNTS. The harness app has no database, so each screen is walked on its preview routes, fixed to its frame's data; a
  // dialog's preview carries the dialog's own screen ID on the root (1 root per page) with the dialog open on its host page.
  // Forgot password's release route renders its default state with no read, so it is walked too.
  'SCR-OFC-43': { path: '/shell-preview/accounts-users/success', status: 200, also: [{ path: '/shell-preview/accounts-users/nomatch', status: 200 }] },
  'SCR-OFC-44': { path: '/shell-preview/accounts-users/invite-editing', status: 200, also: [{ path: '/shell-preview/accounts-users/invite-sent', status: 200 }] },
  'SCR-OFC-45': { path: '/shell-preview/accounts-users/role-choosing', status: 200 },
  'SCR-OFC-46': { path: '/shell-preview/accounts-users/off-asking', status: 200 },
  'SCR-EML-01': { path: '/shell-preview/accounts-email/shown', status: 200, also: [{ path: '/shell-preview/accounts-email/used', status: 200 }] },
  'SCR-EML-02': { path: '/shell-preview/accounts-setpw/ready', status: 200, also: [{ path: '/shell-preview/accounts-setpw/off', status: 200 }] },
  'SCR-EML-03': { path: '/forgot-password', status: 200, also: [{ path: '/shell-preview/accounts-forgot/sent', status: 200 }] },
  // P4-BILLING-UI. The harness app has no database, so each screen's preview route shows it with its frame's data. SCR-OFC-47 is a dialog
  // with its own screen root: its preview route draws the dialog alone, because the walkers expect exactly 1 screen root in a document.
  'SCR-OFC-10': { path: '/shell-preview/billing/success', status: 200 },
  'SCR-OFC-47': { path: '/shell-preview/billing/dialog', status: 200 },
  'SCR-PBS-01': { path: '/shell-preview/pbs-list/success', status: 200 },
  'SCR-PBS-02': { path: '/shell-preview/pbs-invoice/success', status: 200 },
  // P4-MESSAGES. The harness app has no database, so each screen is walked on its preview routes, fixed to its frame's data: the text log with
  // its panel open and in its empty, error and live states, the call list in its default success state and with the Spanish customer's row picked, and in its empty, error and correcting states (the
  // script and the texts carry lang, and the Spanish walker skips text in another language, F-658).
  'SCR-OFC-08': { path: '/shell-preview/messages/success', status: 200, also: [{ path: '/shell-preview/messages/empty-day', status: 200 }, { path: '/shell-preview/messages/error', status: 200 }, { path: '/shell-preview/messages/live', status: 200 }] },
  'SCR-OFC-09': { path: '/shell-preview/call-list/success', status: 200, also: [{ path: '/shell-preview/call-list/script-es', status: 200 }, { path: '/shell-preview/call-list/empty', status: 200 }, { path: '/shell-preview/call-list/error', status: 200 }, { path: '/shell-preview/call-list/correcting', status: 200 }] },
  // P4-CLOCK. The release route reads the API, which the harness app has no database for, so the walkers open the page through its preview
  // states: running, catching up and the cool-down in the data the frame shows. The reset dialog is walked open in its tile.
  'SCR-OFC-17': { path: '/shell-preview/clock/running', status: 200, also: [{ path: '/shell-preview/clock/catching-up', status: 200 }, { path: '/shell-preview/clock/cooldown', status: 200 }] },
  'SCR-OFC-27': { path: '/shell-preview/clock/dlg-asking', status: 200 },
  // P4-WEEK. The release route is behind the page gate (a session); the preview route shows the success state on the frame's data.
  'SCR-OFC-34': { path: '/shell-preview/week/success', status: 200, also: [{ path: '/shell-preview/week/loading', status: 200 }, { path: '/shell-preview/week/error', status: 200 }] },
  // P4-CUSTOMERS. The release routes are behind the page gate (a session); the preview routes show the screens on the frames' data. The
  // dialogs are walked on their own in the frame their page draws them in (exactly 1 screen root each).
  'SCR-OFC-05': { path: '/shell-preview/customers/results', status: 200, also: [{ path: '/shell-preview/customers/empty', status: 200 }, { path: '/shell-preview/customers/none', status: 200 }, { path: '/shell-preview/customers/error', status: 200 }] },
  'SCR-OFC-38': { path: '/shell-preview/customers/solo-new-empty', status: 200, also: [{ path: '/shell-preview/customers/solo-new-nomatch', status: 200 }] },
  'SCR-OFC-06': { path: '/shell-preview/customer/success', status: 200, also: [{ path: '/shell-preview/customer/loading', status: 200 }, { path: '/shell-preview/customer/zone-edit', status: 200 }] },
  'SCR-OFC-39': { path: '/shell-preview/customer/solo-edit-editing', status: 200 },
  'SCR-OFC-40': { path: '/shell-preview/customer/solo-map', status: 200 },
  // P4-JOBS. The release route is behind the page gate (a session) and reads the API, which the harness app has no database for; the preview routes
  // show the success state on the frame's data, and the loading and error states beside it.
  'SCR-OFC-30': { path: '/shell-preview/jobs/success', status: 200, also: [{ path: '/shell-preview/jobs/loading', status: 200 }, { path: '/shell-preview/jobs/error', status: 200 }] },
  // P4-NEWJOB. The release route is behind the page gate (a session) and reads the API, which the harness app has no database for; the preview routes
  // show the page on the frame's data (Harold Jenkins, a water heater visit with Kevin Doyle): customer picked, start, no match, no open window, saving, input kept.
  // The Done state is SCR-OFC-03 (walked by P4-JOB's rows) and draws only its toast here.
  'SCR-OFC-04': { path: '/shell-preview/newjob/picked', status: 200, also: [{ path: '/shell-preview/newjob/start', status: 200 }, { path: '/shell-preview/newjob/no-match', status: 200 }, { path: '/shell-preview/newjob/no-windows', status: 200 }, { path: '/shell-preview/newjob/saving', status: 200 }, { path: '/shell-preview/newjob/input-kept', status: 200 }] },
  // P5-BOOKING. The booking site is public, but its release routes read the API, which the harness app has no database for: the walkers open the preview
  // routes on the frames' data (Harold Jenkins, a furnace tune-up, today Thu, Sep 10): SCR-CUS-01 on the wide Step 1 to 6 picture and in its states, the phone
  // layout (the walkers also run at 520 and 390 px), SCR-CUS-02 with its options and with none nearby, SCR-CUS-03 with texts, with texts held, with none, loading and 404.
  'SCR-CUS-01': { path: '/shell-preview/booking/steps', status: 200, also: [{ path: '/shell-preview/booking/phone', status: 200 }, { path: '/shell-preview/booking/loading', status: 200 }, { path: '/shell-preview/booking/no-match', status: 200 }, { path: '/shell-preview/booking/street-results', status: 200 }, { path: '/shell-preview/booking/no-days', status: 200 }, { path: '/shell-preview/booking/day-full', status: 200 }, { path: '/shell-preview/booking/no-mobile', status: 200 }, { path: '/shell-preview/booking/booking', status: 200 }, { path: '/shell-preview/booking/booking-closed', status: 200 }, { path: '/shell-preview/booking/phone-day', status: 200 }] },
  'SCR-CUS-02': { path: '/shell-preview/booking-taken/options', status: 200, also: [{ path: '/shell-preview/booking-taken/none-nearby', status: 200 }, { path: '/shell-preview/booking-taken/booking', status: 200 }, { path: '/shell-preview/booking-taken/filled-again', status: 200 }] },
  'SCR-CUS-03': { path: '/shell-preview/booking-done/success', status: 200, also: [{ path: '/shell-preview/booking-done/held', status: 200 }, { path: '/shell-preview/booking-done/no-texts', status: 200 }, { path: '/shell-preview/booking-done/loading', status: 200 }, { path: '/shell-preview/booking-done/not-found', status: 200 }] },
  // P4-JOB. The release route is behind the page gate (a session) and reads the API, which the harness app has no database for; the preview routes
  // show Harold Jenkins's job as DK-87 draws it: On the way (the panel and its small map), loading, and closed (Done: the actions off). Each dialog
  // is walked alone in a frame named for it (exactly 1 screen root).
  'SCR-OFC-03': { path: '/shell-preview/job/success', status: 200, maps: true, also: [{ path: '/shell-preview/job/loading', status: 200 }, { path: '/shell-preview/job/done', status: 200 }] },
  'SCR-OFC-20': { path: '/shell-preview/job/solo-reschedule-choosing', status: 200 },
  'SCR-OFC-21': { path: '/shell-preview/job/solo-cancel-asking', status: 200 },
  'SCR-OFC-22': { path: '/shell-preview/job/solo-finish-empty', status: 200 },
  'SCR-OFC-23': { path: '/shell-preview/job/solo-edit-editing', status: 200 },
  'SCR-OFC-35': { path: '/shell-preview/job/solo-text-typing', status: 200 },
  'SCR-OFC-36': { path: '/shell-preview/job/solo-note-typing', status: 200 },
  'SCR-OFC-37': { path: '/shell-preview/job/solo-equipment-editing', status: 200 },
  // P4-REPORTS. The release route is behind the page gate (a session) and reads the API, which the harness app has no database for; the preview routes
  // show the report on the frame's data, with the loading, empty and error states beside it.
  'SCR-OFC-11': { path: '/shell-preview/reports/success', status: 200, also: [{ path: '/shell-preview/reports/loading', status: 200 }, { path: '/shell-preview/reports/empty', status: 200 }, { path: '/shell-preview/reports/error', status: 200 }, { path: '/shell-preview/reports/tables', status: 200 }] },
  // P4-TECHNICIANS. The release route is behind the page gate (a session) and reads the API, which the harness app has no database for; the preview routes
  // show the frame's Columbus day (12 technicians, Maria Santos open in the panel), and the loading and error states beside it. Each dialog is walked
  // alone in a frame named for it (exactly 1 screen root).
  'SCR-OFC-07': { path: '/shell-preview/technicians/success', status: 200, also: [{ path: '/shell-preview/technicians/loading', status: 200 }, { path: '/shell-preview/technicians/error', status: 200 }, { path: '/shell-preview/technicians/hours-editing', status: 200 }, { path: '/shell-preview/technicians/hours-problem', status: 200 }] },
  'SCR-OFC-41': { path: '/shell-preview/technicians/solo-add-editing', status: 200, also: [{ path: '/shell-preview/technicians/solo-add-hours', status: 200 }] },
  'SCR-OFC-42': { path: '/shell-preview/technicians/solo-timeoff-editing', status: 200 },
  // P4-BOARD. The harness app has no database, so the board is walked on its harness states (the frame's sample day): at rest,
  // and with a job dragged and dropped. Each hosted screen is walked alone in a frame named for it (exactly 1 screen root).
  'SCR-OFC-02': { path: '/shell-preview/board/success', status: 200, maps: true, also: [{ path: '/shell-preview/board/moving', status: 200 }, { path: '/shell-preview/board/skill-filter', status: 200 }, { path: '/shell-preview/board/flagged-entries', status: 200 }] },
  'SCR-OFC-18': { path: '/shell-preview/board/solo-reassign-previewing', status: 200 },
  'SCR-OFC-19': { path: '/shell-preview/board/solo-conflict-shown', status: 200 },
  'SCR-OFC-29': { path: '/shell-preview/board/solo-job-open', status: 200 },
  'SCR-OFC-31': { path: '/shell-preview/board/solo-block-adding', status: 200 },
  'SCR-OFC-32': { path: '/shell-preview/board/solo-blockpop-open', status: 200 },
  'SCR-OFC-33': { path: '/shell-preview/board/solo-delete-asking', status: 200 },
  // P4-HEALTH. The harness app has no database, so System health and the bell's panel are walked on their preview routes, fixed to their frames'
  // data: the success state, the loading and error states, and the page with no backup set up; the panel with alerts and with none.
  'SCR-OFC-16': { path: '/shell-preview/health/success', status: 200, also: [{ path: '/shell-preview/health/loading', status: 200 }, { path: '/shell-preview/health/error', status: 200 }, { path: '/shell-preview/health/no-backup', status: 200 }, { path: '/shell-preview/health/dismiss', status: 200 }, { path: '/shell-preview/health/dismissed', status: 200 }] },
  'SCR-OFC-28': { path: '/shell-preview/alerts/success', status: 200, also: [{ path: '/shell-preview/alerts/empty', status: 200 }, { path: '/shell-preview/alerts/dismiss', status: 200 }, { path: '/shell-preview/alerts/dismissed', status: 200 }] },
  // P4-ADMIN-WINDOWS. The release route is behind the page gate (a session) and reads the API, which the harness app has no database for; the
  // preview routes show the arrival windows page on its frame's data (Columbus, Tue, Sep 15): the success state, the loading and error states, a limit
  // refused below its bookings, a switched day and a picked Saturday. The switch dialog is walked open in its tile (exactly 1 screen root).
  'SCR-OFC-12': { path: '/shell-preview/windows/success', status: 200, also: ['loading', 'error', 'refused', 'switched', 'saturday'].map((n) => ({ path: `/shell-preview/windows/${n}`, status: 200 })) },
  'SCR-OFC-24': { path: '/shell-preview/windows/dlg-asking', status: 200 },
  // P5-INBOX. The release routes read the API, which the harness app has no database for; the preview routes show the text inbox on its frames' data
  // (Harold Jenkins; the walkers run both languages on every route, and the Spanish frame is its own route; the walk keeps to the states that differ in what they draw, the look cases hold every state) and Change your visit time on its frame's data.
  'SCR-INB-01': { path: '/shell-preview/inbox/success', status: 200, also: ['loading', 'nomobile', 'notvalid', 'error', 'ended', 'spanish', 'late'].map((n) => ({ path: `/shell-preview/inbox/${n}`, status: 200 })) },
  'SCR-CUS-06': { path: '/shell-preview/reschedule/choosing', status: 200, also: ['noother', 'changed', 'ended', 'notvalid'].map((n) => ({ path: `/shell-preview/reschedule/${n}`, status: 200 })) },
  // P5-LIVEMAP. The release route is the customer's live map link (a token), which the harness app has no database for; the preview routes show the
  // page on its frames' data: the live map (CMP-05, so the map files), its loading, not valid and update failed states, and the ended page by
  // arrival, ended for another reason and with the visit changed. The ended page draws no map.
  'SCR-CUS-04': { path: '/shell-preview/livemap/on-the-way', status: 200, maps: true, also: [{ path: '/shell-preview/livemap/loading', status: 200 }, { path: '/shell-preview/livemap/not-valid', status: 200 }, { path: '/shell-preview/livemap/update-failed', status: 200 }] },
  'SCR-CUS-05': { path: '/shell-preview/livemap-ended/by-arrival', status: 200, also: [{ path: '/shell-preview/livemap-ended/changed', status: 200 }] },
  // P5-TWA-TODAY. The technician sign-in is its release route (public; the harness app has no database, so its Sign in as list is absent) and its
  // preview states; Today reads the API, which the harness app has no database for, so it is walked on its preview routes, fixed to the frame's day
  // (Maria Santos, Tue, Sep 15). Each confirm sheet is walked open on Today with its own screen ID on the root (exactly 1 screen root).
  'SCR-TEC-01': { path: '/tech/sign-in', status: 200, also: ['default', 'wrong', 'waiting'].map((n) => ({ path: `/shell-preview/tech-signin/${n}`, status: 200 })) },
  'SCR-TEC-02': { path: '/shell-preview/tech-today/success', status: 200, also: ['late', 'loading', 'none', 'alldone', 'offline-saved', 'offline-none', 'pending', 'arrived-saved', 'noh-saved'].map((n) => ({ path: `/shell-preview/tech-today/${n}`, status: 200 })) },
  'SCR-TEC-03': { path: '/shell-preview/tech-today/omw', status: 200, also: [{ path: '/shell-preview/tech-today/omw-offline', status: 200 }] },
  'SCR-TEC-13': { path: '/shell-preview/tech-today/arrived', status: 200 },
  'SCR-TEC-14': { path: '/shell-preview/tech-today/noh', status: 200, also: [{ path: '/shell-preview/tech-today/noh-offline', status: 200 }] },
  // P5-BOOKING-PAGES. SCR-CUS-07 is 1 screen at 5 routes and the pages read nothing, so the walkers open the 5 preview routes, each fixed to its
  // frame's clock and footer data (the harness app has no API for the strip and the footer to read).
  'SCR-CUS-07': { path: '/shell-preview/bookmenu/heating', status: 200, also: ['cooling', 'plumbing', 'comfort-club', 'about-us'].map((n) => ({ path: `/shell-preview/bookmenu/${n}`, status: 200 })) },
  // P5-TWA-JOB. The release routes are behind the page gate (a technician's session) and read API-101 in the browser, which the harness app
  // has no database for; the preview routes show Harold Jenkins's Sep 15 job as DK-110 to DK-112 draw it, each other state beside it.
  'SCR-TEC-04': { path: '/shell-preview/tech-job/success', status: 200, also: [{ path: '/shell-preview/tech-job/offline', status: 200 }, { path: '/shell-preview/tech-job/not-on-phone', status: 200 }, { path: '/shell-preview/tech-job/not-yours', status: 200 }, { path: '/shell-preview/tech-job/done', status: 200 }, { path: '/shell-preview/tech-job/canceled', status: 200 }, { path: '/shell-preview/tech-job/on-site', status: 200 }, { path: '/shell-preview/tech-job/menu', status: 200 }, { path: '/shell-preview/tech-job/viewer', status: 200 }, { path: '/shell-preview/tech-job/finished', status: 200 }] },
  'SCR-TEC-05': { path: '/shell-preview/tech-note/typing', status: 200, also: [{ path: '/shell-preview/tech-note/empty', status: 200 }, { path: '/shell-preview/tech-note/restored', status: 200 }, { path: '/shell-preview/tech-note/saved-offline', status: 200 }, { path: '/shell-preview/tech-note/discard', status: 200 }] },
  'SCR-TEC-06': { path: '/shell-preview/tech-job/photo-none', status: 200, also: [{ path: '/shell-preview/tech-job/photo-preview', status: 200 }] },
  'SCR-TEC-07': { path: '/shell-preview/tech-finish/signed', status: 200, also: [{ path: '/shell-preview/tech-finish/editing', status: 200 }, { path: '/shell-preview/tech-finish/no-parts-list', status: 200 }, { path: '/shell-preview/tech-finish/invalid', status: 200 }, { path: '/shell-preview/tech-finish/confirming', status: 200 }, { path: '/shell-preview/tech-finish/restored', status: 200 }] },
  'SCR-TEC-09': { path: '/shell-preview/tech-waiting/offline', status: 200, also: [{ path: '/shell-preview/tech-waiting/nothing', status: 200 }, { path: '/shell-preview/tech-waiting/sending', status: 200 }, { path: '/shell-preview/tech-waiting/partial', status: 200 }, { path: '/shell-preview/tech-waiting/refused', status: 200 }, { path: '/shell-preview/tech-waiting/old', status: 200 }] },
  // P5-TWA-MAP-ME. The release routes sit behind a technician session and read the API, which the harness app has no database for; the preview routes
  // show each screen on its frames' data (Maria Santos, Tue, Sep 15, 10:26 AM): the Map tab and Directions draw CMP-05 (so the map files), the
  // walk keeps to the states that differ in what they draw (the look cases hold every state).
  'SCR-TEC-15': { path: '/shell-preview/tech-map/route', status: 200, maps: true, also: ['loading', 'offline', 'nojobs', 'alldone'].map((n) => ({ path: `/shell-preview/tech-map/${n}`, status: 200 })) },
  'SCR-TEC-08': { path: '/shell-preview/tech-dir/route', status: 200, maps: true, also: ['loading', 'approximate', 'offlinesaved', 'offline', 'notloaded', 'moved', 'updated', 'nonext'].map((n) => ({ path: `/shell-preview/tech-dir/${n}`, status: 200 })) },
  'SCR-TEC-10': { path: '/shell-preview/tech-me/success', status: 200, also: ['refused', 'signing', 'offline', 'notstarted', 'sizeopen'].map((n) => ({ path: `/shell-preview/tech-me/${n}`, status: 200 })) },
  'SCR-TEC-16': { path: '/shell-preview/tech-parts/results', status: 200, also: ['empty', 'nomatch', 'nocopy', 'offline'].map((n) => ({ path: `/shell-preview/tech-parts/${n}`, status: 200 })) },
  'SCR-TEC-11': { path: '/shell-preview/tech-install/iphone', status: 200, also: ['android-prompt', 'android', 'other'].map((n) => ({ path: `/shell-preview/tech-install/${n}`, status: 200 })) },
};

export function wiringFor(rows: readonly ScreenRow[], wiring: Readonly<Record<string, Wiring>> = APP_WIRING) {
  const wired: (ScreenRow & Wiring)[] = [];
  const unwired: ScreenRow[] = [];
  for (const r of rows) {
    const w = wiring[r.screen];
    if (w) {
      const { also = [], ...main } = w;
      wired.push({ ...r, ...main });
      for (const x of also) wired.push({ ...r, ...x, ...(main.maps ? { maps: main.maps } : {}), name: `${r.name} at ${x.path}` });
    }
    else unwired.push(r);
  }
  return { wired, unwired };
}
