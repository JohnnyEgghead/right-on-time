// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract rows of the customer's text inbox (SCR-INB-01) and Change your visit time (SCR-CUS-06) pages (P5-INBOX; UI-SPECIFICATION
// 12.2 API-117, API-118, API-120, API-121). The inbox is keyed by its inbox token (UD-12), the reschedule page by its 8-character link
// token (SD-17, GAP-11): both are token routes, so the kernel finds the token's own row before it runs a handler.
// API-37 (the office's inbox link) is P4-JOB's, in job-page.ts; API-164 (the live map preview) is P5-INBOX's, in map.ts (liveMapPreview).
import { z } from 'zod';
import { defineContract, type ContractRow } from '../contract.ts';
import { localDate } from './shapes.ts';

const wireTime = z.string().min(1);
const language = z.enum(['en', 'es']);
const inboxToken = z.string().min(1).max(64);
const linkToken = z.string().regex(/^[0-9A-Za-z]{8}$/);
const SAMPLE_TOKEN = 'aaaaaaaa';

/** The longest reply the inbox takes (a text is at most 1600 characters in the section 6.4 budget). */
export const REPLY_MAX = 1000;

export const inboxMessages = defineContract({
  id: 'API-120',
  name: 'Inbox',
  method: 'GET',
  path: '/inbox/{inboxToken}/messages',
  // `after`: the id of the last message the page has; the answer then holds only newer messages (the 5 s refresh, GAP-7).
  request: z.object({ inboxToken, after: z.uuid().optional() }),
  response: z.object({
    customer: z.object({
      /** The whole name (CTL-INB-01-01 and the frames print it: Harold Jenkins) and the first name the state lines use (Harold has no mobile phone). */
      name: z.string(),
      firstName: z.string(),
      /** The customer's branch office number (CMP-14 prints the page branch's phone). */
      officePhone: z.string(),
      hasMobile: z.boolean(),
      textsOn: z.boolean(),
      language,
      /** The customer's own today (their zone), so the thread can label a day Today. */
      today: localDate,
    }),
    messages: z.array(z.object({
      id: z.uuid(),
      direction: z.enum(['in', 'out']),
      body: z.string(),
      sentAt: wireTime,
      /** A reply's outcome (CTL-INB-01-08 prints Delivered under a reply); null on a text sent to the customer. */
      handling: z.enum(['confirmed', 'reschedule_sent', 'not_understood']).nullable(),
      /** The links in the body, each as the path on the running server (FR-TEXT-18, CTL-INB-01-03). */
      links: z.array(z.object({ kind: z.enum(['live_map', 'reschedule']), path: z.string(), text: z.string() })),
      /** The preview path (API-164) when a link is a live map link, else null (CTL-INB-01-11). */
      liveMapPreview: z.string().nullable(),
    })),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'a token that does not exist', input: { inboxToken: 'bbbbbbbbbbbbbbbbbbbbbb' }, expectStatus: 404 }],
});

export const inboxReply = defineContract({
  id: 'API-121',
  name: 'Reply',
  method: 'POST',
  path: '/inbox/{inboxToken}/replies',
  request: z.object({ inboxToken, body: z.string().trim().min(1).max(REPLY_MAX) }),
  response: z.object({
    reply: z.object({ id: z.uuid(), at: wireTime }),
    handling: z.enum(['confirmed', 'reschedule_sent', 'not_understood']),
  }),
  successStatus: [201],
  // A customer with no mobile phone or with texts off has no reply controls (FR-TEXT-13); the server refuses the same call.
  errors: ['no_mobile', 'texts_off'],
  labels: [],
  examples: [{ name: 'a token that does not exist', input: { inboxToken: 'bbbbbbbbbbbbbbbbbbbbbb', body: 'C' }, expectStatus: 404 }],
});

/** An ended link still says whom to call (SCR-CUS-06 Ended: "Call (614) 555-0100 to change your visit"). */
const goneDetail = z.object({ officePhone: z.string() });

const visit = z.object({
  /** The service's screen label key (a catalog string the page translates). */
  serviceLabelKey: z.string(),
  day: localDate,
  window: z.object({ start: wireTime, end: wireTime }),
});

export const reschedulePage = defineContract({
  id: 'API-117',
  name: 'Reschedule page data',
  method: 'GET',
  path: '/r/{rescheduleToken}/data',
  request: z.object({ rescheduleToken: linkToken }),
  response: z.object({
    visit,
    officePhone: z.string(),
    days: z.array(z.object({
      date: localDate,
      mode: z.enum(['two_hour', 'four_hour', 'saturday']),
      state: z.enum(['open', 'full']),
      windows: z.array(z.object({
        windowId: z.string(),
        start: wireTime,
        end: wireTime,
        state: z.enum(['open', 'full']),
        /** The places left when at or below the threshold (GAP-23), else null. */
        placesLeft: z.number().int().nullable(),
      })),
    })),
  }),
  // The link has ended (used, expired, or the visit is over or was moved by the office, OA-62).
  errors: ['gone'],
  errorDetails: { gone: goneDetail },
  labels: [],
  examples: [{ name: 'a token that does not exist', input: { rescheduleToken: SAMPLE_TOKEN }, expectStatus: 404 }],
});

export const rescheduleVisit = defineContract({
  id: 'API-118',
  name: 'Reschedule',
  method: 'POST',
  path: '/r/{rescheduleToken}',
  request: z.object({ rescheduleToken: linkToken, date: localDate, windowId: z.string().min(1).max(40) }),
  response: z.object({
    visit,
    outcome: z.object({ textSent: z.boolean() }),
  }),
  errors: ['window_full', 'booking_closed', 'gone'],
  errorDetails: { gone: goneDetail },
  labels: [],
  examples: [{ name: 'a token that does not exist', input: { rescheduleToken: SAMPLE_TOKEN, date: '2026-09-15', windowId: 'w1' }, expectStatus: 404 }],
});

export const inboxContracts: ContractRow[] = [inboxMessages, inboxReply, reschedulePage, rescheduleVisit];
