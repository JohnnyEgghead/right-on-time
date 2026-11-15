// SPDX-License-Identifier: AGPL-3.0-or-later
// Policy of the dispatch area: the top-bar search, the office writes and the office pages (UI-SPECIFICATION 2.4:
// managers and office staff; the writes' callers are the board, job and new-job screens, all office screens).
import {
  addToCallList, assignJob, boardDay, boardWeek, callList, cancelJob, createBlock, createJob, deleteBlock, editJob, finishJobOffice, jobsExport, jobsList, moveBlock,
  movePreview, recordCallOutcome, rescheduleJob, search, suggestTechnicians, vanPositions, textDetail, textLog, textLogExport, tryTextNow,
} from '@bw/api';
import { addTechnician, addTimeOff, checkTextValue, editTechnician, removeTimeOff, technicianList } from '@bw/api';
import {
  addEquipment, addOfficeNote, bookingSettings, editEquipment, inboxLink, jobDetail, jobOnTheWay, officeAvailability, partsList, sendOfficeText, services, setDayMode, setWindowLimits,
} from '@bw/api';
import type { PolicyEntry } from '../types.ts';
import { api, OFFICE, page, PUBLIC, roles } from './entry.ts';

export const dispatchPolicy: PolicyEntry[] = [
  api(search, OFFICE),
  api(assignJob, OFFICE), // CTL-OFC-02-09, -02-10, -18-02, -19-02
  api(rescheduleJob, OFFICE), // CTL-OFC-20-03, -19-02
  api(cancelJob, OFFICE), // CTL-OFC-21-02, -19-02
  api(editJob, OFFICE), // CTL-OFC-23-04, -19-02
  api(finishJobOffice, OFFICE), // CTL-OFC-22-07, -19-02 (P4-JOB)
  api(createJob, OFFICE), // CTL-OFC-04-09
  api(createBlock, OFFICE), // CTL-OFC-31-05
  api(moveBlock, OFFICE), // CTL-OFC-02-33, -31-05, -19-02
  api(deleteBlock, OFFICE), // CTL-OFC-33-02
  api(boardDay, OFFICE), // SCR-OFC-02 (P4-BOARD), CTL-OFC-29-01, -31-01, -32-01
  api(vanPositions, OFFICE), // SCR-OFC-02's map panel (P4-BOARD-MAP)
  api(suggestTechnicians, OFFICE), // CTL-OFC-18-01, CTL-OFC-04-08
  api(movePreview, OFFICE), // CTL-OFC-02-21, CTL-OFC-18-04
  page('SCR-OFC-02', '/office/board', OFFICE),
  page('SCR-OFC-34', '/office/board/week', OFFICE),
  api(boardWeek, OFFICE), // CTL-OFC-34-02 to -34-09, -34-13, -34-14, -34-16, -34-18 to -34-20
  // The job page (P4-JOB): its reads, its 2 small writes and the office text, in the contract order.
  api(jobDetail, OFFICE), // SCR-OFC-03, CTL-OFC-22-10 (correction mode prefill)
  api(partsList, roles('office', 'manager', 'technician')), // CTL-OFC-22-01, -22-02; the technician apps keep a copy (UD-35)
  api(services, PUBLIC), // CTL-OFC-23-01, CTL-OFC-04-03, CTL-CUS-01-03
  api(officeAvailability, OFFICE), // CTL-OFC-20-01, -20-02, CTL-OFC-04-06, -04-07
  api(jobOnTheWay, OFFICE), // CTL-OFC-03-25 to -03-29
  api(inboxLink, OFFICE), // CTL-OFC-03-03, -06-02
  api(addOfficeNote, OFFICE), // CTL-OFC-36-02
  api(addEquipment, OFFICE), // CTL-OFC-37-05 (add mode), CTL-OFC-06-17
  api(editEquipment, OFFICE), // CTL-OFC-37-05 (edit mode)
  api(sendOfficeText, OFFICE), // CTL-OFC-35-04, CTL-OFC-06-14 (FR-TEXT-20)
  page('SCR-OFC-30', '/office/jobs', OFFICE),
  api(jobsList, OFFICE), // CTL-OFC-30-01 to -30-07, -30-09, -30-10, -30-12, -30-16, -30-18 to -30-20
  api(jobsExport, OFFICE), // CTL-OFC-30-13
  page('SCR-OFC-04', '/office/jobs/new', OFFICE),
  page('SCR-OFC-03', '/office/jobs/{jobNumber}', OFFICE),
  page('SCR-OFC-07', '/office/technicians', OFFICE),
  // P4-TECHNICIANS: the Technicians page's reads and writes (SCR-OFC-07, -41, -42).
  api(technicianList, OFFICE), // SCR-OFC-07, CTL-OFC-41-04, -41-05
  api(checkTextValue, OFFICE), // CTL-OFC-07-03, -07-04
  api(editTechnician, OFFICE), // CTL-OFC-07-05
  api(addTechnician, OFFICE), // CTL-OFC-41-07, -41-08 (office staff invite technicians only through this call, FR-AUTH-12)
  api(addTimeOff, OFFICE), // CTL-OFC-42-03
  api(removeTimeOff, OFFICE), // CTL-OFC-07-20
  page('SCR-OFC-08', '/office/messages', OFFICE),
  page('SCR-OFC-09', '/office/messages/call-list', OFFICE),
  // P4-MESSAGES: the Messages page's reads and writes. They are office calls, so they sit here with their pages, not in the text
  // area's file (which holds the customer's token page only: customers-no-account.test.ts).
  api(textLog, OFFICE), // CTL-OFC-08-03 to -10
  api(textDetail, OFFICE), // CTL-OFC-08-12
  api(tryTextNow, OFFICE), // CTL-OFC-08-17
  api(addToCallList, OFFICE), // CTL-OFC-08-19
  api(textLogExport, OFFICE), // CTL-OFC-08-20
  api(callList, OFFICE), // SCR-OFC-09
  api(recordCallOutcome, OFFICE), // CTL-OFC-09-04, -07, CTL-OFC-20-03
  page('SCR-OFC-12', '/office/admin/windows', OFFICE),
  // P4-ADMIN-WINDOWS: the arrival windows page's read and 2 writes (SCR-OFC-12; SCR-OFC-24 is its dialog, on SCR-OFC-34 too).
  api(bookingSettings, OFFICE), // CTL-OFC-12-01 to -12-03, -12-08, -12-11, -12-12, CTL-OFC-24-01
  api(setDayMode, OFFICE), // CTL-OFC-24-02
  api(setWindowLimits, OFFICE), // CTL-OFC-12-06
];
