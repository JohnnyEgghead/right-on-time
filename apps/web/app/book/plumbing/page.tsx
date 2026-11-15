// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-CUS-07 Booking site page at /book/plumbing (UI-SPECIFICATION 2.3). Any other /book/ page name is refused by the page gate as not found,
// which SharedPages.tsx shows under the booking site header (DK-133).
import { MenuPage } from '../../../src/bookmenu/MenuPage.tsx';
import { MENU_PAGES } from '../../../src/bookmenu/model.ts';

export const dynamic = 'force-dynamic';

export default function BookMenuPage() {
  return <MenuPage page={MENU_PAGES['plumbing']} />;
}
