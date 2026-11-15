// SPDX-License-Identifier: AGPL-3.0-or-later
// The customers area (P4-CUSTOMERS; UI-SPECIFICATION 12.2 API-34, API-35, API-36, API-111, API-139; SPECIFICATIONS FR-DISP-7, FR-DISP-29
// to FR-DISP-32, SD-23):
//   API-34   search by name, street or phone. The typed text is folded as customer.name_search is (@bw/db foldStreetName: accents out,
//            apostrophes dropped, other runs of non-alphanumerics 1 space), so "obrien" finds "O'Brien", "O'Brien-Miller" and "OBrien"
//            (FR-DISP-7). A phone text is compared by its digits. The text arrives in the body, is bound as a parameter and is never
//            logged (NFR-05). Merged customers are left out. Best match first: exact name, then a name that starts with the text.
//   API-35   the customer page's one read.
//   API-36   edit contact, street and house number (re-derived per SD-23), text language, texts on, time zone. A membership field is
//            refused (FR-DISP-32).
//   API-111  street search by prefix and trigram over street.name_search (at most STREET_CAP results).
//   API-139  create a customer from a listed street plus a house number: the street gives the branch, ZIP code and map position,
//            the branch gives the time zone, source is `office` (FR-DISP-29).
import { CUSTOMER_PAGE, decodeCursor, encodeCursor, STREET_CAP, type createCustomer as createRow, type customerDetail as detailRow, type editCustomer as editRow, type searchCustomers as searchRow, type searchStreets as streetsRow } from '@bw/api';
import { deleteTracksNaming, foldStreetName } from '@bw/db';
import { newInboxTokens, toE164 } from '@bw/import';
import { replanCustomerReminders } from '@bw/outbox';
import { areaName } from '@bw/domain';
import { localDateOf, Temporal, toWire } from '@bw/time';
import type { z } from 'zod';
import { branchTechnicians } from '../office-writes/day.ts';
import type { ApiResult, Handler, Tx } from '../types.ts';
import { branchOf, dayJobs, etas } from './board.ts';

type Out<T extends { response: z.ZodType }> = z.infer<T['response']>;
type In<T extends { request: z.ZodType }> = z.input<T['request']>;

const instant = (d: Date) => Temporal.Instant.fromEpochMilliseconds(d.getTime());
const refuse = <T>(status: number, code: 'not_found' | 'rule_refused' | 'validation_failed'): ApiResult<T> => ({ ok: false, status, code });

/** A phone text is searched by its digits: only digits and phone punctuation, at least 3 digits. */
export function phoneDigits(query: string): string | null {
  if (!/^[\d\s().+-]+$/.test(query)) return null;
  const d = query.replace(/\D/g, '');
  return d.length >= 3 ? d : null;
}

const STATUS_LIVE = `('scheduled', 'on_the_way', 'on_site')`;

interface SearchRow {
  id: string; name: string; mobile: string | null; texts_on: boolean; text_language: 'en' | 'es'; customer_since: string;
  house_number: number; street: string; city: string; zip: string; member: boolean;
  lv_date: string | null; lv_service: string | null; lv_service_id: string | null;
  nv_job: number | null; nv_day: string | null; nv_start: Date | null; nv_end: Date | null; nv_zone: string | null; nv_service: string | null; nv_status: 'scheduled' | 'on_the_way' | 'on_site' | null; nv_tech: string | null;
}

