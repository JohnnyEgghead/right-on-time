// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract rows of the Technicians page (P4-TECHNICIANS; UI-SPECIFICATION 12.2 and SPECIFICATIONS FR-DISP-33, FR-TEXT-11, SD-28, SD-29):
// API-31 the technician list with van, skills, hours, today's load and the phone apps' last reports, API-32 the name-in-texts check,
// API-33 edit a technician, API-147 add a technician and invite them, API-148 add time off (SD-28) and API-169 remove it (OI-44).
// BUILD_PLAN D-7: a screen lane owns its reads; the writes API-33 and API-147 had no phase 3 lane, so they are here too. The time off
// writes call P3-DISPATCH-RULES's recordTimeOff and removeTimeOff. A phone number travels as stored, for example (614) 555-0112 (UI-SPECIFICATION 12.2 API-31), not as E.164.
import { z } from 'zod';
import { defineContract, type ContractRow } from '../contract.ts';
import { localDate, localTime, NO_NUL } from './shapes.ts';

const wireTime = z.string().min(1);
const SAMPLE_ID = '00000000-0000-7000-8000-000000000000';

/** The skills a technician can hold: the members of `service_type.skill` (SPECIFICATIONS section 6.1). */
export const TECHNICIAN_SKILLS = ['heating_cooling', 'plumbing', 'install'] as const;
export const SATURDAY_PATTERNS = ['none', 'even_weeks', 'odd_weeks'] as const;
export const USER_STATUSES = ['invited', 'active', 'turned_off'] as const;
/** What API-32 finds wrong with a name in texts (FR-TEXT-11). */
export const NAME_IN_TEXTS_PROBLEMS = ['none', 'empty', 'too_long', 'not_gsm7_basic', 'breaks_template'] as const;

const skill = z.enum(TECHNICIAN_SKILLS);
const hours = z.object({ start: localTime, end: localTime });

/** The workweek the page shows and API-33 and API-147 write: the weekdays worked (ISO 1 Monday to 5 Friday), the shift, and the Saturday pattern. */
export const workingHours = z.object({
  start: localTime,
  end: localTime,
  days: z.array(z.number().int().min(1).max(5)).min(1).max(5),
  saturdays: z.enum(SATURDAY_PATTERNS),
}).refine((h) => h.end > h.start, { message: 'end is after start' });

/** What 1 phone app last reported (API-162; MD-16): kept while the app is offline. */
const appReport = z.object({
  lastSyncAt: wireTime,
  waitingCount: z.number().int().min(0),
  device: z.string(),
  version: z.string(),
  reportedAt: wireTime,
});

const van = z.object({ id: z.uuid(), number: z.string(), vehicle: z.string() });

const technicianRow = z.object({
  id: z.uuid(),
  name: z.string(),
  /** The phone number as stored, for example (614) 555-0112 (UI-SPECIFICATION 12.2 API-31). */
  phone: z.string(),
  branch: z.string(),
  van: van.nullable(),
  /** The primary skill first. */
  skills: z.array(skill),
  workingHours: z.object({ start: localTime, end: localTime }),
  workingDays: z.array(z.number().int().min(1).max(5)),
  saturdays: z.enum(SATURDAY_PATTERNS),
  /** Jobs of the day's capacity (FR-BOOK-5): demo today's live jobs, and the capacity of today's kind of day. */
  todayLoad: z.number().int().min(0),
  capacity: z.number().int().min(0),
  /** Works demo today: a working day with no time off (SD-28). */
  workingToday: z.boolean(),
  nameInTexts: z.string(),
  /** The year the technician started (`technician.since`). */
  since: z.number().int(),
  /** The 5-digit number of SD-29 (`user.employee_number`), shown on this page (GAP-27); null for a user who has none. */
  employeeNumber: z.string().nullable(),
  /** On the way, On site, or Between jobs (section 12.4); null for a technician off today or with no job left today. */
  rightNow: z.object({
    status: z.enum(['on_the_way', 'on_site', 'between_jobs']),
    timing: z.enum(['onTime', 'atRisk', 'late']).nullable(),
    jobNumber: z.number().int().nullable(),
    customerName: z.string().nullable(),
  }).nullable(),
  timeOff: z.array(z.object({ id: z.uuid(), from: localDate, to: localDate, note: z.string().nullable() })),
  userStatus: z.enum(USER_STATUSES),
  apps: z.object({ web: appReport.nullable(), native: appReport.nullable() }),
});

export const technicianList = defineContract({
  id: 'API-31',
  name: 'Technicians',
  method: 'GET',
  path: '/technicians',
  request: z.object({ branch: z.string().min(1).max(40) }),
  response: z.object({
    branch: z.string(),
    zone: z.string(),
    today: localDate,
    readAt: wireTime,
    technicians: z.array(technicianRow),
    /** The branch's vans, for the Van select. */
    vans: z.array(van),
    skills: z.array(skill),
    /** The Saturday half day (the two morning windows): what a Saturday shows in the hours list. */
    saturdayHours: hours.nullable(),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { branch: 'columbus' }, expectStatus: 401 }],
});

export const checkTextValue = defineContract({
  id: 'API-32',
  name: 'Check a text value',
  method: 'POST',
  path: '/text-checks',
  request: z.object({ slot: z.literal('technician'), value: z.string().max(200) }),
  response: z.object({
    ok: z.boolean(),
    problem: z.enum(NAME_IN_TEXTS_PROBLEMS),
    /** The characters outside the standard set, when that is the problem. */
    characters: z.array(z.string()),
    /** The value's length in characters and the most a name in texts holds. */
    length: z.number().int(),
    maximum: z.number().int(),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { slot: 'technician', value: 'Maria' }, expectStatus: 401 }],
});

