// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract rows of P5-TWA-MAP-ME (UI-SPECIFICATION 12.2; SPECIFICATIONS 6.3 "Directions", "Map tab", "Drive time", "Me screen",
// SD-15, SD-22; BUILD_PLAN D-7: the screen lane owns its reads):
//   API-104 Route    GET /tech/route?fromJob&toJob   the baked track and drive minutes of 1 leg, or the approximate line (FR-TECH-5, FR-TECH-13),
//                    and the leg's turn-by-turn steps (P6-ROUTE-BAKE; SPECIFICATIONS v0.13 SD-49, section 6.3 Directions; UI-SPECIFICATION v0.15 API-104)
//   API-163 My route GET /tech/day-route             the day's stops in order with done, next or later, and their legs (FR-TECH-11)
// API-100 (My day, GET /tech/day) is one contract, P5-TWA-TODAY's todayJobs (contracts/tech.ts); the Me screen, Directions and the Map tab
// read it too (F-1018).
// Own jobs only (UI-SPECIFICATION 2.4, FR-AUTH-4): a job that is not the caller's answers 404, whatever it is.
import { z } from 'zod';
import { addressField, defineContract, type ContractRow } from '../contract.ts';
import { localDate } from './shapes.ts';
// The step vocabulary has 1 source, SD-49's mapping in @bw/maps (import-free, so a client bundles it as is): the bake, the server and
// this contract read the same lists, and a value the mapping can make is a value the contract accepts (F-1256 part a).
import { STEP_DIRECTIONS, STEP_HEADINGS, STEP_KINDS, STEP_SIDES } from '../../../maps/src/steps.ts';

const wireTime = z.string().min(1);
const jobNumberParam = z.coerce.number().int().min(1).max(2_147_483_647);
const lonLat = z.object({ lon: z.number(), lat: z.number() });
const points = z.array(z.tuple([z.number(), z.number()]));

/** A stop's state on the Map tab (FR-TECH-11): the words Done, Next and Later. */
export const STOP_STATES = ['done', 'next', 'later'] as const;

const window = z.object({ start: wireTime, end: wireTime });

/**
 * One leg: the baked track (points) with its drive minutes and length, or an approximate line (`track` null, `distanceMeters` null)
 * with the minutes of the approximate route (SD-22; FR-MAP-3). With a `fromJob` (API-104) it starts at that job. With none, and into the
 * Map tab's next stop (API-163), it starts at the van's computed position: the previous stop (the last ended that day, else the depot),
 * or along the way from it while the job is on the way (F-1003). The Map tab's other legs start at the stop before, the first at the depot.
 */
export const routeLeg = z.object({
  from: lonLat,
  to: lonLat,
  track: points.nullable(),
  minutes: z.number().int().min(0),
  distanceMeters: z.number().int().min(0).nullable(),
});

/**
 * 1 turn-by-turn step (API-104; SPECIFICATIONS section 3 `van_track.steps`, SD-49): the 8 fields, by the names `van_track.steps` stores.
 * `direction` is null on depart, arrive, roundabout and uturn (or where the map data gives none); `heading` is set on depart only;
 * `exit` on roundabout only; `side` on arrive only; `at` is the step's turn point, [longitude, latitude], a vertex of the leg's track;
 * `distanceMeters` is the stretch to the next step's turn (from the van's position, the first step's is the length left to it).
 */
export const routeStep = z.object({
  kind: z.enum(STEP_KINDS),
  direction: z.enum(STEP_DIRECTIONS).nullable(),
  heading: z.enum(STEP_HEADINGS).nullable(),
  road: z.string().min(1).nullable(),
  exit: z.number().int().min(1).nullable(),
  side: z.enum(STEP_SIDES).nullable(),
  at: z.tuple([z.number(), z.number()]),
  distanceMeters: z.number().int().min(0),
});

export const techRoute = defineContract({
  id: 'API-104',
  name: 'Route',
  method: 'GET',
  path: '/tech/route',
  request: z.object({ toJob: jobNumberParam, fromJob: jobNumberParam.optional() }),
  response: z.object({
    branch: z.string(),
    leg: routeLeg,
    /** Demo now plus the drive minutes falls inside the destination job's window (SPECIFICATIONS 6.3 Drive time). */
    insideWindow: z.boolean(),
    /**
     * The leg's steps in driving order (FR-TECH-5): the track's `van_track.steps`, from the van's position only the steps left, the first
     * counted from that position; an empty list on an approximate leg (SD-22's straight line has no streets).
     */
    steps: z.array(routeStep),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { toJob: 1 }, expectStatus: 401 }],
});

export const dayRoute = defineContract({
  id: 'API-163',
  name: 'My route',
  method: 'GET',
  path: '/tech/day-route',
  request: z.object({}),
  response: z.object({
    date: localDate,
    branch: z.string(),
    stops: z.array(z.object({
      jobNumber: z.number().int(),
      /** The stop's place in the technician's day: 1, 2, 3 in the day's order (FR-TECH-1). */
      number: z.number().int().min(1),
      customer: z.string(),
      area: z.string(),
      address: addressField(),
      window,
      serviceLabelKey: z.string(),
      state: z.enum(STOP_STATES),
      at: lonLat,
    })),
    /** The leg into each stop, by stop number: from the stop before it (the first from the depot); the next stop's from the van's position, as API-104 with no fromJob (F-1003). */
    legs: z.array(routeLeg.extend({ toJob: z.number().int() })),
    /** The next stop's job number, or null when none is left. */
    next: z.number().int().nullable(),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', expectStatus: 401 }],
});

export const techRouteContracts: ContractRow[] = [techRoute, dayRoute];
