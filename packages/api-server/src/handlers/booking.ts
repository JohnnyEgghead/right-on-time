// SPDX-License-Identifier: AGPL-3.0-or-later
// The online booking site's calls (P5-BOOKING; UI-SPECIFICATION 12.2 API-112, API-113, API-114; SPECIFICATIONS FR-BOOK-1, FR-BOOK-3, FR-BOOK-9
// to FR-BOOK-12, FR-BOOK-15, FR-BOOK-16, FR-TEXT-1, SD-27, SD-45):
//   API-112  availability on the online channel: the picked street's branch, demo today excluded, the next 21 days, each day closed after
//            5:00 PM the day before (onlineOpen); room is the office channel's own count (day.ts officeDay and roomInWindow).
//   API-113  bookOnline: resolve the street, reuse or create the customer, then 1 call of the race-safe office write createJob
//            (office-writes/service.ts; its locks and its room check are the only ones) with the online channel columns, then the
//            confirmation and the reminder in the same transaction as API-28 and API-24 send them. `window_full` answers the 3 nearest open windows.
//   API-114  the booking's summary by its token, with the confirmation text as the outbox holds it.
import type { bookingSummary as summaryRow, bookOnline as bookRow, onlineAvailability as availabilityRow } from '@bw/api';
import { fewWindowsLeft, ONLINE_HORIZON_DAYS, PLACES_LEFT_THRESHOLD } from '@bw/api';
import { foldStreetName } from '@bw/db';
import { worksOn } from '@bw/domain';
import { newInboxTokens, toE164 } from '@bw/import';
import { customerZoneFor, planReminder, replanCustomerReminders, sendConfirmation, type TextContext } from '@bw/outbox';
import { catalogs } from '@bw/i18n/src/catalog.ts';
import { addDays, atLocal, localDateOf, Temporal, toWire } from '@bw/time';
import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { branchTechnicians, branchWindows, officeDay, readDayKind, roomInWindow, serviceIsInstall, windowOffered, type Window } from '../office-writes/day.ts';
import { createJob, RULE, WriteRefused, type OnlineContext } from '../office-writes/service.ts';
import type { ApiResult, Handler, HandlerContext, Tx } from '../types.ts';
import { pointOf, streetOf } from './customers.ts';

type Out<T extends { response: z.ZodType }> = z.infer<T['response']>;
type In<T extends { request: z.ZodType }> = z.infer<T['request']>;
type Day = Out<typeof availabilityRow>['days'][number];

const DEFAULT_LINK_HOST = 'bw.j7l.io';
const textContext = (hctx: HandlerContext): TextContext => ({ catalogs, linkHost: hctx.settings.TEXT_LINK_HOST ?? DEFAULT_LINK_HOST });
const instant = (d: Date) => Temporal.Instant.fromEpochMilliseconds(d.getTime());
const wireIn = (d: Date, zone: string) => toWire(instant(d), zone);
const notFound = { ok: false as const, status: 404, code: 'not_found' as const };
const invalid = { ok: false as const, status: 422, code: 'validation_failed' as const };

/** FR-BOOK-9: a date is bookable online while demo now is before 5:00 PM on the day before it, in the branch's zone; today never is. */
function onlineOpen(date: string, zone: string, now: Temporal.Instant): boolean {
  if (date <= localDateOf(now, zone)) return false;
  const cutoff = atLocal(addDays(date, -1), '17:00', zone, 'compatible');
  return Temporal.Instant.compare(now, cutoff) < 0;
}

const windowWire = (d: string, hhmm: string, zone: string) => toWire(Temporal.ZonedDateTime.from(`${d}T${hhmm.slice(0, 5)}:00[${zone}]`).toInstant(), zone);

