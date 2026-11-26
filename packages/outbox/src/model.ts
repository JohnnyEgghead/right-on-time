// SPDX-License-Identifier: AGPL-3.0-or-later
// The outbox's words (SPECIFICATIONS section 3 `outbox_text`, `text_attempt`, `scheduled_event`; section 5.2 SD-18).
// One place for every status, kind, reason and limit, so the enqueuer, the try handler, Try now and the tests agree.
import { Temporal, type Instant } from '@bw/time';

/** The values of outbox_text.kind: the confirmation, reminder, on-the-way and late texts, the reply to a customer's R, and the office's own free text (FR-TEXT-1 to FR-TEXT-5, FR-TEXT-8, FR-TEXT-20). */
export const TEXT_KINDS = ['confirmation', 'reminder', 'on_the_way', 'late', 'r_reply', 'office'] as const;
export type TextKind = (typeof TEXT_KINDS)[number];
/** The kinds rendered from a catalog template (every kind but the office's free text). */
export type TemplateKind = Exclude<TextKind, 'office'>;
export const TEMPLATE_KINDS: readonly TemplateKind[] = TEXT_KINDS.filter((k): k is TemplateKind => k !== 'office');
/**
 * Template variants: a 2nd catalog template `text.<id>` for a kind, stored under that kind (F-650). `reminder_today` is the
 * reminder whose send falls on the visit's own day in the customer's zone (quiet hours held it past midnight), so it says
 * "today", never a "tomorrow" that is false by then. Each variant keeps its kind's SD-17 budget.
 */
export const TEMPLATE_VARIANTS = { reminder_today: 'reminder' } as const satisfies Record<string, TemplateKind>;
/** A catalog template id: a kind's own template or a variant of it. */
export type TemplateId = TemplateKind | keyof typeof TEMPLATE_VARIANTS;
export const TEMPLATE_IDS: readonly TemplateId[] = [...TEMPLATE_KINDS, ...(Object.keys(TEMPLATE_VARIANTS) as (keyof typeof TEMPLATE_VARIANTS)[])];

/**
 * outbox_text.status (FR-TEXT-15). `sending` is in the enum for a gateway that sends outside the try's transaction; the
 * simulator (the only gateway, OOS-01) sends inside it, so no reader can ever see `sending` and the try never writes it.
 */
export const TEXT_STATUSES = ['queued', 'held', 'sending', 'delivered', 'retrying', 'gave_up', 'canceled'] as const;
export type TextStatus = (typeof TEXT_STATUSES)[number];
/** The statuses a try may still act on. Every other status is final. */
export const SENDABLE: readonly TextStatus[] = ['queued', 'held', 'retrying'];

/** FR-TEXT-12: tries 1 to 5 at the first try's time plus these minutes. Never a 6th. */
export const TRY_OFFSETS_MINUTES = [0, 2, 4, 9, 19] as const;
export const MAX_TRIES = TRY_OFFSETS_MINUTES.length;

/** FR-TEXT-7, invariant 9: no text between 9:00 PM and 8:00 AM in the customer's own zone. */
export const QUIET_START = '21:00';
export const QUIET_END = '08:00';

/**
 * Kinds that quiet hours never hold (F-1545, owner ruling Nov 13 2026: on-the-way texts are not held; owner answer c40c66e2: the late text skips quiet hours too). Every quiet-hours
 * path reads this one list: enqueue, the try-time recheck, the retry schedule, API-41 and Try now. A kind joins by one word here.
 */
export const QUIET_HOURS_EXEMPT_KINDS: readonly TextKind[] = ['on_the_way', 'late'];

/** Whether a text of `kind` skips quiet hours. */
export function isQuietHoursExempt(kind: string | undefined): boolean {
  return kind !== undefined && (QUIET_HOURS_EXEMPT_KINDS as readonly string[]).includes(kind);
}

/** outbox_text.reason_key values this package writes (the catalog holds their words, FR-TEXT-15). */
export const REASON = {
  quietHours: 'text_reason.quiet_hours',
  sendFailed: 'text_reason.send_failed',
  gaveUp: 'text_reason.gave_up',
  arrivedFirst: 'text_reason.arrived_first',
  /** The office canceled, reassigned or rescheduled the job before the on-the-way text went out (F-566). */
  visitChanged: 'text_reason.visit_changed',
} as const;

/** scheduled_event.kind of a text's try (section 3). */
export const TEXT_TRY = 'text.try';

/** The payload of a text.try event: ids only (NFR-05). `by` is set when Try now moved it (FR-TEXT-24). */
export interface TextTryPayload {
  textId: string;
  /** The try number this event makes: always the text's tries + 1 when it runs. */
  number: number;
  by?: string;
}

/** A pg timestamptz (a Date) or an ISO string as a Temporal instant. */
export function instantOf(v: Date | string): Instant {
  return v instanceof Date ? Temporal.Instant.fromEpochMilliseconds(v.getTime()) : Temporal.Instant.from(v);
}
