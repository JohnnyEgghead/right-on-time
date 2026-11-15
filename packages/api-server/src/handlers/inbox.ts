// SPDX-License-Identifier: AGPL-3.0-or-later
// The customer's text inbox and Change your visit time pages (P5-INBOX; UI-SPECIFICATION 12.2 API-117, API-118, API-120, API-121;
// SCR-INB-01, SCR-CUS-06). A customer has no account: the inbox is found by its inbox token (UD-12), the reschedule page by its
// 8-character link token (SD-17). The 2 writes (a reply, a move) call the text services in their own transaction, as the office
// writes do: the move goes through rescheduleJob, which cancels the visit's unsent confirmations before the new one is made (SD-45,
// F-799, F-829).
import type { inboxMessages as inboxMessagesRow, inboxReply as inboxReplyRow, reschedulePage as reschedulePageRow, rescheduleVisit as rescheduleVisitRow } from '@bw/api';
import { worksOn } from '@bw/domain';
import { catalogs } from '@bw/i18n/src/catalog.ts';
import { cancelUnsentReminders, handleReply, planReminder, sendConfirmation, textCatalogOf, visitDayLabels, type TextContext } from '@bw/outbox';
import { addDays, atLocal, localDateOf, Temporal, toWire, type Instant } from '@bw/time';
import type { z } from 'zod';
import { branchTechnicians, branchWindows, officeDay, readDayKind, roomInWindow, serviceIsInstall, windowOffered } from '../office-writes/day.ts';
import { rescheduleJob, WriteRefused, type CustomerWriteContext } from '../office-writes/service.ts';
import type { ApiResult, Handler, HandlerContext, Tx, TokenCheck } from '../types.ts';

type Out<T extends { response: z.ZodType }> = z.infer<T['response']>;
type In<T extends { request: z.ZodType }> = z.infer<T['request']>;

const DEFAULT_LINK_HOST = 'bw.j7l.io';
const linkHostOf = (hctx: HandlerContext): string => hctx.settings.TEXT_LINK_HOST ?? DEFAULT_LINK_HOST;
const textContext = (hctx: HandlerContext): TextContext => ({ catalogs, linkHost: linkHostOf(hctx) });
const instant = (d: Date): Instant => Temporal.Instant.fromEpochMilliseconds(d.getTime());
const notFound = { ok: false as const, status: 404, code: 'not_found' as const };
const gone = (officePhone: string) => ({ ok: false as const, status: 410, code: 'gone' as const, detail: { officePhone } });

/** Online booking and the customer's reschedule offer the next 21 days after today (SD-27); a day closes at 5:00 PM the day before (FR-BOOK-9). */
export const RESCHEDULE_HORIZON_DAYS = 21;
const CUTOFF_TIME = '17:00';
/** A window shows its places left when its room is 3 or less (SD-27, GAP-23). */
const FEW_LEFT = 3;

/** The link-token checks (mount.ts): a known token passes; the handler decides gone. */
export const inboxTokenChecks: { inbox: TokenCheck; reschedule: TokenCheck } = {
  inbox: async (token, tx) => (await tx.query('SELECT 1 FROM world.customer WHERE inbox_token = $1', [token])).rows.length > 0,
  reschedule: async (token, tx) => (await tx.query(`SELECT 1 FROM world.link_token WHERE token = $1 AND kind = 'reschedule'`, [token])).rows.length > 0,
};

// ---- API-120 and API-121: the inbox ----

interface CustomerRow { id: string; name: string; mobile: string | null; texts_on: boolean; text_language: 'en' | 'es'; zone: string; office_phone: string }

async function customerByInbox(tx: Tx, token: string): Promise<CustomerRow | null> {
  return (await tx.query<CustomerRow>('SELECT c.id, c.name, c.mobile, c.texts_on, c.text_language, c.zone, b.office_phone FROM world.customer c JOIN world.branch b ON b.id = c.branch_id WHERE c.inbox_token = $1', [token])).rows[0] ?? null;
}

const hostPattern = (host: string): RegExp => new RegExp(`${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(m|r)/([0-9A-Za-z]{8})(?![0-9A-Za-z])`, 'g');

/** The links of a text body as paths on the running server (FR-TEXT-18): the live map `/m/<token>` and the reschedule page `/r/<token>`. */
export function linksOf(body: string, linkHost: string): Out<typeof inboxMessagesRow>['messages'][number]['links'] {
  return [...body.matchAll(hostPattern(linkHost))].map((m) => ({
    kind: m[1] === 'm' ? ('live_map' as const) : ('reschedule' as const),
    path: `/${m[1]}/${m[2]}`,
    text: m[0],
  }));
}