/** The online channel's days from `from` to `to` (inside demo today to the 21-day horizon): each day's state and each offered window's room. */
export async function onlineDays(tx: Tx, input: { branch: string; zone: string; serviceId: string; install: boolean; from: string; to: string; now: Temporal.Instant }): Promise<{ today: string; days: Day[] }> {
  const today = localDateOf(input.now, input.zone);
  const last = addDays(today, ONLINE_HORIZON_DAYS);
  const windows = await branchWindows(tx, input.branch);
  const techs = await branchTechnicians(tx, input.branch);
  const days: Day[] = [];
  for (let d = input.from < today ? today : input.from; d <= input.to && d <= last; d = addDays(d, 1)) {
    const kind = await readDayKind(tx, input.branch, d);
    if (kind === 'sunday') { days.push({ date: d, mode: kind, state: 'closed', reason: 'sunday', fewLeft: false, windows: [] }); continue; }
    if (!onlineOpen(d, input.zone, input.now)) { days.push({ date: d, mode: kind, state: 'closed', reason: 'booking_closed', fewLeft: false, windows: [] }); continue; }
    if (kind === 'saturday' && !techs.some((t) => worksOn(t, d))) { days.push({ date: d, mode: kind, state: 'closed', reason: 'no_technicians', fewLeft: false, windows: [] }); continue; }
    const day = await officeDay(tx, { branch: input.branch, date: d, kind, install: input.install });
    const out = windows.filter((x) => windowOffered(x, kind)).map((x: Window) => {
      const room = roomInWindow(day, x);
      return { windowId: x.id, start: windowWire(d, x.startLocal, input.zone), end: windowWire(d, x.endLocal, input.zone), state: room > 0 ? 'open' as const : 'full' as const,
        placesLeft: room > 0 && room <= PLACES_LEFT_THRESHOLD ? room : null };
    });
    const open = out.filter((x) => x.state === 'open').length;
    days.push({ date: d, mode: kind, state: open > 0 ? 'open' : 'full', reason: open > 0 ? null : 'full', fewLeft: fewWindowsLeft(open, out.length), windows: out });
  }
  return { today, days };
}

/** API-112. */
export const onlineAvailabilityHandler: Handler<Out<typeof availabilityRow>> = async (req, tx: Tx) => {
  const p = req.params as In<typeof availabilityRow>;
  const street = await streetOf(tx, p.streetId);
  if (!street) return invalid;
  const install = await serviceIsInstall(tx, p.serviceId);
  if (install === null) return invalid;
  const r = await onlineDays(tx, { branch: street.branch_id, zone: street.zone, serviceId: p.serviceId, install, from: p.from, to: p.to, now: req.demoNow });
  return { ok: true, status: 200, data: { branch: street.branch_id, zone: street.zone, today: r.today, days: r.days } };
};

/** FR-BOOK-3: the 3 open windows nearest the one that filled: same day first (nearest start), then the following days. */
async function nearestOpen(tx: Tx, input: { branch: string; zone: string; serviceId: string; install: boolean; date: string; windowId: string; now: Temporal.Instant }) {
  const { days } = await onlineDays(tx, { ...input, from: input.date, to: addDays(input.date, ONLINE_HORIZON_DAYS) });
  const all = days.flatMap((d) => d.windows.filter((x) => x.state === 'open' && !(d.date === input.date && x.windowId === input.windowId)).map((x) => ({ ...x, date: d.date })));
  const startOf = (x: { start: string }) => Temporal.Instant.from(x.start).epochMilliseconds;
  const filled = days.find((d) => d.date === input.date)?.windows.find((x) => x.windowId === input.windowId);
  const ref = filled ? startOf(filled) : 0;
  const same = all.filter((x) => x.date === input.date).sort((a, b) => Math.abs(startOf(a) - ref) - Math.abs(startOf(b) - ref));
  const later = all.filter((x) => x.date !== input.date);
  return [...same, ...later].slice(0, 3);
}

const newBookingToken = (): string => randomBytes(16).toString('base64url');

