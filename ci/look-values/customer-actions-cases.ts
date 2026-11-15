// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P4-CUSTOMER-ACTIONS (BUILD_PLAN P4-CUSTOMER-ACTIONS Acceptance, look clause): SCR-OFC-35 Text customer, SCR-OFC-36 Add
// note and SCR-OFC-37 Add or edit equipment, hosted by the customer page (SCR-OFC-06), against DK-87 (mockups/pages/office-job.html) in each
// state its frames show for them. The frame is picked by its frozen caption (UI-DESIGN-KIT 4.1), as job-cases.ts does; the app states are the
// harness build's /shell-preview/customer/<state> routes (apps/web/src/customers/customer-previews.tsx), each on Harold Jenkins. The page
// itself (SCR-OFC-06, SCR-OFC-05 with CTL-OFC-05-15) is customers-cases.ts's; the same dialogs on the job page are job-cases.ts's.
import { DLG, EQ, inTile, NT, TX, TXT, type JobCase } from './job-cases.ts';

const app = (state: string) => ({ app: `/shell-preview/customer/${state}` });
const FIELD = ['.r1-field', '.r1-field label'];
const EQF = [...FIELD, '.r1-input', '.g2f'];

export const CUSTOMER_ACTION_CASES: JobCase[] = [
  inTile('text-empty', `${TX}Empty`, [...DLG, ...TXT], '.r1-dlg', app('text-empty')),
  inTile('text-typing', `${TX}Typing`, [...DLG, ...TXT], '.r1-dlg', app('text-typing')),
  inTile('text-too-long', `${TX}Too long`, [...DLG, ...TXT], '.r1-dlg', app('text-too-long')),
  inTile('text-sending', `${TX}Sending`, [...DLG, ...TXT, '.r1-spin'], '.r1-dlg', app('text-sending')),
  inTile('text-refused', `${TX}Refused`, [...DLG, ...TXT, '.r1-fmsg'], '.r1-dlg', app('text-refused')),
  inTile('note-empty', `${NT}Empty`, [...DLG, ...FIELD, '.r1-hint'], '.r1-dlg', app('note-empty')),
  inTile('note-typing', `${NT}Typing`, [...DLG, ...FIELD, '.r1-hint'], '.r1-dlg', app('note-typing')),
  inTile('note-saving', `${NT}Saving`, [...DLG, ...FIELD, '.r1-hint', '.r1-spin'], '.r1-dlg', app('note-saving')),
  inTile('equipment-adding', `${EQ}Adding`, [...DLG, ...EQF], '.r1-dlg', app('equipment-adding')),
  inTile('equipment-editing', `${EQ}Editing`, [...DLG, ...EQF], '.r1-dlg', app('equipment-editing')),
  inTile('equipment-saving', `${EQ}Saving`, [...DLG, ...EQF, '.r1-spin'], '.r1-dlg', app('equipment-saving')),
];

/**
 * Captioned states of the 3 dialogs with no look case here, each with the reason. The coverage test checks that every caption of the 3
 * screens on the frame is compared by a case here or named here, and that each named one is a caption.
 */
const TOAST = 'a CMP-11 toast: its look is the shell\'s and job-cases.ts\'s toast case (the same ToastView); the customer page announces it through the same component';
export const NOT_COMPARED: Record<string, string> = {
  [`${TX}Sent`]: `the text was sent: ${TOAST}`,
  [`${TX}Held`]: `the text was held to 8:00 AM: ${TOAST}`,
  [`${NT}Saved`]: `the note was saved: ${TOAST}; the customer page words it "Note added." (DK-91 Changed), which that frame holds as a tile of the page (customers-cases.ts)`,
  [`${EQ}Saved`]: `the equipment was saved: ${TOAST}`,
};

const OWN = /^(SCR-OFC-35|SCR-OFC-36|SCR-OFC-37) /;

/** Captions of the 3 screens the frame shows that no case here and no NOT_COMPARED row covers; and NOT_COMPARED rows that are wrong. */
export function uncoveredCustomerActions(captions: readonly string[]): string[] {
  const compared = new Set(CUSTOMER_ACTION_CASES.flatMap((c) => c.captions));
  const problems: string[] = [];
  for (const c of captions) if (OWN.test(c) && !compared.has(c) && !NOT_COMPARED[c]) problems.push(`no case compares ${c}`);
  for (const c of Object.keys(NOT_COMPARED)) if (!captions.includes(c)) problems.push(`NOT_COMPARED names a caption the frame does not show: ${c}`);
  return problems;
}
