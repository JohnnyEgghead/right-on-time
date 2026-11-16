// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract rows of the dispatch area. The lane that builds the area adds its API-<nn> rows here (defineContract from ../contract.ts)
// and its examples; no other file needs editing.
// P2-SHELL (owner ruling c025a9ec): API-130, the top-bar search (CMP-07, FR-DISP-11).
// P3-OFFICE-WRITES (BUILD_PLAN D-7: the engine lane owns the write rows): API-22 assign, API-24 reschedule, API-28 create,
// API-136 to API-138 the blocks.
// P3-JOB-WRITES (D-17): API-25 cancel a job, API-27 edit job details. Every one runs SPECIFICATIONS section 5.3 through the office write service
// (packages/api-server/src/office-writes/); their refusals that 12.2 names with members carry them (errorDetails, F-261).
import { z } from 'zod';
import { ADDRESS_TAG, addressField, defineContract, type ContractRow } from '../contract.ts';
import { localDate, localTime } from './shapes.ts';

/** Each result group holds at most this many rows; `more` says a group had more (SPECIFICATIONS FR-DISP-11). */
export const SEARCH_GROUP_CAP = 5;

/** The address group and its more flag are address-named, so they carry the address tag too (the contract gate's name rule). */
const addressNamed = { [ADDRESS_TAG]: true };

export const search = defineContract({
  id: 'API-130',
  name: 'Search jobs, customers and addresses',
  method: 'POST',
  path: '/searches',
  // A request body only: the query may hold an address or a name (UI-SPECIFICATION 12.1 item 6, NFR-05).
  request: z.object({ query: z.string().trim().min(2).max(100), branch: z.string().min(1).max(40) }),
  response: z.object({
    jobs: z.array(z.object({
      jobNumber: z.number().int(),
      customer: z.string(),
      /** The job's local date, YYYY-MM-DD. */
      day: z.string(),
      window: z.object({ start: z.string(), end: z.string() }),
      status: z.string(),
    })),
    customers: z.array(z.object({ id: z.string(), name: z.string(), area: z.string(), plan: z.enum(['comfort_club']).nullable() })),
    addresses: z.array(z.object({ customerId: z.string(), address: addressField() })).meta(addressNamed),
    more: z.object({ jobs: z.boolean(), customers: z.boolean(), addresses: z.boolean().meta(addressNamed) }),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { query: 'high', branch: 'columbus' }, expectStatus: 401 }],
});

/** An RFC 9557 time (UI-SPECIFICATION 12.1 item 5). */
const wireTime = z.string().min(1);
/** A wall time in the branch zone, HH:MM. */
// F-260: job_number is a PostgreSQL integer (a larger number answered 500).
const jobNumberParam = z.coerce.number().int().min(1).max(2_147_483_647);
const version = z.number().int().min(1);

/**
 * version_conflict's members (SPECIFICATIONS 5.3 step 1 and section 6.2 FR-DISP-6; UI-SPECIFICATION 12.2 "by, change, at,
 * currentVersion"): the change that made the current version, who made it, the technician the job has now, and when.
 * `by` is the person's name, null for a customer or the system. A block's conflict is answered from the block change log
 * (P4-BOARD, owner ruling 8ef38e83, F-354): change `moved`; by, byKind and at are null only for a block never moved.
 */
export const versionConflictDetail = z.object({
  by: z.string().nullable(),
  byKind: z.enum(['office', 'technician', 'customer', 'system']).nullable(),
  /** The job_change kind (section 3 enum table), e.g. assigned or rescheduled. */
  change: z.string().nullable(),
  /** The technician the job or block has now; null for Unassigned. */
  technician: z.string().nullable(),
  at: wireTime.nullable(),
  currentVersion: version,
});

/** technician_no_room's members (F-1701, F-1803): the limit that refused the placement and that limit's number (UI-SPECIFICATION section 4.3). */
export const noRoomDetail = z.object({ limit: z.enum(['installer_day', 'day', 'window']), max: z.number().int().nonnegative() });

/** time_overlap's members (FR-DISP-34; OI-41): the block and the job whose planned time would overlap it. */
export const overlapDetail = z.object({
  block: z.object({ blockId: z.string(), label: z.string(), place: z.string().nullable(), start: wireTime, end: wireTime }),
  job: z.object({ jobNumber: z.number().int(), plannedArrival: wireTime, plannedEnd: wireTime }),
});

