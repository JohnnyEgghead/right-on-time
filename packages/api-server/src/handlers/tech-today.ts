// SPDX-License-Identifier: AGPL-3.0-or-later
// API-100 Today's jobs (P5-TWA-TODAY; SPECIFICATIONS section 6.3 FR-TECH-1, FR-TECH-2, FR-TECH-12, FR-TECH-15, section 3 D-7):
// the signed-in technician's jobs for demo today in window, then planned arrival order, the van number, the day's start, and for
// each job what the Today card and the On my way sheet show. A job reassigned away by the office leaves the list at once; one the
// office moved back from On the way or On site reads Scheduled (owner ruling d0c0a033; assignJob writes the status). The phone number
// is sent only for a job of demo today, and every job here is (FR-AUTH-4). A technician-role user with no technician row (the
// reviewer sample user, F-252 item 7, F-278) gets an empty day, never an error.
import type { todayJobs as todayJobsRow } from '@bw/api';
import { areaName } from '@bw/domain';
import { catalogs } from '@bw/i18n/src/catalog.ts';
import { arrivalLabel, renderTemplate, textCatalogOf } from '@bw/outbox';
import { localDateOf, Temporal, toWire } from '@bw/time';
import type { z } from 'zod';
import { onTheWayEta } from '../tech-items/effects.ts';
import { initialsOf } from './board.ts';
import type { ApiResult, Handler, Tx } from '../types.ts';

type Out = z.infer<typeof todayJobsRow.response>;

const FALLBACK_ZONE = 'America/New_York';
/** The link slot of the preview: the link is made only when the text is sent (SPECIFICATIONS section 6.3). */
export const PREVIEW_LINK = 'bw.j7l.io/m/...';

const instant = (d: Date) => Temporal.Instant.fromEpochMilliseconds(d.getTime());
const wire = (d: Date, zone: string) => toWire(instant(d), zone);
const wireOrNull = (d: Date | null, zone: string) => (d ? wire(d, zone) : null);

interface Row {
  job_number: number; version: number; status: 'scheduled' | 'on_the_way' | 'on_site' | 'done' | 'no_one_home'; window_start: Date; window_end: Date;
  planned_arrival: Date | null; texted_arrival: Date | null; ended_at: Date | null; late_text_sent_at: Date | null; late_text_was_arrival: Date | null;
  screen_label_key: string; customer_id: string; name: string; mobile: string | null; home_phone: string | null; text_language: 'en' | 'es';
  house_number: number; street: string; city: string; zip: string; eq_type: string | null; eq_year: number | null; eq_details: string | null;
}

