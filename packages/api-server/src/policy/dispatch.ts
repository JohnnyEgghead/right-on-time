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
  api(assignJob, OFFICE), // Assign a job: an office write that sets its technician (CTL-OFC-02-09, -02-10, -18-02, -19-02)
  api(rescheduleJob, OFFICE), // Reschedule a job: an office write that moves its time (CTL-OFC-20-03, -19-02)
  api(cancelJob, OFFICE), // Cancel a job: an office write on 1 job (CTL-OFC-21-02, -19-02)
  api(editJob, OFFICE), // Edit a job's details: an office write on 1 job (CTL-OFC-23-04, -19-02)
  api(finishJobOffice, OFFICE), // Finish a job from the office: a write on 1 job (CTL-OFC-22-07, -19-02)
  api(createJob, OFFICE), // Create a job: an office write that adds 1 job (CTL-OFC-04-09)
  api(createBlock, OFFICE), // Create a block: an office write that adds time blocked on the board (CTL-OFC-31-05)
  api(moveBlock, OFFICE), // Move a block: an office write on 1 time block (CTL-OFC-02-33, -31-05, -19-02)
  api(deleteBlock, OFFICE), // Delete a block: an office write that removes 1 time block (CTL-OFC-33-02)
  api(boardDay, OFFICE), // Read the board for 1 day: the office board page (SCR-OFC-02, CTL-OFC-29-01, -31-01, -32-01)
  api(vanPositions, OFFICE), // Read the van positions for the board's map panel (SCR-OFC-02)
  api(suggestTechnicians, OFFICE), // Suggest technicians for a job: an office read (CTL-OFC-18-01, CTL-OFC-04-08)
  api(movePreview, OFFICE), // Preview the planned arrival if a job moves to another technician, on the board and in the job page's reassign dialog (CTL-OFC-02-21, CTL-OFC-18-04)
  page('SCR-OFC-02', '/office/board', OFFICE),
  page('SCR-OFC-34', '/office/board/week', OFFICE),
  api(boardWeek, OFFICE), // Read the week board: the office week page (CTL-OFC-34-02 to -34-09, -34-13, -34-14, -34-16, -34-18 to -34-20)
  // The job page (P4-JOB): its reads, its 2 small writes and the office text, in the contract order.
  api(jobDetail, OFFICE), // Read 1 job, also the prefill for correcting a finish (SCR-OFC-03, CTL-OFC-22-10 (correction mode prefill))
  api(partsList, roles('office', 'manager', 'technician')), // CTL-OFC-22-01, -22-02; the technician apps keep a copy (UD-35)
  api(services, PUBLIC), // List the services, public for the booking forms (CTL-OFC-23-01, CTL-OFC-04-03, CTL-CUS-01-03)
  api(officeAvailability, OFFICE), // Days and arrival windows with the state of each (open, full, ...), for the office's job forms (CTL-OFC-20-01, -20-02, CTL-OFC-04-06, -04-07)
  api(jobOnTheWay, OFFICE), // Read the van, minutes away and arrival time of a job On the way, for the job page's panel (CTL-OFC-03-25 to -03-29)
  api(inboxLink, OFFICE), // The customer's inbox link, shown on the job and customer pages (CTL-OFC-03-03, -06-02)
  api(addOfficeNote, OFFICE), // Add an office note to a job or a customer (CTL-OFC-36-02)
  api(addEquipment, OFFICE), // Add a piece of equipment to a customer (CTL-OFC-37-05 (add mode), CTL-OFC-06-17)
  api(editEquipment, OFFICE), // Edit a piece of equipment (CTL-OFC-37-05 (edit mode))
  api(sendOfficeText, OFFICE), // Send a text from the office: an office write (CTL-OFC-35-04, CTL-OFC-06-14 (FR-TEXT-20))
  page('SCR-OFC-30', '/office/jobs', OFFICE),
  api(jobsList, OFFICE), // Read the Jobs list: the office jobs page (CTL-OFC-30-01 to -30-07, -30-09, -30-10, -30-12, -30-16, -30-18 to -30-20)
  api(jobsExport, OFFICE), // Export the Jobs list as a file for the office (CTL-OFC-30-13)
  page('SCR-OFC-04', '/office/jobs/new', OFFICE),
  page('SCR-OFC-03', '/office/jobs/{jobNumber}', OFFICE),
  page('SCR-OFC-07', '/office/technicians', OFFICE),
  // P4-TECHNICIANS: the Technicians page's reads and writes (SCR-OFC-07, -41, -42).
  api(technicianList, OFFICE), // List the technicians, for the Technicians page (SCR-OFC-07, CTL-OFC-41-04, -41-05)
  api(checkTextValue, OFFICE), // Check a text value typed on the Technicians page (CTL-OFC-07-03, -07-04)
  api(editTechnician, OFFICE), // Edit a technician: an office write on 1 technician (CTL-OFC-07-05)
  api(addTechnician, OFFICE), // CTL-OFC-41-07, -41-08 (office staff invite technicians only through this call, FR-AUTH-12)
  api(addTimeOff, OFFICE), // Add time off for a technician (CTL-OFC-42-03)
  api(removeTimeOff, OFFICE), // Remove a technician's time off (CTL-OFC-07-20)
  page('SCR-OFC-08', '/office/messages', OFFICE),
  page('SCR-OFC-09', '/office/messages/call-list', OFFICE),
  // P4-MESSAGES: the Messages page's reads and writes. They are office calls, so they sit here with their pages, not in the text
  // area's file (which holds the customer's token page only: customers-no-account.test.ts).
  api(textLog, OFFICE), // Read the text log: the office Messages page (CTL-OFC-08-03 to -10)
  api(textDetail, OFFICE), // Read 1 text in detail: the office Messages page (CTL-OFC-08-12)
  api(tryTextNow, OFFICE), // Try sending a text now (CTL-OFC-08-17)
  api(addToCallList, OFFICE), // Put the customer of a failed or not sent text (retrying or given up) on today's call list (CTL-OFC-08-19)
  api(textLogExport, OFFICE), // Export the text log: the office Messages page file (CTL-OFC-08-20)
  api(callList, OFFICE), // Read the call list: the office call list page (SCR-OFC-09)
  api(recordCallOutcome, OFFICE), // Record the outcome of a call: an office write (CTL-OFC-09-04, -07, CTL-OFC-20-03)
  page('SCR-OFC-12', '/office/admin/windows', OFFICE),
  // P4-ADMIN-WINDOWS: the arrival windows page's read and 2 writes (SCR-OFC-12; SCR-OFC-24 is its dialog, on SCR-OFC-34 too).
  api(bookingSettings, OFFICE), // Read the booking settings, for the arrival windows page and the week board (CTL-OFC-12-01 to -12-03, -12-08, -12-11, -12-12, CTL-OFC-24-01)
  api(setDayMode, OFFICE), // Set a day's mode, 2-hour or 4-hour windows, from the arrival windows page or the week board (CTL-OFC-24-02)
  api(setWindowLimits, OFFICE), // Set the arrival window limits (CTL-OFC-12-06)
];