/**
 * rule_refused's member (UI-SPECIFICATION section 4.3: "carries a catalog key naming the rule"; F-506): the catalog key of
 * the rule that refused, e.g. rule.jobClosed for a job that is Done, No one home or Canceled (12.1 item 9, F-505).
 */
export const ruleRefusedDetail = z.object({ key: z.string().regex(/^rule\.[A-Za-z]+$/) });

/** A job as the office writes answer it: the projection's own fields after the write (with its new version). */
export const writtenJob = z.object({
  jobNumber: z.number().int(),
  branch: z.string(),
  customerId: z.string(),
  serviceId: z.string(),
  date: localDate,
  windowId: z.string(),
  window: z.object({ start: wireTime, end: wireTime }),
  technicianId: z.string().nullable(),
  status: z.enum(['scheduled', 'on_the_way', 'on_site', 'done', 'no_one_home', 'canceled']),
  version,
  plannedArrival: wireTime.nullable(),
  expectedMinutes: z.number().int(),
});

export const writtenBlock = z.object({
  blockId: z.string(),
  technicianId: z.string(),
  date: localDate,
  label: z.string(),
  place: z.string().nullable(),
  start: wireTime,
  end: wireTime,
  version,
});

const SAMPLE_JOB = 24825;
const SAMPLE_ID = '00000000-0000-7000-8000-000000000000';

export const assignJob = defineContract({
  id: 'API-22',
  name: 'Assign a job',
  method: 'POST',
  path: '/jobs/{jobNumber}/assignment',
  request: z.object({ jobNumber: jobNumberParam, technicianId: z.uuid().nullable(), baseVersion: version }),
  response: z.object({ job: writtenJob }),
  errors: ['version_conflict', 'time_overlap', 'technician_no_room', 'rule_refused'],
  errorDetails: { version_conflict: versionConflictDetail, time_overlap: overlapDetail, technician_no_room: noRoomDetail, rule_refused: ruleRefusedDetail },
  labels: [],
  examples: [{ name: 'signed out', input: { jobNumber: SAMPLE_JOB, technicianId: null, baseVersion: 1 }, expectStatus: 401 }],
});

export const rescheduleJob = defineContract({
  id: 'API-24',
  name: 'Reschedule a job',
  method: 'POST',
  path: '/jobs/{jobNumber}/schedule',
  request: z.object({ jobNumber: jobNumberParam, date: localDate, windowId: z.uuid(), baseVersion: version }),
  response: z.object({
    job: writtenJob,
    /** GAP-10, SD-45: whether the technician was kept, and whether the new confirmation text was sent. */
    outcome: z.object({ technicianKept: z.boolean(), textSent: z.boolean() }),
  }),
  errors: ['window_full', 'version_conflict', 'time_overlap', 'day_closed', 'day_past', 'rule_refused'],
  errorDetails: { version_conflict: versionConflictDetail, time_overlap: overlapDetail, rule_refused: ruleRefusedDetail },
  labels: [],
  examples: [{ name: 'signed out', input: { jobNumber: SAMPLE_JOB, date: '2026-09-17', windowId: SAMPLE_ID, baseVersion: 1 }, expectStatus: 401 }],
});

export const cancelJob = defineContract({
  id: 'API-25',
  name: 'Cancel a job',
  method: 'POST',
  path: '/jobs/{jobNumber}/cancellation',
  request: z.object({ jobNumber: jobNumberParam, baseVersion: version }),
  response: z.object({ job: writtenJob }),
  errors: ['version_conflict', 'rule_refused'],
  errorDetails: { version_conflict: versionConflictDetail, rule_refused: ruleRefusedDetail },
  labels: [],
  examples: [{ name: 'signed out', input: { jobNumber: SAMPLE_JOB, baseVersion: 1 }, expectStatus: 401 }],
});