export const searchCustomersHandler: Handler<Out<typeof searchRow>> = async (req, tx: Tx) => {
  const p = req.params as In<typeof searchRow> & { filters: NonNullable<In<typeof searchRow>['filters']> };
  const params: unknown[] = [];
  const bind = (v: unknown) => (params.push(v), `$${params.length}`);
  const where: string[] = [`c.status = 'active'`];
  const folded = foldStreetName(p.query);
  const digits = phoneDigits(p.query);
  const terms: string[] = [];
  if (folded !== '') {
    const f = bind(folded);
    terms.push(`c.name_search LIKE '%' || ${f} || '%'`, `s.name_search LIKE '%' || ${f} || '%'`);
    const m = /^(\d{1,5}) (.+)$/.exec(folded);
    if (m) terms.push(`(c.house_number = ${bind(Number(m[1]))} AND s.name_search LIKE '%' || ${bind(m[2] as string)} || '%')`);
  }
  if (digits !== null) {
    const d = bind(digits);
    terms.push(`regexp_replace(coalesce(c.mobile, ''), '\\D', '', 'g') LIKE '%' || ${d} || '%'`, `regexp_replace(coalesce(c.home_phone, ''), '\\D', '', 'g') LIKE '%' || ${d} || '%'`);
  }
  if (terms.length > 0) where.push(`(${terms.join(' OR ')})`);
  else if (p.query !== '') where.push('false'); // text with nothing to match on (only punctuation)
  const f = p.filters;
  if (f.branch) where.push(`c.branch_id = ${bind(f.branch)}`);
  if (f.city) where.push(`s.city = ${bind(f.city)}`);
  if (f.plan === 'comfort_club') where.push('EXISTS (SELECT 1 FROM world.membership m WHERE m.customer_id = c.id)');
  if (f.plan === 'none') where.push('NOT EXISTS (SELECT 1 FROM world.membership m WHERE m.customer_id = c.id)');
  if (f.textLanguage) where.push(`c.text_language = ${bind(f.textLanguage)}`);
  if (f.upcomingVisit === true) where.push(`EXISTS (SELECT 1 FROM world.job j WHERE j.customer_id = c.id AND j.status IN ${STATUS_LIVE})`);
  if (f.upcomingVisit === false) where.push(`NOT EXISTS (SELECT 1 FROM world.job j WHERE j.customer_id = c.id AND j.status IN ${STATUS_LIVE})`);
  const from = 'FROM world.customer c JOIN world.street s ON s.id = c.street_id WHERE ' + where.join(' AND ');
  const total = Number((await tx.query<{ n: string }>(`SELECT count(*) AS n ${from}`, params)).rows[0]?.n ?? 0);
  // F-675 (the F-260 class): a cursor is this handler's own offset, a whole number written by encodeCursor below. A
  // forged or malformed one is refused, never read as 0 or as Infinity, and the offset is bound, not written into the text.
  let offset = 0;
  if (p.cursor != null) {
    const cursor = decodeCursor(p.cursor);
    if (cursor === null || !/^(0|[1-9]\d{0,8})$/.test(cursor.sortKey)) return refuse(422, 'validation_failed');
    offset = Number(cursor.sortKey);
  }
  const limit = p.limit ?? CUSTOMER_PAGE;
  const rank = folded === '' ? '' : `(c.name_search = ${bind(folded)}) DESC, (c.name_search LIKE ${bind(`${folded}%`)}) DESC, `;
  const rows = await tx.query<SearchRow>(
    `WITH page AS (
       SELECT c.id, c.name, c.mobile, c.texts_on, c.text_language, c.customer_since::text AS customer_since, c.house_number,
              s.name AS street, s.city, s.zip, c.name_search
         ${from} ORDER BY ${rank}c.name_search, c.id OFFSET ${bind(offset)} LIMIT ${bind(limit + 1)})
     SELECT page.id, page.name, page.mobile, page.texts_on, page.text_language, page.customer_since, page.house_number, page.street, page.city, page.zip,
            EXISTS (SELECT 1 FROM world.membership m WHERE m.customer_id = page.id) AS member,
            lv.date::text AS lv_date, lv.service AS lv_service, lv.service_id AS lv_service_id,
            nv.job_number AS nv_job, nv.date::text AS nv_day, nv.window_start AS nv_start, nv.window_end AS nv_end, nv.zone AS nv_zone,
            nv.service_id AS nv_service, nv.status AS nv_status, nv.tech AS nv_tech
       FROM page
       LEFT JOIN LATERAL (
         SELECT x.date, x.service, x.service_id FROM (
           SELECT v.date, v.service_text AS service, NULL::text AS service_id FROM world.past_visit v WHERE v.customer_id = page.id
           UNION ALL
           SELECT j.date, j.service_id AS service, j.service_id FROM world.job j WHERE j.customer_id = page.id AND j.status = 'done') x
         ORDER BY x.date DESC LIMIT 1) lv ON true
       LEFT JOIN LATERAL (
         SELECT j.job_number, j.date, j.window_start, j.window_end, j.zone, j.service_id, j.status, t.name AS tech
           FROM world.job j LEFT JOIN world.technician t ON t.id = j.technician_id
          WHERE j.customer_id = page.id AND j.status IN ${STATUS_LIVE}
          ORDER BY j.date, j.window_start, j.job_number LIMIT 1) nv ON true
      ORDER BY ${rank.replaceAll('c.', 'page.')}page.name_search, page.id`,
    params);
  const more = rows.rows.length > limit;
  const cities = (await tx.query<{ city: string }>(
    f.branch ? 'SELECT DISTINCT city FROM world.street WHERE branch_id = $1 ORDER BY city' : 'SELECT DISTINCT city FROM world.street ORDER BY city', f.branch ? [f.branch] : [])).rows.map((x) => x.city);
  return {
    ok: true, status: 200,
    data: {
      customers: rows.rows.slice(0, limit).map((r) => ({
        id: r.id, name: r.name, area: areaName(r.city, r.zip),
        address: { houseNumber: r.house_number, street: r.street, city: r.city, zip: r.zip },
        mobile: r.mobile, textsOn: r.texts_on, language: r.text_language, plan: r.member ? 'comfort_club' as const : null, customerSince: r.customer_since,
        lastVisit: r.lv_date === null ? null : { date: r.lv_date, service: r.lv_service ?? '', serviceId: r.lv_service_id },
        nextVisit: r.nv_job === null || r.nv_start === null || r.nv_end === null || r.nv_zone === null ? null : {
          jobNumber: r.nv_job, day: r.nv_day as string,
          window: { start: toWire(instant(r.nv_start), r.nv_zone), end: toWire(instant(r.nv_end), r.nv_zone) },
          serviceId: r.nv_service as string, status: r.nv_status as 'scheduled', technician: r.nv_tech,
        },
      })),
      total,
      next: more ? encodeCursor(String(offset + limit), '-') : null,
      cities,
    },
  };
};

