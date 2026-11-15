// SPDX-License-Identifier: AGPL-3.0-or-later
// Every /tech page of the web technician app (SURF-TWA): its web app manifest (SD-47; NFR-09, installed from the browser),
// served by the web process at /tech/manifest.webmanifest (src/tech/shell-assets.ts), and the owed sign-out (F-1004, src/tech/SignOutGate.tsx):
// after a Sign out with no signal, no /tech page shows the person until API-06 has answered.
import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { TECH_MANIFEST, TECH_MANIFEST_PATH, techIconPath } from '../../src/tech/shell-assets.ts';
import { SIGN_OUT_OWED_COOKIE } from '../../src/tech/session.ts';
import { SignOutGate } from '../../src/tech/SignOutGate.tsx';

// F-1231: the Home Screen title of the web clip (iOS Safari reads this meta first); the iPhone app keeps Right On Time.
export const metadata: Metadata = {
  manifest: TECH_MANIFEST_PATH,
  appleWebApp: { title: TECH_MANIFEST.short_name },
  icons: { apple: [{ url: techIconPath(180), sizes: '180x180', type: 'image/png' }] },
};
export const viewport: Viewport = { themeColor: TECH_MANIFEST.theme_color };

// F-1014: the owed mark is also a cookie (session.ts), so the server renders the frame a page will stand in: the page itself with no mark,
// the owed frame with one. No page is blank before hydration, and one whose script fails to load still shows its frame.
export default async function TechLayout({ children }: { children: ReactNode }) {
  const owed = (await cookies()).has(SIGN_OUT_OWED_COOKIE);
  return <SignOutGate owed={owed}>{children}</SignOutGate>;
}
