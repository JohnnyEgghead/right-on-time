// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract rows of the map area. The lane that builds the area adds its API-<nn> rows here (defineContract from ../contract.ts)
// and its examples; no other file needs editing.
//
// P5-LIVEMAP: API-116 Live map data, the customer's live map link plus `/data` (UI-SPECIFICATION 12.2; SPECIFICATIONS SD-17, 6.4 Live map
// ends at arrival, FR-TEXT-4, FR-TEXT-22, FR-TEXT-23, NFR-04). API-115 (the live map page itself, answering 200 page or 410 ended page at the
// link path) is not a contract row here: it is the page route SCR-CUS-04 / SCR-CUS-05, whose status the page gate sets from the same rule
// as this row (packages/api-server/src/kernel/pages.ts, handlers/live-map.ts).
import { z } from 'zod';
import { defineContract } from '../contract.ts';
import type { ContractRow } from '../contract.ts';
import { localDate } from './shapes.ts';

const wireTime = z.string().min(1);
const lonLat = z.object({ lon: z.number(), lat: z.number() });
/** The 8-character link token of SD-17; any other text is a link that does not exist (404), never a validation answer. */
const liveMapToken = z.string().min(1).max(64);

/** Why a live map link answers 410 (UI-SPECIFICATION 12.2 API-116): the technician arrived, or the office changed the visit. */
export const LIVE_MAP_ENDED_REASONS = ['arrived', 'changed'] as const;

/**
 * The 410 answer's members (FR-TEXT-4, NFR-04): visit facts and the office phone, never a coordinate. With reason `changed` the page
 * reads only `officePhone`; `visit`, `technician` and `arrivedAt` are then null, so no old van, technician or window shows.
 */
export const liveMapEndedDetail = z.object({
  reason: z.enum(LIVE_MAP_ENDED_REASONS),
  arrivedAt: wireTime.nullable(),
  visit: z.object({ serviceLabelKey: z.string(), day: localDate, window: z.object({ start: wireTime, end: wireTime }) }).nullable(),
  technician: z.object({ name: z.string(), initials: z.string(), van: z.string().nullable() }).nullable(),
  officePhone: z.string().nullable(),
});

export const liveMapData = defineContract({
  id: 'API-116',
  name: 'Live map data',
  method: 'GET',
  path: '/m/{liveMapToken}/data',
  request: z.object({ liveMapToken }),
  response: z.object({
    branch: z.string(),
    technician: z.object({ name: z.string(), initials: z.string(), van: z.string().nullable() }),
    visit: z.object({ serviceLabelKey: z.string(), day: localDate, window: z.object({ start: wireTime, end: wireTime }) }),
    /** The estimate (the time the text promised, else the plan), the minutes to it rounded up, and the time the technician left. */
    eta: wireTime.nullable(),
    minutesAway: z.number().int().nullable(),
    leftAt: wireTime,
    /** The van where the baked track puts it at demo now; null when it cannot be placed. */
    van: lonLat.extend({ source: z.enum(['track', 'approximate']) }).nullable(),
    destination: lonLat,
    /** The leg drawn: the baked track's points, or null for the straight "Approximate route" line between `from` and `to`. */
    route: z.object({ from: lonLat, to: lonLat, track: z.array(z.tuple([z.number(), z.number()])).nullable() }),
    officePhone: z.string(),
  }),
  errors: ['gone'],
  errorDetails: { gone: liveMapEndedDetail },
  labels: [],
  examples: [{ name: 'a link that does not exist', input: { liveMapToken: 'AAAAAAAA' }, expectStatus: 404 }],
});

/**
 * API-164 Live map preview (FR-TEXT-21, HC-04, NFR-04): the picture the text inbox shows under a live map link. 200: an SVG drawn on the server
 * from the branch's own map file (roads and the destination pin, no van position, the OpenStreetMap credit in the picture) and the words the
 * card shows as catalog keys. 410, by the one link-ended rule of API-116: no picture and no coordinate.
 */
export const liveMapPreview = defineContract({
  id: 'API-164',
  name: 'Live map preview',
  method: 'GET',
  path: '/m/{liveMapToken}/preview',
  request: z.object({ liveMapToken }),
  response: z.object({
    svg: z.string().min(1),
    altKey: z.string(),
    captionKey: z.string(),
    /** The technician's first name, the caption's only parameter ("{technician} is on the way"). */
    technician: z.string(),
  }),
  errors: ['gone'],
  errorDetails: { gone: liveMapEndedDetail },
  labels: [],
  examples: [{ name: 'a link that does not exist', input: { liveMapToken: 'AAAAAAAA' }, expectStatus: 404 }],
});

export const mapContracts: ContractRow[] = [liveMapData, liveMapPreview];
