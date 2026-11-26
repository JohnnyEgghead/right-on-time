// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract rows of the clock moves (UI-SPECIFICATION 12.2 API-11 to API-14; SPECIFICATIONS 6.9 FR-DEMO-3 to FR-DEMO-6,
// section 5.2 step 6, SD-12). The clock read API-10 is in ./demo.ts, not here. Managers only (SCR-OFC-17, SCR-OFC-27).
import { z } from 'zod';
import { defineContract, type ContractRow } from '../contract.ts';

/** An RFC 9557 time with its offset and IANA zone (UI-SPECIFICATION 12.1 item 5; @bw/time fromWire's shape). */
const wireTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\[[^\]]+\]$/);

/** The 6 presets of FR-DEMO-5 (CTL-OFC-17-04), in their screen order. */
export const PRESET_IDS = ['reminder_6pm', 'tomorrow_8am', 'sat_oct_31', 'sun_nov_1', 'sat_mar_13_2027', 'sun_mar_14_2027'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

const replayState = z.object({ running: z.boolean(), done: z.number().int().nonnegative(), total: z.number().int().nonnegative() });

export const clockPresets = defineContract({
  id: 'API-11',
  name: 'Clock presets',
  method: 'GET',
  path: '/clock/presets',
  request: z.object({}),
  response: z.object({
    presets: z.array(z.object({ presetId: z.enum(PRESET_IDS), labelKey: z.string().min(1), target: wireTime, reachable: z.boolean() })),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', expectStatus: 401 }],
});

export const jumpClock = defineContract({
  id: 'API-12',
  name: 'Jump the clock',
  method: 'POST',
  path: '/clock/jumps',
  // `to` (an instant) or `presetId`, exactly 1.
  request: z
    .object({ to: wireTime.optional(), presetId: z.enum(PRESET_IDS).optional() })
    .refine((v) => (v.to === undefined) !== (v.presetId === undefined), { message: 'give to or presetId, not both', path: ['to'] }),
  response: z.object({ replay: replayState }),
  successStatus: [202],
  errors: ['not_forward', 'replay_running'],
  labels: [],
  examples: [{ name: 'signed out', input: { to: '2026-09-15T18:05:00-04:00[America/New_York]' }, expectStatus: 401 }],
});

export const pauseClock = defineContract({
  id: 'API-13',
  name: 'Pause or resume',
  method: 'PUT',
  path: '/clock/paused',
  request: z.object({ paused: z.boolean() }),
  response: z.object({ paused: z.boolean() }),
  errors: ['replay_running'],
  labels: [],
  examples: [{ name: 'signed out', input: { paused: true }, expectStatus: 401 }],
});

export const resetWorldRow = defineContract({
  id: 'API-14',
  name: 'Reset the world',
  method: 'POST',
  path: '/clock/resets',
  request: z.object({}),
  response: z.object({ worldEpoch: z.number().int() }),
  successStatus: [202],
  errors: ['cooldown', 'replay_running'],
  errorDetails: { cooldown: z.object({ availableInSeconds: z.number().int().positive() }) },
  labels: [],
  examples: [{ name: 'signed out', expectStatus: 401 }],
});

export const clockContracts: ContractRow[] = [clockPresets, jumpClock, pauseClock, resetWorldRow];