export const todayJobsHandler: Handler<Out> = async (req, tx: Tx): Promise<ApiResult<Out>> => {
  if (req.caller.kind !== 'staff') return { ok: false, status: 403, code: 'forbidden' };
  const tech = (await tx.query<{ id: string; name: string; name_in_texts: string; branch_id: string; zone: string; van: string | null; vehicle: string | null; skill: string | null; employee_number: string | null; office_phone: string }>(
    `SELECT t.id, t.name, t.name_in_texts, t.branch_id, b.zone, b.office_phone, v.number AS van, v.vehicle, t.primary_skill AS skill, u.employee_number
       FROM world.technician t JOIN world.branch b ON b.id = t.branch_id JOIN world."user" u ON u.id = t.user_id LEFT JOIN world.van v ON v.id = t.van_id WHERE t.user_id = $1`, [req.caller.userId])).rows[0];
  if (!tech) {
    // The reviewer sample user (F-252 item 7, F-278): no technician row, so an empty day; the person's own name and the branch phone still
    // answer, so the Me screen shows who is signed in (F-1018).
    const me = (await tx.query<{ name: string; employee_number: string | null; branch_id: string; zone: string; office_phone: string }>(
      `SELECT u.name, u.employee_number, u.branch_id, b.zone, b.office_phone FROM world."user" u JOIN world.branch b ON b.id = u.branch_id WHERE u.id = $1`, [req.caller.userId])).rows[0];
    const zone = me?.zone ?? FALLBACK_ZONE;
    return {
      ok: true, status: 200,
      data: {
        date: localDateOf(req.demoNow, zone), asOf: toWire(req.demoNow, zone), zone, van: null, startedAt: null, officePhone: me?.office_phone ?? '',
        technician: { name: me?.name ?? '', initials: initialsOf(me?.name ?? ''), employeeNumber: me?.employee_number ?? null, skill: null, branch: me?.branch_id ?? '' },
        jobs: [],
      },
    };
  }
  const zone = tech.zone;
  const date = localDateOf(req.demoNow, zone);
  const rows = (await tx.query<Row>(
    `SELECT j.job_number, j.version, j.status, j.window_start, j.window_end, j.planned_arrival, j.texted_arrival, j.ended_at, j.late_text_sent_at, j.late_text_was_arrival,
            s.screen_label_key, c.id AS customer_id, c.name, c.mobile, c.home_phone, c.text_language, c.house_number, st.name AS street, st.city, st.zip,
            e.type AS eq_type, e.year AS eq_year, e.details AS eq_details
       FROM world.job j JOIN world.service_type s ON s.id = j.service_id JOIN world.customer c ON c.id = j.customer_id JOIN world.street st ON st.id = c.street_id
       LEFT JOIN world.equipment e ON e.id = j.equipment_id
      WHERE j.technician_id = $1 AND j.date = $2 AND j.status <> 'canceled'
      ORDER BY j.window_start, j.planned_arrival NULLS LAST, j.job_number`, [tech.id, date])).rows;
  const started = (await tx.query<{ started_at: Date }>('SELECT started_at FROM world.technician_day WHERE technician_id = $1 AND date = $2', [tech.id, date])).rows[0];
  const catalog = textCatalogOf(catalogs);
  const jobs: Out['jobs'] = [];
  for (const [i, r] of rows.entries()) {
    const last = (await tx.query<{ date: string; what: string | null; label: string | null }>(
      `SELECT date::text AS date, what, label FROM (
         SELECT date, service_text AS what, NULL::text AS label FROM world.past_visit WHERE customer_id = $1
         UNION ALL
         SELECT j.date, NULL, s.screen_label_key FROM world.job j JOIN world.service_type s ON s.id = j.service_id
          WHERE j.customer_id = $1 AND j.status = 'done' AND j.job_number <> $2) v
        ORDER BY date DESC LIMIT 1`, [r.customer_id, r.job_number])).rows[0];
    const note = (await tx.query<{ body: string }>('SELECT body FROM world.note WHERE customer_id = $1 ORDER BY entered_at DESC, id DESC LIMIT 1', [r.customer_id])).rows[0];
    let preview: Out['jobs'][number]['onMyWayPreview'] = null;
    if (r.status === 'scheduled') {
      const eta = await onTheWayEta(tx, { jobNumber: r.job_number }, req.demoNow);
      const arrival = arrivalLabel(eta, zone, r.text_language);
      preview = {
        language: r.text_language, arrival: toWire(arrival.rounded, zone),
        text: renderTemplate(catalog, 'on_the_way', r.text_language, { tech: tech.name_in_texts, arrival: arrival.label, mapLink: PREVIEW_LINK }).body,
      };
    }
    const late = r.late_text_sent_at && r.texted_arrival
      ? { sentAt: wire(r.late_text_sent_at, zone), eta: wire(r.texted_arrival, zone), wasEta: wireOrNull(r.late_text_was_arrival, zone) }
      : null;
    const phone = r.mobile ?? r.home_phone;
    jobs.push({
      jobNumber: r.job_number, version: r.version, position: i + 1, status: r.status,
      window: { start: wire(r.window_start, zone), end: wire(r.window_end, zone) },
      customer: { name: r.name, language: r.text_language, ...(phone ? { phone } : {}) },
      address: `${r.house_number} ${r.street}, ${r.city}`, area: areaName(r.city, r.zip), serviceLabelKey: r.screen_label_key,
      equipment: r.eq_type ? { type: r.eq_type, year: r.eq_year, details: r.eq_details } : null,
      lastVisit: last ? { date: last.date, what: last.what, labelKey: last.label } : null,
      customerNote: note?.body ?? null,
      plannedArrival: wireOrNull(r.planned_arrival, zone), textedArrival: wireOrNull(r.texted_arrival, zone), endedAt: wireOrNull(r.ended_at, zone),
      lateText: late, onMyWayPreview: preview,
    });
  }
  return {
    ok: true, status: 200,
    data: { date, asOf: toWire(req.demoNow, zone), zone, van: tech.van ? { number: tech.van, vehicle: tech.vehicle ?? '' } : null, startedAt: started ? wire(started.started_at, zone) : null, officePhone: tech.office_phone,
      technician: { name: tech.name, initials: initialsOf(tech.name), employeeNumber: tech.employee_number, skill: tech.skill, branch: tech.branch_id }, jobs },
  };
};