export const editJob = defineContract({
  id: 'API-27',
  name: 'Edit job details',
  method: 'PATCH',
  path: '/jobs/{jobNumber}',
  request: z.object({
    jobNumber: jobNumberParam,
    serviceId: z.string().min(1).max(60),
    equipmentId: z.uuid().nullable(),
    problem: z.string().trim().max(500).nullable(),
    baseVersion: version,
  }),
  response: z.object({ job: writtenJob }),
  // F-505: rule_refused for a closed job (12.1 item 9); F-507 item 3: window_full when the service crosses FR-BOOK-5's pools
  // (SPECIFICATIONS 5.3 step 3); time_overlap when the new length reaches a block.
  errors: ['version_conflict', 'time_overlap', 'window_full', 'rule_refused'],
  errorDetails: { version_conflict: versionConflictDetail, time_overlap: overlapDetail, rule_refused: ruleRefusedDetail },
  labels: [],
  examples: [{ name: 'signed out', input: { jobNumber: SAMPLE_JOB, serviceId: 'water_heater', equipmentId: null, problem: null, baseVersion: 1 }, expectStatus: 401 }],
});

/** A job's billing state as section 3 names it (job.billing_state). */
export const billingState = z.enum(['not_sent', 'sending', 'retrying', 'waiting_person', 'in_billing', 'marked_fixed']);

export const finishJobOffice = defineContract({
  id: 'API-26',
  name: 'Finish a job (office)',
  method: 'POST',
  path: '/jobs/{jobNumber}/finish',
  // P4-JOB (D-17): the office finish. The lines are the finish item's shape (tech.ts finishPayload, less workDone: an office
  // finish carries no work-done lines, OI-35); the finishLines validator decides them, not the schema (FR-BILL-3).
  request: z.object({
    jobNumber: jobNumberParam,
    parts: z.array(z.object({ partId: z.string().min(1).max(64), quantity: z.number() })).max(50),
    noPartsUsed: z.boolean(),
    laborMinutes: z.number(),
    baseVersion: version,
  }),
  response: z.object({ job: writtenJob, billing: z.object({ state: billingState }) }),
  // rule_refused: a job already Done, No one home or Canceled (CTL-OFC-03-08's rule; F-505).
  errors: ['parts_required', 'version_conflict', 'rule_refused'],
  errorDetails: { version_conflict: versionConflictDetail, rule_refused: ruleRefusedDetail },
  labels: [],
  examples: [{ name: 'signed out', input: { jobNumber: SAMPLE_JOB, parts: [], noPartsUsed: true, laborMinutes: 45, baseVersion: 1 }, expectStatus: 401 }],
});

export const createJob = defineContract({
  id: 'API-28',
  name: 'Create a job (office)',
  method: 'POST',
  path: '/jobs',
  request: z.object({
    customerId: z.uuid(),
    serviceId: z.string().min(1).max(60),
    equipmentId: z.uuid().nullable(),
    problem: z.string().trim().max(500).nullable(),
    date: localDate,
    windowId: z.uuid(),
    technicianId: z.uuid().nullable(),
  }),
  response: z.object({
    job: writtenJob,
    /** GAP-10: the confirmation text's status, or none (the text pipeline is section 6.4's). */
    confirmationText: z.object({ status: z.string() }).nullable(),
  }),
  successStatus: [201],
  errors: ['window_full', 'technician_no_room', 'time_overlap', 'rule_refused', 'day_closed', 'day_past'],
  errorDetails: { time_overlap: overlapDetail, technician_no_room: noRoomDetail, rule_refused: ruleRefusedDetail },
  labels: [],
  examples: [{
    name: 'signed out',
    input: { customerId: SAMPLE_ID, serviceId: 'water_heater', equipmentId: null, problem: null, date: '2026-09-17', windowId: SAMPLE_ID, technicianId: null },
    expectStatus: 401,
  }],
});

export const createBlock = defineContract({
  id: 'API-136',
  name: 'Create a block',
  method: 'POST',
  path: '/time-blocks',
  request: z.object({
    technicianId: z.uuid(), date: localDate, label: z.string().trim().min(1).max(40), place: z.string().trim().max(60).nullable(),
    start: localTime, end: localTime,
  }),
  response: z.object({ block: writtenBlock }),
  successStatus: [201],
  errors: ['time_overlap'],
  errorDetails: { time_overlap: overlapDetail },
  labels: [],
  examples: [{ name: 'signed out', input: { technicianId: SAMPLE_ID, date: '2026-09-15', label: 'Supply run', place: null, start: '13:00', end: '13:30' }, expectStatus: 401 }],
});

