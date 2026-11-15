// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract rows of the tech area. The lane that builds the area adds its API-<nn> rows here (defineContract from ../contract.ts)
// and its examples; no other file needs editing.
// P3-ITEMS (SPECIFICATIONS section 5.1, section 4.6 SD-16; BUILD_PLAN D-7: the engine lane owns the item rows): API-102
// queued items, API-103 a photo or signature upload, API-162 the app's sync report, and API-39, the office's Mark
// handled of an item the server flagged (the other half of the offline conflict record; its list is P4-BOARD's API-20).
import { z } from 'zod';
import { addressField, defineContract, type ContractRow } from '../contract.ts';

/** An RFC 9557 time with its offset and IANA zone (UI-SPECIFICATION 12.1 item 5; @bw/time fromWire's shape). */
export const itemTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\[[^\]]+\]$/);
/** The phone mints every item key, a UUID v4 (SPECIFICATIONS section 3 Identifiers). */
export const itemKey = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/** At most 50 items per send (SPECIFICATIONS section 5.1 step 2). */
export const MAX_ITEMS_PER_BATCH = 50;
/** SD-32 (GAP-17): the server refuses a photo over 10 MB and a signature over 512 KB with validation_failed. */
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const SIGNATURE_MAX_BYTES = 512 * 1024;
/** The longest note body (section 3 note.body sets none; the phone's note page keeps a note to 1 screen). */
export const NOTE_MAX_CHARS = 2000;

// F-559 (F-260): job_number is a PostgreSQL integer, so a larger number is refused here, not left to answer 500.
const JOB_NUMBER_MAX = 2_147_483_647;

/** Every item's facts (section 5.1 step 1): the job, the version the app last read, the world and the 3 times. */
const facts = {
  key: itemKey,
  jobNumber: z.number().int().min(1).max(JOB_NUMBER_MAX),
  baseVersion: z.number().int().min(1),
  worldEpoch: z.number().int().min(0),
  /** The phone's own real time at entry (realNow('device_stamp')). */
  deviceTime: itemTime,
  /** The server's real time when the stored offset was saved (API-10's realNow). */
  offsetSavedReal: itemTime,
  /** The phone's real milliseconds from that save to entry. */
  sinceSaveMs: z.number().int(),
  /** deviceTime + the stored demo-minus-real offset (FR-DEMO-9). */
  demoTime: itemTime,
};

/** The finish lines a Finished item carries (FR-BILL-3, FR-TECH-14); the finishLines validator decides them per item. */
export const finishPayload = z.object({
  parts: z.array(z.object({ partId: z.string().min(1).max(64), quantity: z.number() })).max(50),
  noPartsUsed: z.boolean(),
  laborMinutes: z.number(),
  workDone: z.array(z.string().trim().min(1).max(200)).max(20),
});

export const queuedItem = z.discriminatedUnion('kind', [
  z.object({ ...facts, kind: z.literal('note'), payload: z.object({ text: z.string().trim().min(1).max(NOTE_MAX_CHARS) }) }),
  z.object({ ...facts, kind: z.literal('on_my_way') }),
  z.object({ ...facts, kind: z.literal('arrived') }),
  z.object({ ...facts, kind: z.literal('finished'), payload: finishPayload }),
  z.object({ ...facts, kind: z.literal('no_one_home') }),
]);

/**
 * 1 item as a send carries it (F-488; SPECIFICATIONS section 5.1 step 10, UI-SPECIFICATION 12.2 API-102: the batch
 * never fails as a whole for 1 item). Only its key is checked with the send, since an answer names its item by key.
 * Its kind, its payload caps and its times are checked per item against queuedItem by the handler, and an item that
 * fails them is answered refused with validation_failed alone while the rest of the send applies.
 */
export const sentItem = z.looseObject({ key: itemKey });

/** Message values: ids, names, counts and wire times only (never a phone number or address, NFR-05). */
const messageValues = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));