const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

export const customerDetailHandler: Handler<Out<typeof detailRow>> = async (req, tx: Tx) => {
  const { customerId } = req.params as In<typeof detailRow>;
  const c = await tx.query<{
    id: string; name: string; branch_id: string; mobile: string | null; home_phone: string | null; email: string | null; getting_in: string | null;
    home_type: string | null; texts_on: boolean; text_language: 'en' | 'es'; zone: string; street_id: string; house_number: number; lon: number; lat: number;
    customer_since: string; source: 'import' | 'online' | 'office'; street: string; city: string; zip: string;
  }>(
    `SELECT c.id, c.name, c.branch_id, c.mobile, c.home_phone, c.email, c.getting_in, c.home_type, c.texts_on, c.text_language, c.zone, c.street_id,
            c.house_number, c.lon, c.lat, c.customer_since::text AS customer_since, c.source, s.name AS street, s.city, s.zip
       FROM world.customer c JOIN world.street s ON s.id = c.street_id WHERE c.id = $1 AND c.status = 'active'`, [customerId]);
  const r = c.rows[0];
  if (!r) return refuse(404, 'not_found');
  const today = localDateOf(req.demoNow, r.zone);
  const imported = r.source === 'import'
    ? (await tx.query<{ finished_at: Date | null }>(`SELECT finished_at FROM world.import_run WHERE kind = 'real' AND status = 'done' ORDER BY finished_at DESC LIMIT 1`)).rows[0]?.finished_at ?? null
    : null;
  const m = (await tx.query<{ since: string; renews: string; benefits_key: string }>(
    'SELECT since::text, renews::text, benefits_key FROM world.membership WHERE customer_id = $1', [customerId])).rows[0];
  const notes = await tx.query<{ id: string; author_kind: 'office' | 'technician'; name: string; entered_at: Date }>(
    `SELECT n.id, n.author_kind, u.name, n.entered_at, n.body AS text
       FROM world.note n JOIN world."user" u ON u.id = n.author_user_id
      WHERE n.customer_id = $1 OR n.job_number IN (SELECT job_number FROM world.job WHERE customer_id = $1)
      ORDER BY n.entered_at DESC, n.id LIMIT 50`, [customerId]);
  const equipment = await tx.query<{ id: string; type: string; year: number | null; location: string | null; details: string | null }>(
    'SELECT id, type, year, location, details FROM world.equipment WHERE customer_id = $1 ORDER BY id', [customerId]);
  const upcoming = await tx.query<{
    job_number: number; day: string; window_start: Date; window_end: Date; zone: string; service_id: string; status: 'scheduled' | 'on_the_way' | 'on_site';
    eta: Date | null; tech: string | null; skill: string | null; van: string | null; branch_id: string; technician_id: string | null;
  }>(
    `SELECT j.branch_id, j.technician_id, j.job_number, j.date::text AS day, j.window_start, j.window_end, j.zone, j.service_id, j.status, coalesce(j.texted_arrival, j.planned_arrival) AS eta,
            t.name AS tech, t.primary_skill AS skill, v.number AS van
       FROM world.job j LEFT JOIN world.technician t ON t.id = j.technician_id LEFT JOIN world.van v ON v.id = t.van_id
      WHERE j.customer_id = $1 AND j.status IN ${STATUS_LIVE} ORDER BY j.date, j.window_start, j.job_number`, [customerId]);
  // F-869 (UI-SPECIFICATION 12.2 API-35 timing; SD-15): the timing of today's visits, from the same ETA day the board and the jobs list use.
  const timingOf = new Map<number, 'on_time' | 'at_risk' | 'late'>();
  const dueToday = upcoming.rows.filter((j) => j.day === today && j.technician_id !== null);
  for (const branchId of new Set(dueToday.map((j) => j.branch_id))) {
    const branch = await branchOf(tx, branchId);
    if (!branch) continue;
    const people = new Map((await branchTechnicians(tx, branchId)).map((x) => [x.id, x] as const));
    const todays = await dayJobs(tx, branchId, today);
    for (const id of new Set(dueToday.filter((j) => j.branch_id === branchId).map((j) => j.technician_id as string))) {
      const person = people.get(id);
      if (!person) continue;
      const e = await etas(tx, branch, person, today, todays.filter((j) => j.technician_id === id), req.demoNow.epochMilliseconds);
      for (const [n, v] of e) timingOf.set(n, v.timing);
    }
  }
  // What was done (F-670; SPECIFICATIONS section 3 past_visit.work_done): an old visit's work-done cell, a done job's
  // work_done_line texts (a technician's finish writes them) in seq order. A blank cell or no lines is none recorded.
  const history = await tx.query<{ date: string; service: string; service_id: string | null; technician: string | null; old: boolean; job_number: number | null; work_done: string[] }>(
    `SELECT x.date::text AS date, x.service, x.service_id, x.technician, x.old, x.job_number, x.work_done FROM (
       SELECT v.date, v.service_text AS service, NULL::text AS service_id, v.technician_name AS technician, true AS old, NULL::int AS job_number, v.id::text AS k,
              CASE WHEN btrim(coalesce(v.work_done, '')) = '' THEN ARRAY[]::text[] ELSE ARRAY[v.work_done] END AS work_done
         FROM world.past_visit v WHERE v.customer_id = $1
       UNION ALL
       SELECT j.date, j.service_id, j.service_id, t.name, false, j.job_number, j.job_number::text,
              coalesce((SELECT array_agg(w.text ORDER BY w.seq) FROM world.work_done_line w WHERE w.job_number = j.job_number), ARRAY[]::text[])
         FROM world.job j LEFT JOIN world.technician t ON t.id = j.technician_id WHERE j.customer_id = $1 AND j.status = 'done') x
      ORDER BY x.date DESC, x.k DESC LIMIT 500`, [customerId]);
  const texts = await tx.query<{ at: Date; kind: string; direction: 'out' | 'in'; status: string | null }>(
    `SELECT x.at, x.kind, x.direction, x.status FROM (
       SELECT coalesce(o.delivered_at, o.created_at) AS at, o.created_at AS made, o.id, o.kind, 'out'::text AS direction, o.status FROM world.outbox_text o WHERE o.customer_id = $1
       UNION ALL
       SELECT i.at, i.at, i.id, 'reply'::text, 'in'::text, NULL::text FROM world.inbox_message i WHERE i.customer_id = $1 AND i.direction = 'in') x
      ORDER BY x.at DESC, x.made DESC, x.id DESC LIMIT 6`, [customerId]);
  return {
    ok: true, status: 200,
    data: {
      id: r.id, name: r.name, branch: r.branch_id, area: areaName(r.city, r.zip),
      contact: { mobile: r.mobile, homePhone: r.home_phone, email: r.email, textsOn: r.texts_on },
      language: r.text_language, zone: r.zone,
      address: { streetId: r.street_id, houseNumber: r.house_number, street: r.street, city: r.city, zip: r.zip, homeType: r.home_type, gettingIn: r.getting_in },
      position: { lon: r.lon, lat: r.lat },
      source: r.source,
      importedAt: imported === null ? null : toWire(instant(imported), r.zone),
      customerSince: r.customer_since,
      membership: m ? { since: m.since, renews: m.renews, benefitsKey: m.benefits_key } : null,
      notes: notes.rows.map((n) => ({ id: n.id, authorKind: n.author_kind, author: n.name, at: toWire(instant(n.entered_at), r.zone), text: (n as unknown as { text: string }).text })),
      equipment: equipment.rows,
      upcoming: upcoming.rows.map((j) => ({
        jobNumber: j.job_number, day: j.day,
        window: { start: toWire(instant(j.window_start), j.zone), end: toWire(instant(j.window_end), j.zone) },
        serviceId: j.service_id, status: j.status, timing: timingOf.get(j.job_number) ?? null,
        eta: j.eta !== null && j.day === today ? toWire(instant(j.eta), j.zone) : null,
        technician: j.tech === null ? null : { name: j.tech, initials: initialsOf(j.tech), van: j.van, skill: j.skill ?? '' },
      })),
      history: history.rows.map((h) => ({ date: h.date, service: h.service, serviceId: h.service_id, technician: h.technician, old: h.old, jobNumber: h.job_number, workDone: h.work_done })),
      recentTexts: texts.rows.map((t) => ({ at: toWire(instant(t.at), r.zone), kind: t.kind, direction: t.direction, status: t.status })),
    },
  };
};

