// SPDX-License-Identifier: AGPL-3.0-or-later
// The REAL slot values for text-budget-check (G-CI8; F-162 item 3): every value the product can put in a slot, from the
// same formatter functions the triggers call and the same seed data the demo is built from. Test support, not product code
// (the image leaves out **/src/testing): it reads @bw/db's seed constants by path, like the other outbox test support.
import type { Lang, SlotValues } from '@bw/sms';
import { FOUR_HOUR_WINDOWS, planTechnicians, readRoster, BRANCHES, SERVICES, TWO_HOUR_WINDOWS } from '../../../db/src/seed/reference-data.ts';
import { arrivalLabel, dateLabel, serviceLabel, textLink, weekdayLabel, windowLabelZoned, type TextCatalogs } from '../slots.ts';
import { Temporal } from '@bw/time';

const perLang = <T>(f: (lang: Lang) => T): Record<Lang, T> => ({ en: f('en'), es: f('es') });

/** Every time of day the 5-minute rounded arrival can show, in the job's zone, as the text prints it. */
export function allArrivals(lang: Lang): string[] {
  const out: string[] = [];
  for (let m = 0; m < 24 * 60; m += 5) {
    const at = Temporal.ZonedDateTime.from({ timeZone: 'UTC', year: 2026, month: 1, day: 5, hour: Math.floor(m / 60), minute: m % 60 }).toInstant();
    out.push(arrivalLabel(at, 'UTC', lang).label);
  }
  return out;
}

/**
 * Every window label the text prints (F-1270): windowLabelZoned, the function the confirmation and reminder triggers call, over a real
 * window's instants in each distinct branch zone, on one summer and one winter date, so the abbreviation is the one the zone shows then.
 */
export function allWindows(lang: Lang, zones: readonly string[] = [...new Set(BRANCHES.map((b) => b.zone))]): string[] {
  const out = new Set<string>();
  for (const zone of zones) {
    for (const [year, month, day] of [[2026, 7, 15], [2026, 1, 15]] as const) {
      for (const [s, e] of [...TWO_HOUR_WINDOWS, ...FOUR_HOUR_WINDOWS]) {
        const at = (hour: number) => Temporal.ZonedDateTime.from({ timeZone: zone, year, month, day, hour }).toInstant();
        out.add(windowLabelZoned(at(s), at(e), zone, lang));
      }
    }
  }
  return [...out];
}

export function realSlotValues(catalogs: TextCatalogs, linkHost: string): SlotValues {
  const techs = [...new Set(planTechnicians(readRoster()).map((t) => t.nameInTexts))];
  const tokens = ['00000000', 'zzzzzzzz', 'AaZz09Aa'];
  return {
    weekday: (lang, day) => weekdayLabel(catalogs, lang, day),
    values: {
      date: perLang((lang) => Array.from({ length: 12 }, (_, i) => Array.from({ length: 31 }, (_, d) => dateLabel(catalogs, lang, i + 1, d + 1))).flat()),
      // The window prints the branch zone after it (UD-15, F-1152): the trigger's own formatter over each branch zone, summer and winter.
      window: perLang((lang) => allWindows(lang)),
      service: perLang((lang) => SERVICES.map((s) => serviceLabel(catalogs, lang, `service.${s.id}.text`))),
      tech: perLang(() => techs),
      arrival: perLang((lang) => allArrivals(lang)),
      mapLink: perLang(() => tokens.map((t) => textLink(linkHost, 'map', t))),
      rescheduleLink: perLang(() => tokens.map((t) => textLink(linkHost, 'reschedule', t))),
      phone: perLang(() => BRANCHES.map((b) => b.phone)),
    },
  };
}
