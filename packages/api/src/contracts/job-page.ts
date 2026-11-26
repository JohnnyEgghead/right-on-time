// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract rows of the job page (P4-JOB; UI-SPECIFICATION SCR-OFC-03 and its dialogs SCR-OFC-20 to -23, -35 to -37).
// BUILD_PLAN D-7: a screen lane owns its reads (API-23, API-29, API-37, API-107, API-110, API-135); the 2 small office
// writes the page's dialogs make and no phase 3 lane named (API-140 an office note, API-142 an equipment edit) are here
// too. They join the dispatch area (contracts/index.ts).
import { z } from 'zod';
import { addressField, defineContract, type ContractRow } from '../contract.ts';
import { billingState } from './dispatch.ts';
import { localDate } from './shapes.ts';

const wireTime = z.string().min(1);
const jobNumberParam = z.coerce.number().int().min(1).max(2_147_483_647);
const SAMPLE_JOB = 24825;
const SAMPLE_ID = '00000000-0000-7000-8000-000000000000';
const status = z.enum(['scheduled', 'on_the_way', 'on_site', 'done', 'no_one_home', 'canceled']);
const by = z.enum(['office', 'technician', 'customer', 'system']);

export const equipmentItem = z.object({
  id: z.string(), type: z.string(), year: z.number().int().nullable(), location: z.string().nullable(), details: z.string().nullable(),
});

/** A note with its author and time (office and technician; FR-DISP-27). */
const noteItem = z.object({
  id: z.string(), kind: z.enum(['office', 'technician']), author: z.string().nullable(), body: z.string(),
  at: wireTime, sentAt: wireTime, enteredOffline: z.boolean(),
});

/** A value of a timeline entry: what the entry names (a technician, a date, a status word key), never a phone or address. */
const timelineValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const jobDetail = defineContract({
  id: 'API-23',
  name: 'Job detail',
  method: 'GET',
  path: '/jobs/{jobNumber}',
  request: z.object({ jobNumber: jobNumberParam }),
  response: z.object({
    job: z.object({
      jobNumber: z.number().int(), version: z.number().int(), status, branch: z.string(), zone: z.string(),
      date: localDate, windowId: z.string(), window: z.object({ start: wireTime, end: wireTime }),
      serviceId: z.string(), serviceLabelKey: z.string(), jobType: z.string(), expectedMinutes: z.number().int(),
      problem: z.string().nullable(), equipmentId: z.string().nullable(),
      bookedVia: z.string(), bookedAt: wireTime,
      technician: z.object({ id: z.string(), name: z.string(), initials: z.string(), van: z.string().nullable(), skill: z.string() }).nullable(),
      plannedArrival: wireTime.nullable(), confirmed: z.boolean(),
      onTheWayAt: wireTime.nullable(), arrivedAt: wireTime.nullable(), endedAt: wireTime.nullable(),
      /** CTL-OFC-03-09: who recorded a No one home, and when. */
      noOneHome: z.object({ by: z.string().nullable(), at: wireTime }).nullable(),
    }),
    customer: z.object({
      id: z.string(), name: z.string(), mobile: z.string().nullable(), phone: z.string().nullable(), textsOn: z.boolean(),
      language: z.enum(['en', 'es']), zone: z.string(), address: addressField(), area: z.string(),
      customerSince: localDate, pastVisitCount: z.number().int(), plan: z.enum(['comfort_club']).nullable(),
      /** The customer's own notes (UI-SPECIFICATION 12.2; SCR-OFC-36 on the customer page), newest first; the job's are `notes`. */
      notes: z.array(noteItem),
    }),
    equipment: z.array(equipmentItem),
    /** The last 3 visits, newest first: the old system's past visits together with the customer's done jobs (section 6.2). */
    history: z.object({
      count: z.number().int(),
      fromOldSystem: z.boolean(),
      visits: z.array(z.object({
        date: localDate, what: z.string().nullable(), serviceLabelKey: z.string().nullable(), technician: z.string().nullable(),
        oldSystem: z.boolean(), jobNumber: z.number().int().nullable(),
        /** What was done: an old visit's work-done cell, a done job's work-done lines in order; none when nothing was recorded. */
        workDone: z.array(z.string()),
      })),
    }),
    notes: z.array(noteItem),
    photos: z.array(z.object({ key: z.string(), by: z.string().nullable(), at: wireTime })),
    timeline: z.array(z.object({
      kind: z.string(), at: wireTime, by: z.string().nullable(), byKind: by.nullable(),
      values: z.record(z.string(), timelineValue),
    })),
    texts: z.array(z.object({ id: z.string(), kind: z.string(), status: z.string(), at: wireTime, body: z.string() })),
    finish: z.object({
      parts: z.array(z.object({ partId: z.string(), name: z.string(), code: z.string(), quantity: z.number().int() })),
      noPartsUsed: z.boolean(), laborMinutes: z.number().int().nullable(), workDone: z.array(z.string()),
    }).nullable(),
    /** CTL-OFC-03-30: who signed and when; `key` reads the image (API-175, F-727). */
    signature: z.object({ key: z.string(), signedBy: z.string(), at: wireTime }).nullable(),
    billing: z.object({ state: billingState, reasonKey: z.string().nullable() }),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { jobNumber: SAMPLE_JOB }, expectStatus: 401 }],
});