/** API-120: the customer's thread, in time order (CTL-INB-01-02), or only what is newer than `after` (the 5 s refresh). */
export const inboxMessagesHandler: Handler<Out<typeof inboxMessagesRow>> = async (req, tx: Tx, hctx) => {
  const p = req.params as In<typeof inboxMessagesRow>;
  const c = await customerByInbox(tx, p.inboxToken);
  if (!c) return notFound;
  const rows = (await tx.query<{ id: string; direction: 'in' | 'out'; body: string; at: Date; handling: 'confirmed' | 'reschedule_sent' | 'not_understood' | null }>(
    `SELECT id, direction, body, at, handling FROM world.inbox_message WHERE customer_id = $1 AND ($2::uuid IS NULL OR id > $2::uuid) ORDER BY at, id`,
    [c.id, p.after ?? null])).rows;
  const host = linkHostOf(hctx);
  return {
    ok: true,
    status: 200,
    data: {
      customer: { name: c.name, firstName: c.name.trim().split(/\s+/)[0] ?? c.name, officePhone: c.office_phone, hasMobile: c.mobile !== null, textsOn: c.texts_on, language: c.text_language, today: localDateOf(req.demoNow, c.zone) },
      messages: rows.map((m) => {
        const links = linksOf(m.body, host);
        const map = links.find((l) => l.kind === 'live_map');
        return {
          id: m.id, direction: m.direction, body: m.body, sentAt: toWire(instant(m.at), c.zone), handling: m.handling, links,
          liveMapPreview: map ? `${map.path}/preview` : null,
        };
      }),
    },
  };
};

/** API-121: a reply (C, R or free text). FR-TEXT-13: no reply controls for a customer with no mobile phone or with texts off, and the server refuses the same. */
export const inboxReplyHandler: Handler<Out<typeof inboxReplyRow>> = async (req, tx: Tx, hctx) => {
  const p = req.params as In<typeof inboxReplyRow>;
  const c = await customerByInbox(tx, p.inboxToken);
  if (!c) return notFound;
  if (c.mobile === null) return { ok: false, status: 409, code: 'no_mobile' };
  if (!c.texts_on) return { ok: false, status: 409, code: 'texts_off' };
  const r = await handleReply(tx, {
    customerId: c.id, body: p.body, now: req.demoNow, catalog: textCatalogOf(catalogs), dayLabels: visitDayLabels(catalogs), linkHost: linkHostOf(hctx),
  });
  return { ok: true, status: 201, data: { reply: { id: r.replyId, at: toWire(r.at, c.zone) }, handling: r.handling } };
};

// ---- API-117 and API-118: Change your visit time ----

interface LinkJob {
  token_ended: Date | null; token_expires: Date | null;
  job_number: number; status: string; version: number; branch_id: string; zone: string; date: string; window_id: string; window_start: Date; window_end: Date;
  service_id: string; screen_label_key: string; office_phone: string; customer_id: string;
}

/** `lock`: the link row is locked FOR UPDATE for this transaction (F-970: API-118's second move on 1 link waits, then reads it ended and answers gone). */
async function linkJob(tx: Tx, token: string, lock = false): Promise<LinkJob | null> {
  return (await tx.query<LinkJob>(
    `SELECT l.ended_at AS token_ended, l.expires_at AS token_expires, j.job_number, j.status, j.version, j.branch_id, j.zone, j.date::text AS date, j.window_id,
            j.window_start, j.window_end, j.service_id, s.screen_label_key, b.office_phone, j.customer_id
       FROM world.link_token l JOIN world.job j ON j.job_number = l.job_number JOIN world.service_type s ON s.id = j.service_id JOIN world.branch b ON b.id = j.branch_id
      WHERE l.token = $1 AND l.kind = 'reschedule'${lock ? ' FOR UPDATE OF l' : ''}`, [token])).rows[0] ?? null;
}

/**
 * Whether a reschedule link has ended (OA-62, SD-17, F-808): used or ended by a move (ended_at), expired 7 demo days after it was sent,
 * or its visit is Done, No one home or Canceled. An office reschedule ends the visit's open reschedule tokens in the write itself
 * (rescheduleJob), so this reads the token row.
 * Not liveMapLinkState (handlers/live-map.ts): that rule is the live map link's (on the way, a technician, a departure stamp); a reschedule link
 * lives from the booking text until its visit is closed, moved or 7 days old, so it is its own rule and this is its 1 place.
 */
export function rescheduleLinkEnded(j: Pick<LinkJob, 'token_ended' | 'token_expires' | 'status'>, now: Instant): boolean {
  if (j.token_ended !== null) return true;
  if (j.token_expires !== null && j.token_expires.getTime() <= now.epochMilliseconds) return true;
  return j.status === 'done' || j.status === 'no_one_home' || j.status === 'canceled';
}

const visitOf = (j: LinkJob): Out<typeof reschedulePageRow>['visit'] => ({
  serviceLabelKey: j.screen_label_key, day: j.date, window: { start: toWire(instant(j.window_start), j.zone), end: toWire(instant(j.window_end), j.zone) },
});

