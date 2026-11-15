// SPDX-License-Identifier: AGPL-3.0-or-later
// Every contract row, 1 file per module area. A new area adds 1 file and 1 line here.
import type { ContractRow } from '../contract.ts';
import { authContracts } from './auth.ts';
import { billingContracts } from './billing.ts';
import { boardWeekContracts } from './board-week.ts';
import { bookingContracts } from './booking.ts';
import { customersContracts } from './customers.ts';
import { demoContracts } from './demo.ts';
import { dispatchContracts } from './dispatch.ts';
import { jobPageContracts } from './job-page.ts';
import { healthContracts } from './health.ts';
import { importContracts } from './import.ts';
import { inboxContracts } from './inbox.ts';
import { jobsListContracts } from './jobs-list.ts';
import { mapContracts } from './map.ts';
import { reportContracts } from './report.ts';
import { techContracts } from './tech.ts';
import { techJobContracts } from './tech-job.ts';
import { techRouteContracts } from './tech-route.ts';
import { techniciansContracts } from './technicians.ts';
import { messagesContracts, textContracts } from './text.ts';
import { windowsContracts } from './windows.ts';

export const contractsByArea = {
  auth: authContracts,
  billing: billingContracts,
  booking: bookingContracts,
  customers: customersContracts,
  demo: demoContracts,
  dispatch: [...dispatchContracts, ...boardWeekContracts, ...jobPageContracts, ...jobsListContracts, ...techniciansContracts, ...messagesContracts, ...windowsContracts], // the arrival windows rows (P4-ADMIN-WINDOWS), API-132 (P4-WEEK), the job page (P4-JOB), API-133 and API-134 (P4-JOBS) and the Messages rows (P4-MESSAGES) join the dispatch area, in policy order
  health: healthContracts,
  import: importContracts,
  map: mapContracts,
  report: reportContracts,
  // the job screens' reads (P5-TWA-JOB), then the Map, Directions and Me reads (P5-TWA-MAP-ME) join the tech area, in policy order
  tech: [...techContracts, ...techJobContracts, ...techRouteContracts],
  text: [...textContracts, ...inboxContracts], // the customer inbox and reschedule page rows (P5-INBOX) join the text area
} satisfies Record<string, ContractRow[]>;

export const allContracts: ContractRow[] = Object.values(contractsByArea).flat();
