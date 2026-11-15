// SPDX-License-Identifier: AGPL-3.0-or-later
// Every handler, keyed by its contract id. mount refuses a key with no policy entry and an entry with no key here.
import type { Handler } from '../types.ts';
import { appInfoHandler, enterAccessCodeHandler, samplePeopleHandler, signInAsHandler, signInHandler, signOutHandler, techSignInsHandler } from './auth.ts';
import {
  emailByLinkHandler, inviteUserHandler, passwordLinkHandler, requestResetHandler, roleAccessHandler, searchUsersHandler, setPasswordHandler,
  setUserRoleHandler, turnUserOffHandler, turnUserOnHandler, userChangesHandler, accountTokenChecks,
} from './accounts.ts';
import { billingHandlers } from './billing.ts';
import { billingReadHandlers } from './billing-reads.ts';
import { boardWeekHandler } from './board-week.ts';
import { boardDayHandler, movePreviewHandler, suggestTechniciansHandler } from './board.ts';
import { readClockHandler } from './clock.ts';
import { bookingSummaryHandler, bookOnlineHandler, onlineAvailabilityHandler } from './booking.ts';
import { createCustomerHandler, customerDetailHandler, editCustomerHandler, searchCustomersHandler, searchStreetsHandler } from './customers.ts';
import { clockPresetsHandler, jumpClockHandler, pauseClockHandler, resetWorldHandler } from './clock-moves.ts';
import {
  assignJobHandler, cancelJobHandler, createBlockHandler, createJobHandler, deleteBlockHandler, editJobHandler, moveBlockHandler, rescheduleJobHandler,
} from './dispatch-writes.ts';
import { eventStreamHandler } from '../events/stream.ts';
import { boardDelaySampleHandler, health } from './health.ts';
import { healthHandlers } from './health-page.ts';
import {
  decidePairHandler, importRunHandler, importRunsHandler, likelyDuplicatesHandler, mergesHandler, problemListHandler,
  startDryRunHandler, startRealRunHandler, undoMergeHandler,
} from './import.ts';
import { inboxHandlers, inboxTokenChecks } from './inbox.ts';
import { jobPageHandlers } from './job-page.ts';
import { liveMapDataHandler, liveMapPreviewHandler, liveMapTokenCheck } from './live-map.ts';
import { jobsExportHandler, jobsListHandler } from './jobs-list.ts';
import { saveMySettingsHandler, whoAmIHandler } from './me.ts';
import { messagesHandlers } from './messages.ts';
import { reportsExportHandler, reportsHandler } from './reports.ts';
import { searchHandler } from './search.ts';
import { serverInfoHandler } from './server-info.ts';
import { techItemHandlers } from './techItems.ts';
import { techJobHandlers } from './tech-job.ts';
import { todayJobsHandler } from './tech-today.ts';
import { dayRouteHandler, techRouteHandler } from './tech-route.ts';
import { vanPositionsHandler } from './vans.ts';
import { bookingSettingsHandler, setDayModeHandler, setWindowLimitsHandler } from './windows.ts';
import {
  addTechnicianHandler, addTimeOffHandler, checkTextValueHandler, editTechnicianHandler, removeTimeOffHandler, technicianListHandler,
} from './technicians.ts';