/** The street an address is on, or null when the id is not on the list (validation_failed). */
export async function streetOf(tx: Tx, streetId: string) {
  const s = await tx.query<{ id: string; branch_id: string; points: [number, number][]; zip: string; zone: string }>(
    'SELECT s.id, s.branch_id, s.points, s.zip, b.zone FROM world.street s JOIN world.branch b ON b.id = s.branch_id WHERE s.id = $1', [streetId]);
  return s.rows[0] ?? null;
}

/** SD-23: an address's point is the street's points[(house number - 1) mod point count]. */
export const pointOf = (points: [number, number][], house: number): { lon: number; lat: number } => {
  const p = points[(house - 1) % points.length] as [number, number];
  return { lon: p[0], lat: p[1] };
};

export const editCustomerHandler: Handler<Out<typeof editRow>> = async (req, tx: Tx) => {
  const p = req.params as In<typeof editRow> & { customerId: string };
  if (p.membership !== undefined) return refuse(409, 'rule_refused');
  const cur = (await tx.query<{ id: string; name: string; branch_id: string; zone: string; street_id: string; house_number: number; mobile: string | null; lon: number; lat: number }>(
    `SELECT id, name, branch_id, zone, street_id, house_number, mobile, lon, lat FROM world.customer WHERE id = $1 AND status = 'active' FOR UPDATE`, [p.customerId])).rows[0];
  if (!cur) return refuse(404, 'not_found');
  const set: string[] = [];
  const args: unknown[] = [p.customerId];
  const put = (col: string, v: unknown) => (args.push(v), set.push(`${col} = $${args.length}`));
  let mobile = cur.mobile;
  let moved = false;
  if (p.name !== undefined) {
    if (p.name.trim() === '') return refuse(422, 'validation_failed');
    put('name', p.name.trim());
    put('name_search', foldStreetName(p.name));
  }
  if (p.mobile !== undefined) {
    mobile = p.mobile === null || p.mobile.trim() === '' ? null : toE164(p.mobile);
    if (mobile === null && p.mobile !== null && p.mobile.trim() !== '') return refuse(422, 'validation_failed');
    put('mobile', mobile);
  }
  if (p.streetId !== undefined || p.houseNumber !== undefined) {
    const street = await streetOf(tx, p.streetId ?? cur.street_id);
    if (!street) return refuse(422, 'validation_failed');
    const house = p.houseNumber ?? cur.house_number;
    const pt = pointOf(street.points, house);
    put('street_id', street.id);
    put('house_number', house);
    put('branch_id', street.branch_id);
    put('lon', pt.lon);
    put('lat', pt.lat);
    moved = pt.lon !== cur.lon || pt.lat !== cur.lat;
  }
  if (p.textLanguage !== undefined) put('text_language', p.textLanguage);
  if (p.timeZone !== undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: p.timeZone });
    } catch {
      return refuse(422, 'validation_failed');
    }
    put('zone', p.timeZone);
  }
  // Texts need a mobile phone (FR-TEXT-13): a customer with none has texts off, whatever was asked.
  if (p.textsOn !== undefined || (p.mobile !== undefined && mobile === null)) put('texts_on', mobile !== null && (p.textsOn ?? true));
  if (set.length > 0) await tx.query(`UPDATE world.customer SET ${set.join(', ')} WHERE id = $1`, args);
  // SD-49: an address edit that moves the customer's point moves the point each of their jobs is driven to, so every track naming one of
  // those jobs, baked or live, goes; the route source routes the new point on its next read (P6-LIVE-ROUTING).
  if (moved) await deleteTracksNaming(tx, (await tx.query<{ job_number: number }>('SELECT job_number FROM world.job WHERE customer_id = $1', [p.customerId])).rows.map((r) => r.job_number));
  // FR-TEXT-17: a zone edit moves the reminder of every live future visit of the customer (the note under the zone Save says so).
  if (p.timeZone !== undefined && p.timeZone !== cur.zone) await replanCustomerReminders(tx, { customerId: p.customerId, now: req.demoNow });
  const after = (await tx.query<{ id: string; name: string; branch_id: string; zone: string }>('SELECT id, name, branch_id, zone FROM world.customer WHERE id = $1', [p.customerId])).rows[0] as { id: string; name: string; branch_id: string; zone: string };
  return { ok: true, status: 200, data: { id: after.id, name: after.name, branch: after.branch_id, zone: after.zone } };
};