export const moveBlock = defineContract({
  id: 'API-137',
  name: 'Move a block',
  method: 'POST',
  path: '/time-blocks/{blockId}/move',
  request: z.object({ blockId: z.uuid(), technicianId: z.uuid(), start: localTime, end: localTime, baseVersion: version }),
  response: z.object({ block: writtenBlock }),
  errors: ['version_conflict', 'time_overlap'],
  errorDetails: { version_conflict: versionConflictDetail, time_overlap: overlapDetail },
  labels: [],
  examples: [{ name: 'signed out', input: { blockId: SAMPLE_ID, technicianId: SAMPLE_ID, start: '14:00', end: '14:30', baseVersion: 1 }, expectStatus: 401 }],
});

export const deleteBlock = defineContract({
  id: 'API-138',
  name: 'Delete a block',
  method: 'DELETE',
  path: '/time-blocks/{blockId}',
  request: z.object({ blockId: z.uuid() }),
  response: z.object({}),
  successStatus: [204],
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { blockId: SAMPLE_ID }, expectStatus: 401 }],
});

// --- P4-BOARD: the board's reads (UI-SPECIFICATION 12.2 API-20, API-30, API-131) ------------------------------------

/** SD-15 timing on the wire (FR-DISP-4 reads it): an open or on-site job's, null for an ended or unassigned job. */
export const boardTiming = z.enum(['onTime', 'atRisk', 'late']);
const jobStatus = z.enum(['scheduled', 'on_the_way', 'on_site', 'done', 'no_one_home']);

/** A job as the board shows it (API-20 "each job"): its block, its popover and the map panel's marker. */
export const boardJob = z.object({
  jobNumber: z.number().int(),
  version,
  customerName: z.string(),
  /** The customer's city (the area of Figure 8.5). */
  area: z.string(),
  serviceId: z.string(),
  /** The service's screen label key (`service.<id>.screen`, F-253). */
  serviceLabelKey: z.string(),
  windowId: z.string(),
  window: z.object({ start: wireTime, end: wireTime }),
  technicianId: z.string().nullable(),
  plannedArrival: wireTime.nullable(),
  /** SD-15's ETA (the arrival time once arrived); null with no technician. */
  eta: wireTime.nullable(),
  expectedMinutes: z.number().int(),
  status: jobStatus,
  timing: boardTiming.nullable(),
  /** A late text went to the customer (the day summary's "late text sent"). */
  lateTextSent: z.boolean(),
  /** The customer confirmed the visit (confirmed_at). */
  confirmed: z.boolean(),
  position: z.object({ lon: z.number(), lat: z.number() }),
  /** The assigned technician's primary skill (the map panel's All skills filter); null when unassigned. */
  technicianSkill: z.string().nullable(),
});

export const boardBlock = z.object({
  blockId: z.string(), version, label: z.string(), place: z.string().nullable(), start: wireTime, end: wireTime,
});

/** A Needs attention job row (UD-52): its status word's catalog key, the customer, area, technician, ETA and window. */
const attentionJob = z.object({
  jobNumber: z.number().int(),
  /** The status word's catalog key: status.timing.late, status.timing.atRisk or status.job.unassigned (FR-DISP-4). */
  label: z.string(),
  customerName: z.string(),
  area: z.string(),
  technician: z.string().nullable(),
  eta: wireTime.nullable(),
  window: z.object({ start: wireTime, end: wireTime }),
});