/** The refusal of a name that breaks the 1-message rule: the problem and the counts (FR-TEXT-11). */
export const textValueDetail = z.object({
  problem: z.enum(NAME_IN_TEXTS_PROBLEMS),
  length: z.number().int(),
  limit: z.number().int(),
  chars: z.array(z.string()).optional(),
});

/** A scheduled job left on a day the technician no longer works after an hours edit (F-764): no text moves it, so the page names it for the office. */
const offDayJob = z.object({ jobNumber: z.number().int(), date: localDate, window: z.object({ start: wireTime, end: wireTime }) });

export const editTechnician = defineContract({
  id: 'API-33',
  name: 'Edit a technician',
  method: 'PATCH',
  path: '/technicians/{technicianId}',
  request: z.object({
    technicianId: z.uuid(),
    nameInTexts: z.string().max(200).regex(NO_NUL).optional(),
    vanId: z.uuid().nullable().optional(),
    skills: z.array(skill).min(1).max(3).optional(),
    workingHours: workingHours.optional(),
  }),
  response: z.object({ technician: technicianRow, offDayJobs: z.array(offDayJob) }),
  errors: ['text_value_breaks_limit', 'rule_refused'],
  errorDetails: { text_value_breaks_limit: textValueDetail },
  labels: [],
  examples: [{ name: 'signed out', input: { technicianId: SAMPLE_ID, nameInTexts: 'Maria' }, expectStatus: 401 }],
});

export const addTechnician = defineContract({
  id: 'API-147',
  name: 'Add a technician',
  method: 'POST',
  path: '/technicians',
  request: z.object({
    name: z.string().trim().min(1).max(120).regex(NO_NUL),
    email: z.string().trim().min(3).max(254).regex(/^[^\s@\u0000]+@[^\s@\u0000]+\.[^\s@\u0000]+$/),
    branch: z.string().min(1).max(40),
    vanId: z.uuid().nullable(),
    skills: z.array(skill).min(1).max(3),
    workingHours,
  }),
  response: z.object({
    technician: technicianRow,
    user: z.object({ id: z.uuid(), email: z.string(), status: z.literal('invited'), role: z.literal('technician') }),
    /** The one-time link that opens the invite email, shown to the person who added the technician (FR-AUTH-8, OA-73). */
    emailLink: z.string(),
  }),
  successStatus: [201],
  /** `rule_refused`: the branch's phone range holds no free number (SD-29). */
  errors: ['already_a_user', 'rule_refused'],
  labels: [],
  examples: [{
    name: 'signed out',
    input: { name: 'Derek Lindgren', email: 'dlindgren@example.test', branch: 'columbus', vanId: null, skills: ['plumbing'], workingHours: { start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5], saturdays: 'none' } },
    expectStatus: 401,
  }],
});

/** The jobs a time off write took off the technician, for reassignment (GAP-25): what API-24's reschedule list also names. */
const unassignedJob = z.object({
  jobNumber: z.number().int(),
  date: localDate,
  windowId: z.string(),
  window: z.object({ start: wireTime, end: wireTime }),
  customerId: z.string(),
  serviceId: z.string(),
  version: z.number().int(),
});

/** The jobs on the way or on site that refused the span (SD-28). */
export const timeOffRefusedDetail = z.object({ jobNumbers: z.array(z.number().int()) });

export const addTimeOff = defineContract({
  id: 'API-148',
  name: 'Add time off',
  method: 'POST',
  path: '/technicians/{technicianId}/time-off',
  request: z.object({ technicianId: z.uuid(), from: localDate, to: localDate, note: z.string().trim().max(120).regex(NO_NUL).nullable().default(null) }),
  response: z.object({
    timeOffId: z.uuid(),
    technicianId: z.uuid(),
    from: localDate,
    to: localDate,
    /** The booked jobs of the span that came off the technician, each now Unassigned (SD-28, OA-78). */
    unassigned: z.array(unassignedJob),
  }),
  successStatus: [201],
  errors: ['rule_refused'],
  errorDetails: { rule_refused: timeOffRefusedDetail },
  labels: [],
  examples: [{ name: 'signed out', input: { technicianId: SAMPLE_ID, from: '2026-09-21', to: '2026-09-21', note: 'Dentist' }, expectStatus: 401 }],
});

export const removeTimeOff = defineContract({
  id: 'API-169',
  name: 'Remove time off',
  method: 'DELETE',
  path: '/technicians/{technicianId}/time-off/{spanId}',
  request: z.object({ technicianId: z.uuid(), spanId: z.uuid() }),
  response: z.object({}),
  successStatus: [204],
  errors: ['rule_refused'],
  labels: [],
  examples: [{ name: 'signed out', input: { technicianId: SAMPLE_ID, spanId: SAMPLE_ID }, expectStatus: 401 }],
});

/** The Technicians page's answers as types, for page code that has no zod of its own (apps/web). */
export type TechnicianListAnswer = z.infer<typeof technicianList.response>;
export type TechnicianRow = z.infer<typeof technicianList.response>['technicians'][number];
export type TextCheckAnswer = z.infer<typeof checkTextValue.response>;
export type TimeOffAnswer = z.infer<typeof addTimeOff.response>;

export const techniciansContracts: ContractRow[] = [technicianList, checkTextValue, editTechnician, addTechnician, addTimeOff, removeTimeOff];