export const partsList = defineContract({
  id: 'API-107',
  name: 'Parts list',
  method: 'GET',
  path: '/parts',
  request: z.object({}),
  response: z.object({ parts: z.array(z.object({ partId: z.string(), name: z.string(), code: z.string(), priceCents: z.number().int() })) }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: {}, expectStatus: 401 }],
});

export const services = defineContract({
  id: 'API-110',
  name: 'Services',
  method: 'GET',
  path: '/public/services',
  request: z.object({}),
  response: z.object({
    services: z.array(z.object({
      serviceId: z.string(), screenLabelKey: z.string(), priceTextKey: z.string(), typicalLengthKey: z.string(), bookableOnline: z.boolean(),
    })),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'anyone', input: {}, expectStatus: 200 }],
});

export const officeAvailability = defineContract({
  id: 'API-29',
  name: 'Availability (office)',
  method: 'GET',
  path: '/availability',
  request: z.object({
    branch: z.string().min(1).max(40), serviceId: z.string().min(1).max(60), from: localDate, to: localDate, channel: z.literal('office'),
    /** The job being moved (SCR-OFC-20): it is left out of every count, as the reschedule write leaves it out. */
    jobNumber: jobNumberParam.optional(),
  }),
  response: z.object({
    days: z.array(z.object({
      date: localDate, mode: z.enum(['two_hour', 'four_hour', 'saturday', 'sunday']),
      state: z.enum(['open', 'full', 'closed']), reason: z.enum(['sunday', 'full', 'past']).nullable(), left: z.number().int(),
      windows: z.array(z.object({ windowId: z.string(), start: wireTime, end: wireTime, state: z.enum(['open', 'full']), left: z.number().int() })),
    })),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { branch: 'columbus', serviceId: 'furnace_tune_up', from: '2026-09-15', to: '2026-09-20', channel: 'office' }, expectStatus: 401 }],
});

export const jobOnTheWay = defineContract({
  id: 'API-135',
  name: 'Job on the way',
  method: 'GET',
  path: '/jobs/{jobNumber}/on-the-way',
  request: z.object({ jobNumber: jobNumberParam }),
  response: z.object({
    onTheWay: z.boolean(),
    van: z.object({ lon: z.number(), lat: z.number(), source: z.enum(['track', 'approximate']) }).nullable(),
    destination: z.object({ lon: z.number(), lat: z.number() }).nullable(),
    eta: wireTime.nullable(), minutesAway: z.number().int().nullable(), insideWindow: z.boolean().nullable(),
    technician: z.object({ name: z.string(), initials: z.string(), van: z.string().nullable(), skill: z.string(), phone: z.string() }).nullable(),
    linkSentAt: wireTime.nullable(),
  }),
  errors: ['gone'],
  labels: [],
  examples: [{ name: 'signed out', input: { jobNumber: SAMPLE_JOB }, expectStatus: 401 }],
});

export const inboxLink = defineContract({
  id: 'API-37',
  name: 'Inbox link',
  method: 'GET',
  path: '/customers/{customerId}/inbox-link',
  request: z.object({ customerId: z.uuid() }),
  response: z.object({ url: z.string() }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { customerId: SAMPLE_ID }, expectStatus: 401 }],
});

/** The most an office note may hold (CTL-OFC-36-01). */
export const OFFICE_NOTE_MAX = 2000;