export const boardDay = defineContract({
  id: 'API-20',
  name: 'Board day',
  method: 'GET',
  path: '/board',
  request: z.object({ branch: z.string().min(1).max(40), date: z.union([localDate, z.literal('today')]) }),
  response: z.object({
    /** The shown date, YYYY-MM-DD (today resolved to the demo clock's today in the branch zone). */
    date: localDate,
    today: z.boolean(),
    zone: z.string(),
    /** CTL-OFC-02-07: two_hour, four_hour, or closed (a Sunday). */
    dayMode: z.enum(['two_hour', 'four_hour', 'closed']),
    /** CTL-OFC-02-34: the branch's working day, the span of its arrival windows (8 AM to 6 PM, a Saturday 8 AM to 12 PM). */
    workingHours: z.object({ start: wireTime, end: wireTime }),
    onShift: z.number().int(),
    /** CTL-OFC-02-18: the 7 days before the shown day, from the simulated pilot data (FR-REP-4); rate null with no visit. */
    onTime7: z.object({ rate: z.number().nullable(), goal: z.number(), labelKey: z.string(), from: localDate, to: localDate }),
    technicians: z.array(z.object({
      id: z.string(),
      initials: z.string(),
      name: z.string(),
      van: z.string().nullable(),
      /** Primary skill first. */
      skills: z.array(z.string()),
      capacity: z.number().int(),
      jobs: z.array(boardJob),
      blocks: z.array(boardBlock),
    })),
    unassigned: z.array(boardJob),
    needsAttention: z.object({
      late: z.array(attentionJob),
      atRisk: z.array(attentionJob),
      unassigned: z.array(attentionJob),
      /** Every flagged item of the branch not yet marked handled, whatever the date (UD-37, FR-DISP-9). */
      flagged: z.array(z.object({
        // listed: the row names a job of the world (F-953); false, jobNumber is the number the phone sent and there is no job page for it.
        conflictId: z.string(), jobNumber: z.number().int(), listed: z.boolean(), messageKey: z.string(),
        values: z.record(z.string(), z.union([z.string(), z.number()])), offlineAt: wireTime, sentAt: wireTime,
        /**
         * What the technician entered, kept by the server (section 3 tech_item.payload; owner ruling c4aa4366, "Keep and show it"): a finish's
         * parts (name null for a part not on the list, then partId is what the phone sent), No parts used, labor minutes and work-done lines, or
         * a note's text. Null for a status change, a photo or a signature.
         */
        entry: z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('finish'),
            parts: z.array(z.object({ partId: z.string(), name: z.string().nullable(), quantity: z.number() })),
            noPartsUsed: z.boolean(), laborMinutes: z.number(), workDone: z.array(z.string()),
          }),
          z.object({ kind: z.literal('note'), text: z.string() }),
          // F-1168 (owner ruling 21ce2f73, "Keep them too"): a refused photo or signature, kept; key is the file's key for API-175.
          z.object({ kind: z.literal('photo'), key: z.string() }),
          z.object({ kind: z.literal('signature'), key: z.string() }),
        ]).nullable(),
      })),
    }),
    counts: z.object({
      jobs: z.number().int(), done: z.number().int(), onSite: z.number().int(), onTheWay: z.number().int(), late: z.number().int(),
      atRisk: z.number().int(), unassigned: z.number().int(), flagged: z.number().int(), lateTextSent: z.number().int(),
    }),
  }),
  errors: [],
  // FR-REP-4: the on-time rate comes from the simulated pilot data and never travels without its label.
  labels: ['simulated_pilot_data'],
  examples: [{ name: 'signed out', input: { branch: 'columbus', date: 'today' }, expectStatus: 401 }],
});

/** A van's map state (FR-DISP-3): the status of its current job, else between jobs (SPECIFICATIONS rightNow's words). */
export const vanStatus = z.enum(['on_the_way', 'on_site', 'between_jobs']);
const lonLat = z.object({ lon: z.number(), lat: z.number() });
/** F-817 (SPECIFICATIONS 7.4 API-21): a route line's key, the first 16 lowercase hex characters of the SHA-256 of its encoded polyline. */
export const ROUTE_KEY = /^[0-9a-f]{16}$/;
/** F-817: the board names at most this many held route lines in `have`. */
export const ROUTE_HAVE_MAX = 50;