const baseHandlers: Readonly<Record<string, Handler<unknown>>> = Object.freeze({
  'API-01': enterAccessCodeHandler as Handler<unknown>,
  'API-02': appInfoHandler as Handler<unknown>,
  'API-03': signInHandler as Handler<unknown>,
  'API-04': samplePeopleHandler as Handler<unknown>,
  'API-05': signInAsHandler as Handler<unknown>,
  'API-06': signOutHandler as Handler<unknown>,
  'API-07': whoAmIHandler as Handler<unknown>,
  'API-08': saveMySettingsHandler as Handler<unknown>,
  'API-09': eventStreamHandler() as Handler<unknown>,
  'API-10': readClockHandler as Handler<unknown>,
  'API-105': serverInfoHandler as Handler<unknown>,
  'API-11': clockPresetsHandler as Handler<unknown>,
  'API-12': jumpClockHandler as Handler<unknown>,
  'API-13': pauseClockHandler as Handler<unknown>,
  'API-14': resetWorldHandler as Handler<unknown>,
  'API-20': boardDayHandler as Handler<unknown>,
  'API-21': vanPositionsHandler as Handler<unknown>,
  'API-22': assignJobHandler as Handler<unknown>,
  'API-24': rescheduleJobHandler as Handler<unknown>,
  'API-25': cancelJobHandler as Handler<unknown>,
  'API-27': editJobHandler as Handler<unknown>,
  'API-28': createJobHandler as Handler<unknown>,
  'API-30': suggestTechniciansHandler as Handler<unknown>,
  'API-31': technicianListHandler as Handler<unknown>,
  'API-32': checkTextValueHandler as Handler<unknown>,
  'API-33': editTechnicianHandler as Handler<unknown>,
  'API-34': searchCustomersHandler as Handler<unknown>,
  'API-35': customerDetailHandler as Handler<unknown>,
  'API-36': editCustomerHandler as Handler<unknown>,
  'API-50': reportsHandler as Handler<unknown>,
  'API-51': reportsExportHandler as Handler<unknown>,
  'API-100': todayJobsHandler as Handler<unknown>,
  'API-80': startDryRunHandler as Handler<unknown>,
  'API-81': importRunHandler as Handler<unknown>,
  'API-82': importRunsHandler as Handler<unknown>,
  'API-83': problemListHandler as Handler<unknown>,
  'API-84': startRealRunHandler as Handler<unknown>,
  'API-85': likelyDuplicatesHandler as Handler<unknown>,
  'API-86': decidePairHandler as Handler<unknown>,
  'API-87': mergesHandler as Handler<unknown>,
  'API-88': undoMergeHandler as Handler<unknown>,
  'API-90': bookingSettingsHandler as Handler<unknown>,
  'API-91': setDayModeHandler as Handler<unknown>,
  'API-155': setWindowLimitsHandler as Handler<unknown>,
  'API-15': techSignInsHandler as Handler<unknown>,
  'API-111': searchStreetsHandler as Handler<unknown>,
  'API-112': onlineAvailabilityHandler as Handler<unknown>,
  'API-113': bookOnlineHandler as Handler<unknown>,
  'API-114': bookingSummaryHandler as Handler<unknown>,
  'API-130': searchHandler as Handler<unknown>,
  'API-132': boardWeekHandler as Handler<unknown>,
  'API-133': jobsListHandler as Handler<unknown>,
  'API-134': jobsExportHandler as Handler<unknown>,
  'API-131': movePreviewHandler as Handler<unknown>,
  'API-136': createBlockHandler as Handler<unknown>,
  'API-137': moveBlockHandler as Handler<unknown>,
  'API-138': deleteBlockHandler as Handler<unknown>,
  'API-139': createCustomerHandler as Handler<unknown>,
  'API-149': searchUsersHandler as Handler<unknown>,
  'API-147': addTechnicianHandler as Handler<unknown>,
  'API-148': addTimeOffHandler as Handler<unknown>,
  'API-150': inviteUserHandler as Handler<unknown>,
  'API-151': setUserRoleHandler as Handler<unknown>,
  'API-152': turnUserOffHandler as Handler<unknown>,
  'API-153': roleAccessHandler as Handler<unknown>,
  'API-154': userChangesHandler as Handler<unknown>,
  'API-165': requestResetHandler as Handler<unknown>,
  'API-166': emailByLinkHandler as Handler<unknown>,
  'API-167': passwordLinkHandler as Handler<unknown>,
  'API-168': setPasswordHandler as Handler<unknown>,
  'API-169': removeTimeOffHandler as Handler<unknown>,
  'API-170': turnUserOnHandler as Handler<unknown>,
  'API-171': health as Handler<unknown>,
  'API-172': boardDelaySampleHandler as Handler<unknown>,
  'API-116': liveMapDataHandler as Handler<unknown>,
  'API-164': liveMapPreviewHandler as Handler<unknown>,
  'API-104': techRouteHandler as Handler<unknown>,
  'API-163': dayRouteHandler as Handler<unknown>,
});

/** The link-token checks of every token kind the table uses (mount.ts refuses a token entry with none). */
export const tokenChecks = Object.freeze({ ...accountTokenChecks, ...inboxTokenChecks, live_map: liveMapTokenCheck });

export const handlers: Readonly<Record<string, Handler<unknown>>> = Object.freeze({ ...baseHandlers, ...techItemHandlers(), ...techJobHandlers, ...billingHandlers(), ...billingReadHandlers(), ...healthHandlers(), ...messagesHandlers(), ...jobPageHandlers, ...inboxHandlers() });
