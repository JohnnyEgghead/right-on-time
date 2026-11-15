<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Privacy policy: Right On Time

Last updated: Nov 15, 2026.

Right On Time is a free, open-source app for field technicians. This policy says what the iPhone app and the public sample site it connects to do with data. It states only what the code does. The code is public in this repository, so you can check each statement.

## The short version

- The app has no advertising, no tracking and no analytics.
- Everything on the sample site is made-up sample data for a fictional company named Brightwater. The site resets every night.
- The app does not read your location.
- Nothing is sold or shared with anyone.

## What the app stores on your iPhone

- Your sign-in session, in the iPhone Keychain, as an item that stays on that phone.
- The notes, photos and status changes you make while there is no signal, kept in the app's own files until they are sent. A list in the app shows what is waiting.
- Your settings: the Notifications switch and the text size. They stay on the phone.
- The language you pick. When you are signed in it is also saved to your profile on the server (see below); when you are signed out it stays on the phone.

Deleting the app removes the files it made. Signing out removes the session.

## What the app sends

The app talks to one server and nothing else. By default that is the sample site at https://bw.j7l.io. It sends:

- Your sign-in (an email address or employee number and a password) when you sign in.
- Job status changes, notes, work-done lines, signatures and clock in or out, when you make them.
- The language you pick, when you change it while signed in. It is saved to your profile so the app and the site show that language.
- Photos you choose or take for a job. The app asks for the camera or photo library only when you tap to add a photo. The app re-encodes each photo as a JPEG before it is sent, and it does not ask the picker for the photo's location data.
- A photo the phone cannot convert to a JPEG is sent as it was picked, marked so the office can see it. That file is sent unchanged, so it still holds any details stored inside the file itself, which can include where the photo was taken.

The app has no analytics, advertising or crash-reporting library, and it sends nothing to any other company. The map files come from the same server.

## Location

The app does not ask for your location and does not read it. The only way a place can reach the server is inside a photo file the phone could not convert, as described above. The map shows the service area; it does not show where you are.

## What the sample site keeps

- The sample company's data: customers, jobs, notes and photos. All of it is made up. If you add a note or a photo, it is stored there too, so do not enter real personal information.
- Your session, stored only as a one-way hash of its token, never the token.
- A web server log of each request: the time, the method, the page, the status, the size and the duration. It holds no IP address and no sign-in.
- The sample site sends no real text messages or email. Texts and email in it are shown on screen only.

## The nightly reset and backups

- The sample site resets itself to its starting state every night at 3:00 AM Eastern, and after 120 minutes with no change. A reset removes what visitors added: notes, photos and changes.
- A backup of the site's database is copied every night at 2:30 AM Eastern to private storage with the hosting provider, in the same region as the server. Backups older than 14 days are deleted. A backup can hold what a visitor added before that night's reset.
- Backups are used only to restore the site. They are not read for any other purpose.

## Other servers

You can point the app at another Right On Time server, for example one on your own network. That server's operator, not this policy, decides what it keeps.

## Children

The app is a work tool for technicians. It is not made for children.

## Changes and questions

If this policy changes, this file changes in the repository and the date above changes with it. To ask a question or ask for a correction, open an issue at https://github.com/JohnnyEgghead/right-on-time/issues. Please do not put personal information in an issue.