export const searchStreetsHandler: Handler<Out<typeof streetsRow>> = async (req, tx: Tx) => {
  const { query } = req.params as In<typeof streetsRow>;
  const folded = foldStreetName(query);
  if (folded === '') return { ok: true, status: 200, data: { streets: [] } };
  const r = await tx.query<{ id: string; name: string; city: string; zip: string; branch_id: string }>(
    `SELECT id, name, city, zip, branch_id FROM world.street
      WHERE name_search LIKE $1 || '%' OR name_search LIKE '% ' || $1 || '%' OR name_search % $1
      ORDER BY (name_search LIKE $1 || '%') DESC, similarity(name_search, $1) DESC, name_search, city, zip LIMIT ${STREET_CAP}`, [folded]);
  return { ok: true, status: 200, data: { streets: r.rows.map((s) => ({ streetId: s.id, name: s.name, city: s.city, zip: s.zip, branch: s.branch_id })) } };
};

export const createCustomerHandler: Handler<Out<typeof createRow>> = async (req, tx: Tx) => {
  const p = req.params as In<typeof createRow>;
  const street = await streetOf(tx, p.streetId);
  if (!street) return refuse(422, 'validation_failed');
  const name = p.name.trim();
  if (name === '') return refuse(422, 'validation_failed');
  const blank = p.mobile === null || p.mobile.trim() === '';
  const mobile = blank ? null : toE164(p.mobile as string);
  if (!blank && mobile === null) return refuse(422, 'validation_failed');
  const pt = pointOf(street.points, p.houseNumber);
  const [token] = await newInboxTokens(tx, 1);
  const since = localDateOf(req.demoNow, street.zone);
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO world.customer (branch_id, name, name_search, mobile, texts_on, text_language, zone, street_id, house_number, lon, lat,
                                 customer_since, source, status, inbox_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date, 'office', 'active', $13) RETURNING id`,
    [street.branch_id, name, foldStreetName(name), mobile, mobile !== null && p.textsOn, p.textLanguage, street.zone, street.id, p.houseNumber, pt.lon, pt.lat, since, token]);
  return { ok: true, status: 201, data: { id: (ins.rows[0] as { id: string }).id, name, branch: street.branch_id, zip: street.zip, zone: street.zone, position: pt } };
};