/** The days the online rules offer a visit that is moving (FR-BOOK-9, FR-BOOK-10, SD-27): the job's own place is not counted against it. */
async function onlineDays(tx: Tx, j: LinkJob, now: Instant): Promise<Out<typeof reschedulePageRow>['days']> {
  const today = localDateOf(now, j.zone);
  const windows = await branchWindows(tx, j.branch_id);
  const install = (await serviceIsInstall(tx, j.service_id)) ?? false;
  const technicians = await branchTechnicians(tx, j.branch_id);
  const days: Out<typeof reschedulePageRow>['days'] = [];
  for (let i = 1; i <= RESCHEDULE_HORIZON_DAYS; i++) {
    const date = addDays(today, i);
    // FR-BOOK-9: online booking closes at 5:00 PM on the day before the visit, in the branch's zone.
    if (now.epochMilliseconds >= atLocal(addDays(date, -1), CUTOFF_TIME, j.zone, 'compatible').epochMilliseconds) continue;
    const kind = await readDayKind(tx, j.branch_id, date);
    if (kind === 'sunday') continue;
    if (kind === 'saturday' && !technicians.some((t) => worksOn(t, date))) continue;
    const day = await officeDay(tx, { branch: j.branch_id, date, kind, install, excludeJob: j.job_number });
    const out = windows.filter((w) => windowOffered(w, kind)).map((w) => {
      const room = roomInWindow(day, w);
      const at = (hhmm: string) => toWire(Temporal.ZonedDateTime.from(`${date}T${hhmm.slice(0, 5)}:00[${j.zone}]`).toInstant(), j.zone);
      return { windowId: w.id, start: at(w.startLocal), end: at(w.endLocal), state: room > 0 ? ('open' as const) : ('full' as const), placesLeft: room > 0 && room <= FEW_LEFT ? room : null };
    });
    days.push({ date, mode: kind, state: out.some((w) => w.state === 'open') ? 'open' : 'full', windows: out });
  }
  return days;
}

/** API-117: the current visit and the days and windows the customer may move it to; 410 when the link has ended. */
export const reschedulePageHandler: Handler<Out<typeof reschedulePageRow>> = async (req, tx: Tx) => {
  const { rescheduleToken } = req.params as In<typeof reschedulePageRow>;
  const j = await linkJob(tx, rescheduleToken);
  if (!j) return notFound;
  if (rescheduleLinkEnded(j, req.demoNow)) return gone(j.office_phone);
  return { ok: true, status: 200, data: { visit: visitOf(j), officePhone: j.office_phone, days: await onlineDays(tx, j, req.demoNow) } };
};

/**
 * API-118: the customer's move. It goes through rescheduleJob (which cancels the visit's unsent confirmations in this transaction),
 * then sends the new confirmation and moves the reminder, as API-24's handler does (SD-45, F-782). The link ends with the move (SD-17).
 */
export const rescheduleVisitHandler: Handler<Out<typeof rescheduleVisitRow>> = async (req, tx: Tx, hctx): Promise<ApiResult<Out<typeof rescheduleVisitRow>>> => {
  const p = req.params as In<typeof rescheduleVisitRow>;
  const j = await linkJob(tx, p.rescheduleToken, true);
  if (!j) return notFound;
  if (rescheduleLinkEnded(j, req.demoNow)) return gone(j.office_phone);
  const days = await onlineDays(tx, j, req.demoNow);
  const day = days.find((d) => d.date === p.date);
  const win = day?.windows.find((w) => w.windowId === p.windowId);
  // A day or window the online rules do not offer (past the cutoff, a Sunday, beyond the horizon) is closed to the customer.
  if (!win) return { ok: false, status: 409, code: 'booking_closed' };
  const ctx: CustomerWriteContext = { actor: { kind: 'customer', userId: null }, at: new Date(req.demoNow.epochMilliseconds) };
  try {
    await rescheduleJob(tx, ctx, { jobNumber: j.job_number, date: p.date, windowId: p.windowId, baseVersion: j.version });
  } catch (e) {
    if (e instanceof WriteRefused && (e.code === 'window_full' || e.code === 'day_closed' || e.code === 'day_past')) {
      return { ok: false, status: 409, code: e.code === 'window_full' ? 'window_full' : 'booking_closed' };
    }
    throw e;
  }
  const sameVisit = j.date === p.date && j.window_id === p.windowId;
  const sent = sameVisit ? { ok: false as const } : await sendConfirmation(tx, textContext(hctx), { jobNumber: j.job_number, now: req.demoNow });
  const reminder = await planReminder(tx, { jobNumber: j.job_number, now: req.demoNow });
  if (reminder.planned) await cancelUnsentReminders(tx, j.job_number);
  await tx.query(`UPDATE world.link_token SET ended_at = $2 WHERE token = $1 AND ended_at IS NULL`, [p.rescheduleToken, req.demoNow.toString()]);
  const after = (await linkJob(tx, p.rescheduleToken))!;
  return { ok: true, status: 200, data: { visit: visitOf(after), outcome: { textSent: sent.ok } } };
};

export const inboxHandlers = (): Record<string, Handler<unknown>> => ({
  'API-117': reschedulePageHandler as Handler<unknown>,
  'API-118': rescheduleVisitHandler as Handler<unknown>,
  'API-120': inboxMessagesHandler as Handler<unknown>,
  'API-121': inboxReplyHandler as Handler<unknown>,
});
