// SPDX-License-Identifier: AGPL-3.0-or-later
// @bw/outbox (SPECIFICATIONS section 5.2 steps 1 to 5, SD-18; section 4.4, SD-48; section 6.4): the only way a text is
// created (enqueueText) and the only way one leaves (the worker's try handler through the text gateway). Pure rules
// (quiet hours, the try schedule, the simulator's verdict) and the in-transaction services the web handlers call
// (Try now, reply intake, cancel at arrival).
export { parseReminderCallId, REMINDER_CALL_REASONS, reminderCallId, upsertReminderCall, type ReminderCallReason } from './call-list.ts';
export { cancelOnTheWayText, cancelUnsentConfirmations, cancelUnsentReminders } from './cancel.ts';
export { enqueueText, type EnqueueInput, type EnqueueResult } from './enqueue.ts';
export { scheduleEvent, scheduleTry } from './events.ts';
export {
  SIMULATOR_MODES, SIMULATOR_REASON, SimulatorGateway, simulatorVerdict, textGatewayFrom,
  type GatewayFactory, type SimulatorMode, type SimulatorRow, type TextGateway,
} from './gateway.ts';
export {
  instantOf, isQuietHoursExempt, MAX_TRIES, QUIET_END, QUIET_HOURS_EXEMPT_KINDS, QUIET_START, REASON, SENDABLE, TEXT_KINDS, TEXT_STATUSES, TEXT_TRY, TRY_OFFSETS_MINUTES,
  TEMPLATE_IDS, TEMPLATE_KINDS, TEMPLATE_VARIANTS, type TemplateId, type TemplateKind, type TextKind, type TextStatus, type TextTryPayload,
} from './model.ts';
export { publish, publishTextChanged, textChangedIds, type OutboxEventName, type TextChangedIds } from './notify.ts';
export { inQuietHours, plannedTries, plannedTryAt, releaseTime } from './quiet-hours.ts';
export { catalogTexts, countBody, renderTemplate, TemplateRenderError, type CountedBody, type TextCatalog, type TextLanguage } from './render.ts';
export { handleReply, newToken, replyTarget, type ReplyHandling, type ReplyInput, type ReplyResult, type VisitDayLabels } from './reply.ts';
export { checkNameInTexts, NAME_IN_TEXTS_MAX, type NameCheck, type NameProblem } from './name-in-texts.ts';
export {
  arrivalLabel, dateLabel, foreignHosts, serviceLabel, textCatalogOf, textLink, visitDayLabels, weekdayLabel, windowLabel, windowLabelOf, windowLabelZoned,
  type LinkKind, type TextCatalogs,
} from './slots.ts';
export {
  customerZoneFor, fireReminder, giveUpReminder, planReminder, reminderBodyAt, reminderDueAt, reminderIsStale, reminderTemplateAt, REMINDER_TIME, replanCustomerReminders,
  ReminderNotEnqueuedError, sendConfirmation, sendLate, sendOnTheWay, TEXT_REMINDER,
  type LateSent, type OnTheWaySent, type ReminderFired, type ReminderPlan, type TextContext,
} from './triggers.ts';
export { tryNow, type TryNowResult } from './try-now.ts';