/** P4-BOARD-MAP: the van positions of the demo clock's today (UI-SPECIFICATION 12.2 API-21; SD-22). Computed on read, never stored. */
export const vanPositions = defineContract({
  id: 'API-21',
  name: 'Van positions',
  method: 'GET',
  path: '/vans',
  request: z.object({
    branch: z.string().min(1).max(40),
    /** F-817: the keys of the route lines the board holds, comma separated, at most {@link ROUTE_HAVE_MAX}; a route so named answers track null. */
    have: z.string().regex(new RegExp(`^[0-9a-f]{16}(,[0-9a-f]{16}){0,${ROUTE_HAVE_MAX - 1}}$`)).optional(),
  }),
  response: z.object({
    vans: z.array(z.object({
      technicianId: z.string(),
      name: z.string(),
      initials: z.string(),
      van: z.string().nullable(),
      /** Primary skill first, as API-20's row. */
      skills: z.array(z.string()),
      phone: z.string(),
      /** positionAt at demo now; null outside the shift with no job in hand (no position, so not a live van). */
      position: lonLat.nullable(),
      status: vanStatus,
      /** The job on the way or on site; null between jobs. */
      jobNumber: z.number().int().nullable(),
      /** SD-15's ETA of that job (the arrival time once on site). */
      eta: wireTime.nullable(),
      /**
       * The leg of a van on the way, so the map draws the road, or a labeled straight line where no track was baked (FR-MAP-3). `key`
       * names the road (null for a straight line); `track` is null too when the request's `have` named the key (F-817).
       */
      route: z.object({
        from: lonLat, to: lonLat, key: z.string().regex(ROUTE_KEY).nullable(), track: z.array(z.tuple([z.number(), z.number()])).nullable(),
      }).nullable(),
    })),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { branch: 'columbus' }, expectStatus: 401 }],
});

export const suggestTechnicians = defineContract({
  id: 'API-30',
  name: 'Suggested technicians',
  method: 'GET',
  path: '/technicians/room',
  // 12.2 names branch, date, windowId and serviceId. The ranking also needs the visit's place: `jobNumber` names a job
  // on the board (its customer, and the job left out of every count: SCR-OFC-18), `customerId` a job not yet made
  // (SCR-OFC-04). Exactly 1 of them (validation_failed otherwise); flagged for the phase 4 doc batch.
  request: z.object({
    branch: z.string().min(1).max(40), date: localDate, windowId: z.uuid(), serviceId: z.string().min(1).max(60),
    jobNumber: jobNumberParam.optional(), customerId: z.uuid().optional(),
  }),
  response: z.object({
    /** The skill the picked service needs (a skill key), so the reason line can say it in words (CTL-OFC-04-17). */
    serviceSkill: z.string(),
    technicians: z.array(z.object({
      id: z.string(), name: z.string(), van: z.string().nullable(), skills: z.array(z.string()),
      minutesFromStopBefore: z.number().int(),
      /** F-424: the stop the minutes are counted from, its planned time and area; null is the branch depot (the day has no stop before). */
      stopBefore: z.object({ jobNumber: z.number().int(), plannedArrival: wireTime, area: z.string() }).nullable(),
      load: z.object({ jobs: z.number().int(), capacity: z.number().int() }),
      room: z.boolean(),
      suggested: z.boolean(),
      reason: z.enum(['skill_missing']).nullable(),
    })),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { branch: 'columbus', date: '2026-09-15', windowId: SAMPLE_ID, serviceId: 'water_heater' }, expectStatus: 401 }],
});

export const movePreview = defineContract({
  id: 'API-131',
  name: 'Move preview',
  method: 'POST',
  path: '/jobs/{jobNumber}/assignment-preview',
  request: z.object({ jobNumber: jobNumberParam, technicianId: z.uuid().nullable() }),
  response: z.object({
    /** SD-15's planned arrival with the job on the technician's day (the FR-TEXT-5 baseline, GAP-6); null for Unassigned. */
    arrivesAbout: wireTime.nullable(),
    insideWindow: z.boolean().nullable(),
    window: z.object({ start: wireTime, end: wireTime }),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { jobNumber: SAMPLE_JOB, technicianId: null }, expectStatus: 401 }],
});

/** The board's answers as types, for page code that has no zod of its own (apps/web). */
export type BoardDayAnswer = z.infer<typeof boardDay.response>;
export type VanPositionsAnswer = z.infer<typeof vanPositions.response>;
export type MovePreviewAnswer = z.infer<typeof movePreview.response>;
export type SuggestedTechniciansAnswer = z.infer<typeof suggestTechnicians.response>;
export type VersionConflictDetail = z.infer<typeof versionConflictDetail>;

export const dispatchContracts: ContractRow[] = [
  search, assignJob, rescheduleJob, cancelJob, editJob, finishJobOffice, createJob, createBlock, moveBlock, deleteBlock, boardDay, vanPositions, suggestTechnicians, movePreview,
];