export const addOfficeNote = defineContract({
  id: 'API-140',
  name: 'Add an office note',
  method: 'POST',
  path: '/notes',
  // Exactly 1 of jobNumber and customerId (validation_failed otherwise): a job note or a customer note (SCR-OFC-36).
  request: z.object({
    jobNumber: z.number().int().min(1).max(2_147_483_647).optional(), customerId: z.uuid().optional(),
    body: z.string().trim().min(1).max(OFFICE_NOTE_MAX),
  }),
  response: z.object({ note: z.object({ id: z.string(), author: z.string(), at: wireTime }) }),
  successStatus: [201],
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { jobNumber: SAMPLE_JOB, body: 'Called ahead' }, expectStatus: 401 }],
});

export const addEquipment = defineContract({
  id: 'API-141',
  name: 'Add equipment',
  method: 'POST',
  path: '/customers/{customerId}/equipment',
  // The same fields and limits as Edit equipment (API-142), for the equipment dialog's add mode (SCR-OFC-37); here the type is required.
  request: z.object({
    customerId: z.uuid(),
    type: z.string().trim().min(1).max(80),
    year: z.number().int().min(1900).max(2100).nullable().optional(),
    location: z.string().trim().max(80).nullable().optional(),
    details: z.string().trim().max(500).nullable().optional(),
  }),
  response: z.object({ equipment: equipmentItem }),
  successStatus: [201],
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { customerId: SAMPLE_ID, type: 'Water heater' }, expectStatus: 401 }],
});

export const editEquipment = defineContract({
  id: 'API-142',
  name: 'Edit equipment',
  method: 'PATCH',
  path: '/equipment/{equipmentId}',
  request: z.object({
    equipmentId: z.uuid(),
    type: z.string().trim().min(1).max(80).optional(),
    year: z.number().int().min(1900).max(2100).nullable().optional(),
    location: z.string().trim().max(80).nullable().optional(),
    details: z.string().trim().max(500).nullable().optional(),
  }),
  response: z.object({ equipment: equipmentItem }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { equipmentId: SAMPLE_ID, type: 'Gas furnace' }, expectStatus: 401 }],
});

// API-143, the office's own text (SCR-OFC-35; FR-TEXT-20, OA-66), made only through the outbox (enqueueText). Its
// callers are office screens, so it sits in the dispatch area: the text area's policy is the customer's own (FR-AUTH-2).
/** The most a text body may be on the wire; the 1-message rule (160 GSM-7 or 70 UCS-2 units) is the server's, not the schema's. */
export const OFFICE_TEXT_MAX_WIRE = 1000;

/** message_too_long's members (UI-SPECIFICATION 4.3: "carries the characters and the limit"). */
export const messageTooLongDetail = z.object({
  /** The body's length in its encoding's units (D12: the shared segment counter). */
  characters: z.number().int(),
  /** 1 message's limit in that encoding: 160 (GSM-7) or 70 (UCS-2). */
  limit: z.number().int(),
  encoding: z.enum(['gsm7', 'ucs2']),
});

export const sendOfficeText = defineContract({
  id: 'API-143',
  name: 'Send an office text',
  method: 'POST',
  path: '/customers/{customerId}/texts',
  request: z.object({
    customerId: z.uuid(),
    body: z.string().trim().min(1).max(OFFICE_TEXT_MAX_WIRE),
    jobNumber: z.number().int().min(1).max(2_147_483_647).nullable(),
  }),
  response: z.object({
    text: z.object({
      id: z.string(),
      /** sending: queued for its first try now; held: quiet hours hold it until heldUntil (FR-TEXT-7). */
      status: z.enum(['sending', 'held']),
      heldUntil: z.string().nullable(),
      encoding: z.enum(['gsm7', 'ucs2']),
      characters: z.number().int(),
    }),
  }),
  successStatus: [201],
  errors: ['message_too_long', 'texts_off', 'no_mobile'],
  errorDetails: { message_too_long: messageTooLongDetail },
  labels: [],
  examples: [{ name: 'signed out', input: { customerId: '00000000-0000-7000-8000-000000000000', body: 'Hello', jobNumber: null }, expectStatus: 401 }],
});

/** The job page's answers as types, for page code that has no zod of its own (apps/web). */
export type JobDetailAnswer = z.infer<typeof jobDetail.response>;
export type OnTheWayAnswer = z.infer<typeof jobOnTheWay.response>;
export type AvailabilityAnswer = z.infer<typeof officeAvailability.response>;
export type PartsAnswer = z.infer<typeof partsList.response>;
export type ServicesAnswer = z.infer<typeof services.response>;

export const jobPageContracts: ContractRow[] = [jobDetail, partsList, services, officeAvailability, jobOnTheWay, inboxLink, addOfficeNote, addEquipment, editEquipment, sendOfficeText];
