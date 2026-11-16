// SPDX-License-Identifier: AGPL-3.0-or-later
export * from './errors.ts';
export * from './envelope.ts';
export * from './mount.ts';
export * from './paging.ts';
export * from './contract.ts';
export * from './export.ts';
export * from './diff.ts';
export * from './check.ts';
export * from './client.ts';
export { z } from 'zod';
export { allContracts, contractsByArea } from './contracts/index.ts';
export { myJob, storedFile, STORED_FILE_SIZES, STORED_FILE_TYPES, type MyJobAnswer } from './contracts/tech-job.ts';
export {
  ALERT_STATE_WORDS, alertEmailLink, alertItem, boardDelaySample, checkNow, DELAY_SAMPLE_HELD_MAX_MS, DELAY_SAMPLES_MAX, dismissAlert, healthz, officeAlerts, setAlertSwitch, setTextSimulator, SIMULATOR_N_MAX, systemHealth, TEXT_SIMULATOR_MODES,
} from './contracts/health.ts';
export { LIVE_MAP_ENDED_REASONS, liveMapData, liveMapEndedDetail, liveMapPreview } from './contracts/map.ts';
export { boardWeek } from './contracts/board-week.ts';
export { dayRoute, routeLeg, routeStep, STOP_STATES, techRoute } from './contracts/tech-route.ts';
export {
  bookingSummary, bookOnline, fewWindowsLeft, ONLINE_HORIZON_DAYS, onlineAvailability, PLACES_LEFT_THRESHOLD,
  type BookedAnswer, type BookingSummaryAnswer, type OnlineAvailabilityAnswer, type OnlineDay, type OnlineWindow,
} from './contracts/booking.ts';
export { AFTER_PERIOD, BEFORE_PERIOD, GOAL_NO_ONE_HOME, GOAL_ON_TIME, PILOT_FIRST_WEEK, PILOT_LAST_WHOLE_WEEK, reports, reportsExport } from './contracts/report.ts';
export {
  bookingSettings, capacityBelowDetail, DAY_REASON_MAX, setDayMode, setWindowLimits, settingsDay, SETTINGS_DAYS_MAX, WINDOW_LIMIT_MAX,
} from './contracts/windows.ts';
export {
  createCustomer, CUSTOMER_PAGE, customerDetail, editCustomer, searchCustomers, searchStreets, STREET_CAP,
} from './contracts/customers.ts';
export { JOB_STATUSES, JOB_TABS, jobsExport, jobsList, type JobTab } from './contracts/jobs-list.ts';
export { appInfo, enterAccessCode, samplePeople, saveMySettings, signIn, signInAs, signOut, techSignIns, whoAmI } from './contracts/auth.ts';
export {
  emailByLink, inviteUser, PASSWORD_MAX, PASSWORD_MIN, passwordLink, requestReset, RESET_REFUSALS, ROLE_AREAS, roleAccess, searchUsers, setPassword,
  setUserRole, turnUserOff, turnUserOn, USER_STATUSES, userChanges,
} from './contracts/auth.ts';
export { eventStreamRow, readClock } from './contracts/demo.ts';
export { inboxMessages, inboxReply, REPLY_MAX, reschedulePage, rescheduleVisit } from './contracts/inbox.ts';
export { clockPresets, jumpClock, pauseClock, PRESET_IDS, resetWorldRow, type PresetId } from './contracts/clock.ts';
export {
  BILLING_REASON_KINDS, billingExport, billingQueue, correctFinish, LEFT_HOW, markFixed, pbsInvoice, pbsInvoices, pbsMode, PRETEND_BILLING_MODES,
  queueItem, retryAll, retryNow, sendAgain, setPretendBillingMode,
} from './contracts/billing.ts';
export {
  assignJob, boardDay, boardJob, boardTiming, cancelJob, createBlock, createJob, deleteBlock, editJob, moveBlock, movePreview, overlapDetail, rescheduleJob, search, vanPositions, ROUTE_HAVE_MAX, ROUTE_KEY,
  SEARCH_GROUP_CAP, suggestTechnicians, versionConflictDetail,
  billingState, finishJobOffice, ruleRefusedDetail,
  writtenBlock, writtenJob, type BoardDayAnswer, type VanPositionsAnswer, type MovePreviewAnswer, type SuggestedTechniciansAnswer, type VersionConflictDetail,
} from './contracts/dispatch.ts';
export {
  decidePair, importRun, importRuns, likelyDuplicates, merges, PROBLEM_LIST_COLUMNS, PROBLEM_REASON_KEYS, problemList, startDryRun,
  startRealRun, undoMerge,
} from './contracts/import.ts';
export {
  alreadyHandledDetail, finishPayload, itemAnswer, itemKey, itemTime, markHandled, MAX_ITEMS_PER_BATCH, NOTE_MAX_CHARS, PHOTO_MAX_BYTES,
  PRODUCT_NAME, PRODUCT_VERSION, queuedItem, reportSync, sendItems, sentItem, serverInfo, SIGNATURE_MAX_BYTES, todayJobs, uploadBlob, type TodayAnswer, type TodayJob,
} from './contracts/tech.ts';
export {
  addEquipment, addOfficeNote, editEquipment, equipmentItem, inboxLink, jobDetail, jobOnTheWay, messageTooLongDetail, OFFICE_NOTE_MAX, OFFICE_TEXT_MAX_WIRE,
  officeAvailability, partsList, sendOfficeText, services,
  type AvailabilityAnswer, type JobDetailAnswer, type OnTheWayAnswer, type PartsAnswer, type ServicesAnswer,
} from './contracts/job-page.ts';
export {
  addToCallList, CALL_OUTCOMES, CALL_REASONS, callList, FAILED_TEXT_REASONS, recordCallOutcome, REPLY_HANDLINGS, SIMULATOR_MODE_NAMES,
  TEXT_LOG_STATUSES, TEXT_LOG_TYPES, textDetail, textLog, textLogExport, tryTextNow,
} from './contracts/text.ts';
export {
  addTechnician, addTimeOff, checkTextValue, editTechnician, NAME_IN_TEXTS_PROBLEMS, removeTimeOff, SATURDAY_PATTERNS, TECHNICIAN_SKILLS, technicianList,
  textValueDetail, timeOffRefusedDetail, workingHours,
  type TechnicianListAnswer, type TechnicianRow, type TextCheckAnswer, type TimeOffAnswer,
} from './contracts/technicians.ts';
export * from './event-hub.ts';
export * from './event-stream.ts';
export * from './resource-cache.ts';