/**
 * The answer for 1 item (section 5.1 step 10). `refused` leaves the item on the phone with the reason shown, and only for
 * `parts_required`, a finish with neither parts nor No parts used (FR-BILL-3). `validation_failed` (a part not on the list,
 * a bad quantity or labor, a world epoch from the future) and `not_found` (a job that is not the technician's) are the
 * reasons the phone cannot fix: they are answered `flagged` with that code and listed for the dispatcher, so the item
 * leaves the phone (owner ruling 546d6f1e; UI-SPECIFICATION 4.5 rule 10). Every result but `refused` removes it
 * (UI-SPECIFICATION 4.5 rule 1).
 */
export const itemAnswer = z.object({
  key: itemKey,
  result: z.enum(['applied', 'duplicate', 'flagged', 'history_only', 'world_reset', 'refused']),
  code: z.enum(['parts_required', 'validation_failed', 'not_found']).nullable(),
  messageKey: z.string().nullable(),
  values: messageValues.nullable(),
});

export const sendItems = defineContract({
  id: 'API-102',
  name: 'Send queued items',
  method: 'POST',
  path: '/tech/items',
  request: z.object({ items: z.array(sentItem).min(1).max(MAX_ITEMS_PER_BATCH) }),
  response: z.object({ items: z.array(itemAnswer) }),
  errors: ['parts_required'],
  labels: [],
  examples: [{ name: 'signed out', input: { items: [] }, expectStatus: 401 }],
});

export const uploadBlob = defineContract({
  id: 'API-103',
  name: 'Upload a photo or signature',
  method: 'PUT',
  path: '/tech/photos/{key}',
  request: z.object({
    key: itemKey,
    kind: z.enum(['photo', 'signature']),
    jobNumber: z.coerce.number().int().min(1).max(JOB_NUMBER_MAX),
    worldEpoch: z.coerce.number().int().min(0),
    deviceTime: itemTime,
    offsetSavedReal: itemTime,
    sinceSaveMs: z.coerce.number().int(),
    demoTime: itemTime,
  }),
  response: z.object({
    key: itemKey,
    // F-931: a photo or signature the phone cannot fix is answered flagged with its code, like an item (owner ruling 546d6f1e).
    result: z.enum(['applied', 'duplicate', 'world_reset', 'flagged']),
    code: z.enum(['validation_failed', 'not_found']).nullable(),
    messageKey: z.string().nullable(),
    values: messageValues.nullable(),
  }),
  // F-978: a body over the cap or of another type is answered by the handler under its key (flagged validation_failed), not refused unread.
  upload: { maxBytes: PHOTO_MAX_BYTES, contentTypes: ['image/jpeg', 'image/png'], handlerJudgesRefused: true },
  errors: [],
  labels: [],
  examples: [
    { name: 'signed out', input: { key: '00000000-0000-4000-8000-000000000000' }, expectStatus: 401 },
    // F-477: a body past nginx's 1 MB default must reach the kernel (the 11m route of infra/nginx/routes-open.conf), which refuses a signed-out
    // call before it reads the body (mount.ts); a missing or shadowed route would answer 413 here and stay green on config checks alone.
    { name: 'signed out with a 2 MB body: the proxy passes it on (not 413)', input: { key: '00000000-0000-4000-8000-000000000000', padding: 'x'.repeat(2 * 1024 * 1024) }, expectStatus: 401 },
  ],
});

export const reportSync = defineContract({
  id: 'API-162',
  name: 'Report sync state',
  method: 'POST',
  path: '/tech/sync-reports',
  request: z.object({
    app: z.enum(['web', 'native']),
    waitingCount: z.number().int().min(0).max(100_000),
    /** The phone's own real time of its last sync (FR-DISP-33; device_stamp), as reported. */
    lastSyncAt: itemTime,
    // No NUL: PostgreSQL text cannot hold one, and it answered 500 (F-469).
    device: z.string().trim().min(1).max(80).regex(/^[^\u0000]*$/),
    version: z.string().trim().min(1).max(40).regex(/^[^\u0000]*$/),
  }),
  response: z.object({}),
  successStatus: [204],
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { app: 'web' }, expectStatus: 401 }],
});

/** already_handled's members (UI-SPECIFICATION 12.2 API-39 "(by, at)"): who marked it first and when. */
export const alreadyHandledDetail = z.object({ by: z.string(), at: z.string() });

