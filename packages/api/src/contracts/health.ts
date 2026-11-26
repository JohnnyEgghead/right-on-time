// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract rows of the health area. API-171 is the sample contract of P2-API-CORE: the one route the Compose stack
// serves today (GET /healthz, SPECIFICATIONS 7.4). A later lane adds its own API-<nn> rows to its area file.
import { z } from 'zod';
import { defineContract, type ContractRow } from '../contract.ts';
import { localDate } from './shapes.ts';

export const healthz = defineContract({
  id: 'API-171',
  name: 'Health check',
  method: 'GET',
  path: '/healthz', // origin root, outside the API base (mount.ts ROOT_CONTRACTS)
  request: z.object({}),
  response: z.object({ status: z.literal('ok') }),
  successStatus: [200],
  errors: [],
  labels: [],
  envelope: false, // OI-46: the 7.4 row governs over the 7.2 envelope; the answer is the plain {status: "ok"}
  examples: [{ name: 'database answers', expectStatus: 200 }],
});

/** SD-43 (F-885): a board tab sends at most this many held samples in 1 request. */
export const DELAY_SAMPLES_MAX = 50;
/** SD-43: a sample's heldMs, the whole milliseconds from the finished re-read to the send, is 0 to this. */
export const DELAY_SAMPLE_HELD_MAX_MS = 60_000;
const delaySeq = z.number().int().positive();

/**
 * API-172 (SPECIFICATIONS 7.4, SD-43): a board tab sends the samples it held, each the seq of an event whose re-read it finished
 * and the milliseconds it held it; the server stores ms = receive time minus the seq's emit time minus heldMs, floored at 0. No UI
 * control; answers 204 even for a seq it no longer holds. The old body, seq alone, stays accepted as 1 sample with heldMs 0 (F-885).
 */
export const boardDelaySample = defineContract({
  id: 'API-172',
  name: 'Board delay sample',
  method: 'POST',
  path: '/board-delay-samples',
  request: z.object({
    samples: z.array(z.object({ seq: delaySeq, heldMs: z.number().int().min(0).max(DELAY_SAMPLE_HELD_MAX_MS) })).min(1).max(DELAY_SAMPLES_MAX).optional(),
    seq: delaySeq.optional(),
  }).refine((v) => v.samples !== undefined || v.seq !== undefined, { message: 'samples or seq' }),
  response: z.object({}),
  successStatus: [204],
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { seq: 1 }, expectStatus: 401 }],
});

// P4-HEALTH: the System health page's rows (SCR-OFC-16) and the office alerts the bell opens (SCR-OFC-28). Times are wire times
// (a zone-stamped instant): demo time in the branch zone, or, where the row says real time, the real time in America/New_York.
const wireTime = z.string().min(1);
const count = z.number().int().min(0);
const branchParam = z.string().min(1).max(40);
const dateParam = localDate;
const alertTypeParam = z.string().min(1).max(40);

export const TEXT_SIMULATOR_MODES = ['up', 'all_fail', 'fail_customer', 'fail_next_n'] as const;
export const ALERT_STATE_WORDS = ['open', 'resolved', 'info'] as const;
/** SD-44: N for Fail the next N sends is a whole number from 1 to 20. */
export const SIMULATOR_N_MAX = 20;

/** An alert as the bell list and the System health list show it. messageValues are ids and numbers, plus the names the page words need. */
export const alertItem = z.object({
  id: z.string(),
  at: wireTime,
  type: z.string(),
  state: z.enum(ALERT_STATE_WORDS),
  messageKey: z.string(),
  messageValues: z.record(z.string(), z.union([z.string(), z.number()])),
  /** The page the alert opens (SD-30 "Links to"). */
  link: z.string(),
  /** Whether the alert was emailed to managers (FR-HLTH-4). */
  emailed: z.boolean(),
  /** For a manager: this manager has an unopened copy of the alert email, which API-174 opens (FR-AUTH-8, OA-74). A read never holds a link (F-660). */
  emailWaiting: z.boolean(),
  /** For a manager: this manager's copy was already opened (the row says "You opened this email."). */
  emailOpened: z.boolean(),
  /** An open `text_gave_up` alert for an office text about no visit offers Dismiss (SD-30; API-176; F-875, owner ruling 9f7f745a). */
  dismissible: z.boolean(),
});

const alertSettingItem = z.object({ type: z.string(), bell: z.boolean(), managersEmail: z.boolean() });

const textSimulatorState = z.object({
  mode: z.enum(TEXT_SIMULATOR_MODES),
  customerId: z.string().nullable(),
  customerName: z.string().nullable(),
  nLeft: z.number().int().nullable(),
  /** The manager who set it; null until the first write (the seed's "up" is Setup's). */
  setBy: z.string().nullable(),
  setAt: wireTime.nullable(),
});

const overall = z.object({
  /** false when a health check (backup, restore test, board delay, billing reset) is open. */
  working: z.boolean(),
  /** The open alerts, whatever their type: the items that need the office. */
  needsOffice: count,
});

export const officeAlerts = defineContract({
  id: 'API-43',
  name: 'Office alerts',
  method: 'GET',
  path: '/alerts',
  request: z.object({ branch: branchParam, date: dateParam.optional() }),
  response: z.object({ alerts: z.array(alertItem) }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { branch: 'columbus' }, expectStatus: 401 }],
});

