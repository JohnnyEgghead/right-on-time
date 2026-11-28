# Changelog

All dates are in Eastern time. Each entry names the public release tag.

## v1.0.7 - Nov 28, 2026

- A billing item that billing gave up on now says so. The billing page shows "Billing stopped trying after its failed runs", in English and Spanish. Before, it showed "Waiting for its first try".
- The Fixed card names the reason "Billing gave up" for such an item. Before, its reason was blank.
- When a job has both failed tries and a give-up, the latest event wins. A Send again that fails after the give-up shows that try's reason.
- The system health page's billing card uses the same reason as the billing page.
- Adds no database migration, so no data reset is needed.
- The iPhone app stays at version 1.0.1 (build 9). The fix changes only the office billing words and the health card. No call or answer shape that app uses changed.

## v1.0.6 - Nov 28, 2026

- A billing item that failed every try and now waits for a person stays on the office billing list. Before, it left the list, so Mark fixed refused it, and its alert linked to a list that did not hold it.
- Adds no database migration, so no data reset is needed.
- The iPhone app stays at version 1.0.1 (build 9). The fix changes only which items the office billing list holds. No call or answer shape that app uses changed.

## v1.0.5 - Nov 27, 2026

- Adds the fixes from a code audit of the server, the office screens, the web technician app and the public files.
- Booking a job twice, by a double click or a retried request, no longer makes 2 jobs. Each booking carries a booking key, and the server treats a repeat of the same key as the same booking.
- A button that saves a change is blocked while its save is still running. This covers the online booking page, Turn on, the invite dialog and the other office writes.
- The office screens keep the newest answer when 2 reads of the same view overlap. An older answer that arrives late no longer replaces it.
- A change that only takes work off a technician's day is never refused for an overlap. An edit to a shorter service is not refused for an overlap its new planned times make. The board shows such an overlap for the office to fix.
- The job screens show the server's reason when a change is refused.
- Failures in the background worker and the pretend billing service now end with a count and a cause, and a retry gives up after its limit. Database pool calls time out instead of waiting forever.
- Adds database migration 0025, the booking key column. It applies when the server starts. Older rows read the new column as empty, so no data reset is needed.
- Adds this changelog and `MAINTENANCE.md`. Adds the font license and the missing third-party notices.
- `package.json` now asks for Node.js 26 or later, as the README already did. v1.0.4's `package.json` allowed Node.js 24.
- Moves node-forge to 1.4.3. v1.0.4 used 1.4.0.
- The public copy no longer holds the early test projects from before the build.
- The iPhone app stays at version 1.0.1 (build 9). The web technician app gets the shared fixes now. The iPhone-only fixes wait for the next iPhone build.

## v1.0.4 - Nov 26, 2026

- Adds the phase 9 closing fixes and a board change.
- Adds a code cleanup.
- Moves Next.js to 16.4.6. v1.0.3 used 16.4.2.
- The iPhone app stays at version 1.0.1 (build 9). No call or answer shape that app uses changed.

## v1.0.3 - Nov 20, 2026

- Released to the public repo and the hosted demo.
- Uses Next.js 16.4.2.

## v1.0.2 - Nov 17, 2026

- Released to the public repo and the hosted demo.
- The release records name no other changes for this version.

## v1.0.1 - Nov 16, 2026

- Adds the privacy policy and support pages.
- The iPhone app was submitted as version 1.0.1, build 9.

## v1.0.0 - Nov 15, 2026

- First public release.
- The map files, baked tracks, routing files and street list come from OpenStreetMap data. They are under the Open Database License 1.0. See `LICENSE-DATA.md`.