export const markHandled = defineContract({
  id: 'API-39',
  name: 'Mark a flagged item handled',
  method: 'POST',
  path: '/offline-conflicts/{conflictId}/handled',
  request: z.object({ conflictId: z.string().uuid() }),
  response: z.object({
    conflict: z.object({ conflictId: z.string(), jobNumber: z.number().int(), handledBy: z.string(), handledAt: z.string() }),
  }),
  errors: ['already_handled'],
  errorDetails: { already_handled: alreadyHandledDetail },
  labels: [],
  examples: [{ name: 'signed out', input: { conflictId: '00000000-0000-4000-8000-000000000000' }, expectStatus: 401 }],
});

// P5-TWA-TODAY (SPECIFICATIONS section 6.3 FR-TECH-1, FR-TECH-2, FR-TECH-12, FR-TECH-15; section 3 D-7: API-100 is the Today lane's read).
const jobStatus = z.enum(['scheduled', 'on_the_way', 'on_site', 'done', 'no_one_home']);
const todayJob = z.object({
  jobNumber: z.number().int(),
  version: z.number().int(),
  /** The job's place in the day (1 for the first by window, then planned arrival). */
  position: z.number().int().min(1),
  status: jobStatus,
  window: z.object({ start: itemTime, end: itemTime }),
  customer: z.object({ name: z.string(), language: z.enum(['en', 'es']), phone: z.string().optional() }),
  address: addressField(),
  area: z.string(),
  serviceLabelKey: z.string(),
  equipment: z.object({ type: z.string(), year: z.number().int().nullable(), details: z.string().nullable() }).nullable(),
  lastVisit: z.object({ date: z.string(), what: z.string().nullable(), labelKey: z.string().nullable() }).nullable(),
  customerNote: z.string().nullable(),
  plannedArrival: itemTime.nullable(),
  textedArrival: itemTime.nullable(),
  endedAt: itemTime.nullable(),
  /** The late text the server sent (FR-TEXT-5): when, the new time and the time it measured against. */
  lateText: z.object({ sentAt: itemTime, eta: itemTime, wasEta: itemTime.nullable() }).nullable(),
  /** The on-the-way text as Send would make it (FR-TECH-2): scheduled jobs only; nothing is stored or sent. */
  onMyWayPreview: z.object({ language: z.enum(['en', 'es']), text: z.string(), arrival: itemTime }).nullable(),
});

export const todayJobs = defineContract({
  id: 'API-100',
  name: 'My day',
  method: 'GET',
  path: '/tech/day',
  request: z.object({}),
  response: z.object({
    date: z.string(),
    /** The demo time the day was read at (the phone's "Last updated" when it is offline). */
    asOf: itemTime,
    zone: z.string(),
    van: z.object({ number: z.string(), vehicle: z.string() }).nullable(),
    startedAt: itemTime.nullable(),
    officePhone: z.string(),
    technician: z.object({ name: z.string(), initials: z.string(), employeeNumber: z.string().nullable(), skill: z.string().nullable(), branch: z.string() }),
    jobs: z.array(todayJob),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', expectStatus: 401 }],
});

export type TodayAnswer = z.infer<typeof todayJobs.response>;
export type TodayJob = z.infer<typeof todayJob>;

/** The product a Right On Time server names in API-105 (SCR-TEC-12 "Connected to Right On Time, version 1.0."). */
export const PRODUCT_NAME = 'Right On Time';
/** The product version API-105 answers: the release line the native app shows, not a commit (API-02 answers the commit). */
export const PRODUCT_VERSION = '1.0';

// P6-NATIVE-SHELL: API-105, the native app's server check (UI-SPECIFICATION 12.2 API-105; SPECIFICATIONS 6.12 FR-IOS-3). It answers
// before the access code and with no session, so a fresh install can check an address it has never signed in to (CTL-TEC-12-02).
export const serverInfo = defineContract({
  id: 'API-105',
  name: 'Server check',
  method: 'GET',
  path: '/server-info',
  request: z.object({}),
  response: z.object({ product: z.literal(PRODUCT_NAME), version: z.string().min(1).max(20) }),
  errors: [],
  labels: [],
  examples: [{ name: 'answers with no session and no code', expectStatus: 200 }],
});

export const techContracts: ContractRow[] = [todayJobs, sendItems, uploadBlob, reportSync, markHandled, serverInfo];
