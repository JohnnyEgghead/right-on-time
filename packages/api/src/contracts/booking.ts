// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract rows of the booking area (P5-BOOKING; UI-SPECIFICATION 12.2 API-112 to API-114, SPECIFICATIONS FR-BOOK-1, FR-BOOK-3, FR-BOOK-9,
// FR-BOOK-10, FR-BOOK-11, FR-BOOK-12, FR-BOOK-15, FR-BOOK-16). API-110 (services) and API-111 (street search) are the job page's and the
// customers area's rows; the booking site reads them too (CTL-CUS-01-03, CTL-CUS-01-04). Address fields are address-tagged.
import { z } from 'zod';
import { ADDRESS_TAG, addressField, defineContract, type ContractRow } from '../contract.ts';
import { ruleRefusedDetail } from './dispatch.ts';
import { localDate } from './shapes.ts';

const addressNamed = { [ADDRESS_TAG]: true };
const placeId = () => z.uuid().meta(addressNamed);
const wireTime = z.string().min(1);
const SAMPLE_ID = '00000000-0000-7000-8000-000000000000';
const language = z.enum(['en', 'es']);

/** Online booking offers the next 21 days after today (SPECIFICATIONS SD-27, GAP-9). */
export const ONLINE_HORIZON_DAYS = 21;
/** A window shows its places left when its room is at most this (SD-27, GAP-23, FR-BOOK-16). */
export const PLACES_LEFT_THRESHOLD = 3;
/**
 * A day is marked few left when at least 1 and at most half of that day's windows have room, whatever the day's length (SD-27 v0.12,
 * FR-BOOK-15; owner ruling 311a122c, "Half the day's windows", F-1136).
 */
export const fewWindowsLeft = (open: number, total: number): boolean => open > 0 && open * 2 <= total;

/** 1 window of the online channel's answer: its room is shown as Open, `placesLeft` left, or Full. */
export const onlineWindow = z.object({
  windowId: z.string(), start: wireTime, end: wireTime, state: z.enum(['open', 'full']),
  /** The window's room when it is at or below the threshold; null when it shows Open (or Full). */
  placesLeft: z.number().int().nullable(),
});

export const onlineAvailability = defineContract({
  id: 'API-112',
  name: 'Availability (online)',
  method: 'POST',
  path: '/public/availability',
  request: z.object({ streetId: placeId(), serviceId: z.string().min(1).max(60), from: localDate, to: localDate }),
  response: z.object({
    branch: z.string(), zone: z.string(), today: localDate,
    days: z.array(z.object({
      date: localDate, mode: z.enum(['two_hour', 'four_hour', 'saturday', 'sunday']),
      state: z.enum(['open', 'full', 'closed']),
      reason: z.enum(['sunday', 'no_technicians', 'booking_closed', 'full']).nullable(),
      fewLeft: z.boolean(),
      windows: z.array(onlineWindow),
    })),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'a street not on the list', input: { streetId: SAMPLE_ID, serviceId: 'furnace_tune_up', from: '2026-09-15', to: '2026-09-20' }, expectStatus: 422 }],
});

export const bookOnline = defineContract({
  id: 'API-113',
  name: 'Book online',
  method: 'POST',
  path: '/public/bookings',
  request: z.object({
    serviceId: z.string().min(1).max(60),
    streetId: placeId(),
    houseNumber: z.number().int().min(1).max(99999),
    date: localDate,
    windowId: z.string().min(1).max(60),
    name: z.string().trim().min(1).max(120),
    mobile: z.string().trim().max(30).nullable(),
    textsOn: z.boolean(),
    textLanguage: language,
    timeZone: z.string().min(1).max(64),
  }),
  response: z.object({
    bookingToken: z.string(),
    visit: z.object({ jobNumber: z.number().int(), serviceId: z.string(), date: localDate, window: z.object({ start: wireTime, end: wireTime }), zone: z.string() }),
  }),
  successStatus: [201],
  errors: ['window_full', 'booking_closed', 'rule_refused'],
  // `window_full` carries the open windows nearest the one that filled (FR-BOOK-3): same day first, then the next days.
  errorDetails: { window_full: z.object({ open: z.array(onlineWindow.extend({ date: localDate })) }), rule_refused: ruleRefusedDetail },
  labels: [],
  examples: [{ name: 'a street not on the list', input: {
    serviceId: 'furnace_tune_up', streetId: SAMPLE_ID, houseNumber: 12, date: '2026-09-15', windowId: 'x', name: 'Lucia Moreno', mobile: null, textsOn: false,
    textLanguage: 'en', timeZone: 'America/New_York',
  }, expectStatus: 422 }],
});

export const bookingSummary = defineContract({
  id: 'API-114',
  name: 'Booking summary',
  method: 'GET',
  path: '/public/bookings/{bookingToken}',
  request: z.object({ bookingToken: z.string().min(1).max(64) }),
  response: z.object({
    visit: z.object({
      jobNumber: z.number().int(), serviceId: z.string(), serviceLabelKey: z.string(), priceTextKey: z.string(), date: localDate,
      window: z.object({ start: wireTime, end: wireTime }), zone: z.string(), branch: z.string(), bookedAt: wireTime, name: z.string(),
      address: z.object({ houseNumber: z.number().int(), street: addressField(), city: z.string(), zip: addressField() }).meta(addressNamed),
    }),
    textsOn: z.boolean(),
    textLanguage: language,
    confirmationText: z.object({
      status: z.enum(['queued', 'held', 'sending', 'delivered', 'retrying', 'gave_up', 'canceled']),
      heldUntil: wireTime.nullable(), sentAt: wireTime.nullable(), to: z.string(), body: z.string(),
    }).nullable(),
    inboxUrl: z.string().nullable(),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'a token that names no booking', input: { bookingToken: 'x'.repeat(22) }, expectStatus: 404 }],
});

export type OnlineAvailabilityAnswer = z.infer<typeof onlineAvailability.response>;
export type OnlineDay = OnlineAvailabilityAnswer['days'][number];
export type OnlineWindow = z.infer<typeof onlineWindow>;
export type BookedAnswer = z.infer<typeof bookOnline.response>;
export type BookingSummaryAnswer = z.infer<typeof bookingSummary.response>;

export const bookingContracts: ContractRow[] = [onlineAvailability, bookOnline, bookingSummary];
