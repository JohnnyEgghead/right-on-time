// SPDX-License-Identifier: AGPL-3.0-or-later
// CTL-OFC-16-23 and CTL-OFC-28-04, "Open the email": the 1 click path of a manager's copy of an alert email. A read only says a copy waits;
// the click asks API-174 for this manager's fresh one-time link and opens it, so no view can retire a link another view is showing (F-660).
import { createReader, type Reader } from './reads.ts';

/**
 * The tab opens before the answer, inside the click: a browser blocks a window opened after a wait. With no answer it closes again and
 * `refused` runs (the copy was opened elsewhere: the screen re-reads and shows it used). A blocked tab falls back to this tab.
 */
export async function openAlertEmail(alertId: string, refused: () => void, reader: Reader = createReader({ baseUrl: window.location.origin })): Promise<void> {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  const r = await reader.read<{ link: string }>('API-174', { alertId });
  if (!r.ok) {
    tab?.close();
    refused();
    return;
  }
  if (tab) tab.location.href = r.data.link;
  else window.location.assign(r.data.link);
}