export const systemHealth = defineContract({
  id: 'API-70',
  name: 'System health',
  method: 'GET',
  path: '/system/health',
  request: z.object({}),
  response: z.object({
    /** The branch this answer is for, the caller's own: the page follows this branch's events (F-663). */
    branch: branchParam,
    /** Demo now in the caller's branch zone: the page's "Today" and the base of its relative words. */
    asOf: wireTime,
    lastCheck: wireTime.nullable(),
    overall,
    backupSetUp: z.boolean(),
    backup: z.object({
      result: z.enum(['passed', 'failed']),
      at: wireTime,
      finishedAt: wireTime.nullable(),
      sizeBytes: z.number().int().nullable(),
      nightsKept: z.number().int().nullable(),
      copiesAt: z.string(),
      nextAt: wireTime,
    }).nullable(),
    backups: z.array(z.object({ night: dateParam, result: z.enum(['passed', 'failed']).nullable() })),
    restoreTests: z.array(z.object({
      at: wireTime,
      finishedAt: wireTime.nullable(),
      minutes: z.number().int().nullable(),
      result: z.enum(['passed', 'failed']),
      first: z.boolean(),
    })),
    restoreNextAt: wireTime.nullable(),
    locations: z.object({ app: z.string(), backups: z.string(), texts: z.string(), maps: z.string() }),
    delay: z.object({
      samples: z.array(z.object({ at: wireTime, ms: count })),
      typicalMs: z.number().int().nullable(),
      slowestMs: z.number().int().nullable(),
      goalMs: z.number().int(),
    }),
    alerts: z.array(alertItem),
    alertSettings: z.array(alertSettingItem),
    textSimulator: textSimulatorState,
    outbox: z.object({
      today: count,
      delivered: count,
      held: count,
      retrying: count,
      notSentToday: count,
      callList: count,
      retryingTexts: z.array(z.object({ textId: z.string(), customer: z.string(), kind: z.string(), status: z.string(), tries: count, nextTryAt: wireTime.nullable() })),
      heldTexts: z.array(z.object({ textId: z.string(), customer: z.string(), kind: z.string(), heldUntil: wireTime, heldUntilBranch: wireTime })),
    }),
    billing: z.object({
      mode: z.string().nullable(),
      waiting: count,
      finishedToday: count,
      inBillingToday: count,
      lastSentAt: wireTime.nullable(),
      listed: z.array(z.object({
        jobNumber: z.number().int(),
        customer: z.string(),
        service: z.string(),
        reasonKind: z.enum(['timeout', 'down', 'data_error']).nullable(),
        reason: z.string().nullable(),
      })),
    }),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: {}, expectStatus: 401 }],
});

export const setTextSimulator = defineContract({
  id: 'API-71',
  name: 'Set text simulator',
  method: 'PUT',
  path: '/system/text-simulator',
  request: z.object({
    mode: z.enum(TEXT_SIMULATOR_MODES),
    customerId: z.string().uuid().optional(),
    n: z.number().int().min(1).max(SIMULATOR_N_MAX).optional(),
  }),
  response: z.object({ textSimulator: textSimulatorState }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { mode: 'up' }, expectStatus: 401 }],
});

export const checkNow = defineContract({
  id: 'API-160',
  name: 'Check now',
  method: 'POST',
  path: '/system/checks',
  request: z.object({}),
  response: z.object({ lastCheck: wireTime, overall }),
  successStatus: [200],
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: {}, expectStatus: 401 }],
});

export const setAlertSwitch = defineContract({
  id: 'API-161',
  name: 'Set an alert switch',
  method: 'PUT',
  path: '/system/alert-settings/{alertType}',
  request: z.object({ alertType: alertTypeParam, bell: z.boolean().optional(), managersEmail: z.boolean().optional() })
    .refine((v) => v.bell !== undefined || v.managersEmail !== undefined, { message: 'bell or managersEmail' }),
  response: z.object({ alertSetting: alertSettingItem }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { alertType: 'text_gave_up', bell: false }, expectStatus: 401 }],
});

/**
 * API-174: opens the caller's copy of an alert email (CTL-OFC-16-23, CTL-OFC-28-04; FR-AUTH-8 note). SD-29 stores only a token's hash, so a
 * link cannot be shown twice: the screens ask here on the click, and this mints this manager's fresh link and retires the unopened one. No
 * read writes, so no view can retire a link another view is showing (F-660). 404: no copy, or it has been opened.
 */
export const alertEmailLink = defineContract({
  id: 'API-174',
  name: 'Alert email link',
  method: 'POST',
  path: '/alerts/{alertId}/email-link',
  request: z.object({ alertId: z.string().uuid() }),
  response: z.object({ link: z.string() }),
  successStatus: [200],
  errors: ['not_found'],
  labels: [],
  examples: [{ name: 'signed out', input: { alertId: '00000000-0000-4000-8000-000000000000' }, expectStatus: 401 }],
});

/**
 * API-176 (CTL-OFC-16-28, CTL-OFC-28-05; SPECIFICATIONS SD-30; owner ruling 9f7f745a, "Add a Dismiss"): closes the one alert a person can close, an open
 * `text_gave_up` alert for an office text about no visit. It reads resolved with `resolvedAt` = demo now; any other alert, or one already closed, is
 * refused `rule_refused` (409).
 */
export const dismissAlert = defineContract({
  id: 'API-176',
  name: 'Dismiss an alert',
  method: 'POST',
  path: '/alerts/{alertId}/dismiss',
  request: z.object({ alertId: z.string().uuid() }),
  response: z.object({ alert: z.object({ id: z.string(), state: z.literal('resolved'), resolvedAt: wireTime }) }),
  successStatus: [200],
  errors: ['rule_refused', 'not_found'],
  labels: [],
  examples: [{ name: 'signed out', input: { alertId: '00000000-0000-4000-8000-000000000000' }, expectStatus: 401 }],
});

export const healthContracts: ContractRow[] = [healthz, boardDelaySample, officeAlerts, systemHealth, setTextSimulator, checkNow, setAlertSwitch, alertEmailLink, dismissAlert];
