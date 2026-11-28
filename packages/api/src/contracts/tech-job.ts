// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract rows of the web technician app's job screens (P5-TWA-JOB; UI-SPECIFICATION SCR-TEC-04 to SCR-TEC-07). BUILD_PLAN
// D-7: a screen lane owns its reads. API-101 is the technician's own job (12.2: "job, customer notes, equipment, history (last
// 3), notes (office and technician), photos, phone only if the job is today, version"; `forbidden` when not the technician's
// job). API-175 is the photo and signature file read that 12.2 does not list yet (F-707, F-727: CTL-OFC-03-14 to -16 and
// CTL-OFC-03-30 name "photo files from API-23" and the signature image, and CTL-TEC-04-10 and -11 show the job's photos): 1
// stored file by its item key, answered as the image itself. They join the tech area (contracts/index.ts), after its item rows.
import { z } from 'zod';
import { addressField, defineContract, type ContractRow } from '../contract.ts';
import { itemKey } from './tech.ts';
import { equipmentItem } from './job-page.ts';
import { localDate } from './shapes.ts';

const wireTime = z.string().min(1);
const jobNumberParam = z.coerce.number().int().min(1).max(2_147_483_647);
const SAMPLE_JOB = 24830;
const SAMPLE_KEY = '00000000-0000-4000-8000-000000000000';
const status = z.enum(['scheduled', 'on_the_way', 'on_site', 'done', 'no_one_home', 'canceled']);

/** A note with its author and time, office or technician (CTL-TEC-04-08; FR-DISP-27). */
const techNote = z.object({ id: z.string(), kind: z.enum(['office', 'technician']), author: z.string().nullable(), body: z.string(), at: wireTime });

export const myJob = defineContract({
  id: 'API-101',
  name: 'My job',
  method: 'GET',
  path: '/tech/jobs/{jobNumber}',
  request: z.object({ jobNumber: jobNumberParam }),
  response: z.object({
    job: z.object({
      jobNumber: z.number().int(), version: z.number().int(), status, zone: z.string(), date: localDate,
      /** The job's date is today by the demo clock in the job's branch zone (FR-AUTH-4). */
      today: z.boolean(),
      window: z.object({ start: wireTime, end: wireTime }), serviceLabelKey: z.string(), problem: z.string().nullable(),
      onTheWayAt: wireTime.nullable(), arrivedAt: wireTime.nullable(), endedAt: wireTime.nullable(),
      /** CTL-TEC-04-19: the job's place in the technician's list for its day when that day is today, else null (only the number shows). */
      position: z.object({ index: z.number().int(), of: z.number().int() }).nullable(),
      /** CTL-TEC-04-04: the job after this one in today's list (Directions to the next job, API-104 fromJob/toJob); null when none. */
      nextJob: z.number().int().nullable(),
    }),
    customer: z.object({
      name: z.string(), address: addressField(), area: z.string(),
      /** FR-AUTH-4 (OA-29 row 16): the customer's number only for a job of today; null, never sent, on any other day. */
      phone: z.string().nullable(),
      /** How to get in (the customer's own note on the job screen, CTL-TEC-04-05) and the customer's notes, newest first. */
      gettingIn: z.string().nullable(),
      notes: z.array(techNote),
    }),
    equipment: z.array(equipmentItem),
    /** The last 3 visits, newest first: the old system's past visits together with the customer's done jobs (section 6.2). */
    history: z.array(z.object({
      date: localDate, what: z.string().nullable(), serviceLabelKey: z.string().nullable(), technician: z.string().nullable(),
    })),
    /** The job's notes, office and technician, newest first (CTL-TEC-04-08). */
    notes: z.array(techNote),
    /** The job's photos as the server holds them, in the order they were taken (CTL-TEC-04-10; the files are API-175's). */
    photos: z.array(z.object({ key: z.string(), by: z.string().nullable(), at: wireTime })),
  }),
  errors: [],
  labels: ['entered_offline'],
  examples: [{ name: 'signed out', input: { jobNumber: SAMPLE_JOB }, expectStatus: 401 }],
});

/** The image types API-175 answers: a photo is a JPEG and a signature a PNG (SD-32). */
export const STORED_FILE_TYPES = ['image/jpeg', 'image/png'] as const;
/** API-175's size values: thumb, every photo tile's small copy (UD-55); absent, the full file the viewers read. */
export const STORED_FILE_SIZES = ['thumb'] as const;

export const storedFile = defineContract({
  id: 'API-175',
  name: 'Photo or signature file',
  method: 'GET',
  path: '/files/{key}',
  // size thumb: a photo's small copy, a JPEG whose longest side is 320 px (SD-32, UD-55); a signature answers its PNG whatever the size.
  request: z.object({ key: itemKey, size: z.enum(STORED_FILE_SIZES).optional() }),
  // The kernel writes `bytes` as the body with `type` as its media type (contract.ts image); no envelope.
  response: z.object({ type: z.enum(STORED_FILE_TYPES), bytes: z.instanceof(Uint8Array) }),
  envelope: false,
  image: true,
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { key: SAMPLE_KEY }, expectStatus: 401 }],
});

export type MyJobAnswer = z.infer<typeof myJob.response>;

export const techJobContracts: ContractRow[] = [myJob, storedFile];