/** A customer of the branch with the same folded name, street, house number and mobile is reused (the import merge's identity; a missing mobile matches a missing mobile only), else 1 is made at the typed address (FR-BOOK-12); texts, language and zone follow this booking. */
async function customerFor(tx: Tx, input: {
  branch: string; name: string; mobile: string | null; textsOn: boolean; textLanguage: 'en' | 'es'; zone: string; streetId: string; house: number;
  point: { lon: number; lat: number }; now: Temporal.Instant;
}): Promise<string> {
  const folded = foldStreetName(input.name);
  // FOR NO KEY UPDATE, not FOR UPDATE (F-961): a booking-day lock holder (an office API-28 for this customer and day) inserts its job and needs
  // KEY SHARE on this row for the foreign key; FOR UPDATE would block it while this call waits on the day lock, a lock cycle. This call changes no key.
  const found = (await tx.query<{ id: string; zone: string }>(
    `SELECT id, zone FROM world.customer WHERE branch_id = $1 AND status = 'active' AND name_search = $2 AND street_id = $4 AND house_number = $5 AND mobile IS NOT DISTINCT FROM $3 ORDER BY customer_since, id LIMIT 1 FOR NO KEY UPDATE`,
    [input.branch, folded, input.mobile, input.streetId, input.house])).rows[0];
  if (found) {
    await tx.query('UPDATE world.customer SET texts_on = $2, text_language = $3, zone = $4 WHERE id = $1', [found.id, input.textsOn, input.textLanguage, input.zone]);
    // F-964: a zone change moves the reminders of the customer's other visits, as API-36 does (FR-TEXT-17).
    if (found.zone !== input.zone) await replanCustomerReminders(tx, { customerId: found.id, now: input.now });
    return found.id;
  }
  const [token] = await newInboxTokens(tx, 1);
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO world.customer (branch_id, name, name_search, mobile, texts_on, text_language, zone, street_id, house_number, lon, lat,
                                 customer_since, source, status, inbox_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date, 'online', 'active', $13) RETURNING id`,
    [input.branch, input.name, folded, input.mobile, input.textsOn, input.textLanguage, input.zone, input.streetId, input.house, input.point.lon, input.point.lat,
      localDateOf(input.now, input.zone), token]);
  return (ins.rows[0] as { id: string }).id;
}

/** API-113. */
export const bookOnlineHandler: Handler<Out<typeof bookRow>> = async (req, tx: Tx, hctx): Promise<ApiResult<Out<typeof bookRow>>> => {
  const p = req.params as In<typeof bookRow>;
  const street = await streetOf(tx, p.streetId);
  if (!street) return invalid;
  const service = (await tx.query<{ skill: string; bookable_online: boolean }>('SELECT skill, bookable_online FROM world.service_type WHERE id = $1', [p.serviceId])).rows[0];
  if (!service || !service.bookable_online) return invalid;
  const win = (await branchWindows(tx, street.branch_id)).find((x) => x.id === p.windowId);
  if (!win) return invalid;
  const blank = p.mobile === null || p.mobile.trim() === '';
  const mobile = blank ? null : toE164(p.mobile as string);
  if (!blank && mobile === null) return invalid;
  const now = req.demoNow;
  const today = localDateOf(now, street.zone);
  // FR-BOOK-9: the cutoff is checked before any write. Today and the past are never offered online; a date past the 21 days is a rule.
  if (!onlineOpen(p.date, street.zone, now)) return { ok: false, status: 409, code: 'booking_closed' };
  if (p.date > addDays(today, ONLINE_HORIZON_DAYS)) return { ok: false, status: 409, code: 'rule_refused', detail: { key: RULE.pastHorizon } };
  const zone = customerZoneFor({ browserZone: p.timeZone, branchZone: street.zone });
  const customerId = await customerFor(tx, {
    branch: street.branch_id, name: p.name.trim(), mobile, textsOn: mobile !== null && p.textsOn, textLanguage: p.textLanguage, zone, streetId: street.id, house: p.houseNumber,
    point: pointOf(street.points, p.houseNumber), now,
  });
  const ctx: OnlineContext = { actor: { kind: 'customer', userId: null }, at: new Date(now.epochMilliseconds) };
  const bookingToken = newBookingToken();
  try {
    // The same race-safe write as the office's API-28 (invariant 3): its locks, its room check, its job_change. Nothing here locks or counts.
    const job = await createJob(tx, ctx, { customerId, serviceId: p.serviceId, equipmentId: null, problem: null, date: p.date, windowId: p.windowId, technicianId: null, online: { bookingToken } });
    // FR-TEXT-1, SD-45: the confirmation in the booking's own transaction, as API-28 and API-24 send it; quiet hours may hold it. Then the reminder (section 6.4).
    await sendConfirmation(tx, textContext(hctx), { jobNumber: job.jobNumber, now });
    await planReminder(tx, { jobNumber: job.jobNumber, now });
    const w = (await tx.query<{ window_start: Date; window_end: Date }>('SELECT window_start, window_end FROM world.job WHERE job_number = $1', [job.jobNumber])).rows[0] as { window_start: Date; window_end: Date };
    return {
      ok: true, status: 201,
      // F-1084 (owner ruling Nov 8, "Branch zone"): the visit is at a branch-area house, so its window is told in the branch's zone, as the pre-booking calendar and the confirmation text tell it; the customer's browser zone is stored (FR-TEXT-17), never used to tell a time.
      data: { bookingToken, visit: { jobNumber: job.jobNumber, serviceId: job.serviceId, date: job.date, window: { start: wireIn(w.window_start, street.zone), end: wireIn(w.window_end, street.zone) }, zone: street.zone } },
    };
  } catch (e) {
    if (!(e instanceof WriteRefused)) throw e;
    if (e.code === 'window_full') {
      const open = await nearestOpen(tx, { branch: street.branch_id, zone: street.zone, serviceId: p.serviceId, install: service.skill === 'install', date: p.date, windowId: win.id, now });
      return { ok: false, status: 409, code: 'window_full', detail: { open } };
    }
    if (e.code === 'rule_refused') return { ok: false, status: 409, code: 'rule_refused', ...(e.detail === undefined ? {} : { detail: e.detail }) };
    if (e.code === 'validation_failed') return invalid;
    // day_closed and day_past cannot pass onlineOpen; a refusal the contract does not name is answered as its closest named code.
    return { ok: false, status: 409, code: 'booking_closed' };
  }
};

/** API-114. */
export const bookingSummaryHandler: Handler<Out<typeof summaryRow>> = async (req, tx: Tx) => {
  const { bookingToken } = req.params as In<typeof summaryRow>;
  const j = (await tx.query<{
    job_number: number; service_id: string; screen_label_key: string; price_text_key: string; date: string; window_start: Date; window_end: Date; branch_id: string; booked_at: Date;
    customer_id: string; name: string; mobile: string | null; texts_on: boolean; text_language: 'en' | 'es'; zone: string; job_zone: string; house_number: number; street: string; city: string; zip: string; inbox_token: string;
  }>(
    `SELECT j.job_number, j.service_id, s.screen_label_key, s.price_text_key, j.date::text AS date, j.window_start, j.window_end, j.branch_id, j.booked_at, c.id AS customer_id,
            c.name, c.mobile, c.texts_on, c.text_language, c.zone, j.zone AS job_zone, c.house_number, st.name AS street, st.city, st.zip, c.inbox_token
       FROM world.job j JOIN world.service_type s ON s.id = j.service_id JOIN world.customer c ON c.id = j.customer_id JOIN world.street st ON st.id = c.street_id
      WHERE j.booking_token = $1`, [bookingToken])).rows[0];
  if (!j) return notFound;
  const t = (await tx.query<{ status: Out<typeof summaryRow>['confirmationText'] extends infer C ? (C extends { status: infer S } ? S : never) : never; held_until: Date | null; delivered_at: Date | null; body: string }>(
    `SELECT status, held_until, delivered_at, body FROM world.outbox_text WHERE job_number = $1 AND kind = 'confirmation' ORDER BY created_at DESC, id DESC LIMIT 1`, [j.job_number])).rows[0];
  const to = j.mobile ?? '';
  return {
    ok: true, status: 200, data: {
      visit: {
        jobNumber: j.job_number, serviceId: j.service_id, serviceLabelKey: j.screen_label_key, priceTextKey: j.price_text_key, date: j.date,
        window: { start: wireIn(j.window_start, j.job_zone), end: wireIn(j.window_end, j.job_zone) }, zone: j.job_zone, branch: j.branch_id, bookedAt: wireIn(j.booked_at, j.job_zone), name: j.name,
        address: { houseNumber: j.house_number, street: j.street, city: j.city, zip: j.zip },
      },
      textsOn: j.texts_on, textLanguage: j.text_language,
      confirmationText: t ? { status: t.status, heldUntil: t.held_until ? wireIn(t.held_until, j.job_zone) : null, sentAt: t.delivered_at ? wireIn(t.delivered_at, j.job_zone) : null, to, body: t.body } : null,
      inboxUrl: j.mobile !== null && j.texts_on ? `/inbox/${encodeURIComponent(j.inbox_token)}` : null,
    },
  };
};
