// SPDX-License-Identifier: AGPL-3.0-or-later
// The 5 real templates in the real catalog, English and Spanish (REQUIREMENTS FR-TEXT-9, FR-TEXT-10, FR-TEXT-6,
// FR-TEXT-3, FR-TEXT-18; SPECIFICATIONS SD-17). Unit tests; G-CI8 also runs text-budget-check over them (every slot value).
import { describe, expect, it } from 'vitest';
import { Temporal } from '@bw/time';
import { analyzeSms, BOOKABLE_DAYS, isGsm7BasicChar, LANGS, runTextBudgetCheck, templatesFromCatalogs } from '@bw/sms';

import { catalogs } from '../../i18n/src/catalog.ts';
import { TEMPLATE_IDS, TEMPLATE_VARIANTS, type TemplateId } from './model.ts';
import { renderTemplate } from './render.ts';
import { foreignHosts, textCatalogOf, windowLabelZoned } from './slots.ts';
import { realSlotValues } from './testing/real-slots.ts';
import { checkParity } from '../../i18n/src/parity.ts';

const catalog = textCatalogOf(catalogs);
const LINK_HOST = 'bw.j7l.io';

/** SD-17's fixed-copy budgets per template: [English, Spanish]. */
const FIXED_BUDGET: Record<string, [number, number]> = {
  confirmation: [114, 106], reminder: [145, 140], on_the_way: [112, 112], late: [142, 142], r_reply: [117, 114],
};

/** A variant (F-650) keeps its kind's budget. */
const budgetOf = (id: TemplateId): string => (TEMPLATE_VARIANTS as Record<string, string>)[id] ?? id;

describe('the 5 templates and their variants', () => {
  // why: FR-TEXT-9
  it('exist in both languages under text.<kind>, and the check passes over every real slot value', () => {
    const { templates, failures } = templatesFromCatalogs(catalogs.en, catalogs.es);
    expect(failures).toEqual([]);
    expect(templates.map((t) => t.id).sort()).toEqual([...TEMPLATE_IDS].sort());
    const report = runTextBudgetCheck({ templates, days: BOOKABLE_DAYS, slots: realSlotValues(catalogs, LINK_HOST) });
    expect(report.failures).toEqual([]);
    expect(report.outcome).toBe('pass');
    expect(report.renders).toBeGreaterThan(100_000);
  });

  // why: FR-TEXT-9, F-419
  it('keeps each fixed copy inside the SD-17 budget of its language', () => {
    for (const kind of TEMPLATE_IDS) {
      LANGS.forEach((lang, i) => {
        const fixed = [...catalogs[lang][`text.${kind}`]!.replace(/\{[A-Za-z]+\}/g, '')].length;
        expect(fixed, `${kind} ${lang}`).toBeLessThanOrEqual(FIXED_BUDGET[budgetOf(kind)]![i]!);
      });
    }
  });

  // why: FR-TEXT-10
  it('uses the formal usted, keeps AM and PM, and holds no curly quote or apostrophe in any template', () => {
    for (const kind of ['confirmation', 'reminder', 'on_the_way', 'late', 'r_reply'] as const) {
      for (const lang of LANGS) expect(catalogs[lang][`text.${kind}`]).not.toMatch(/[‘’“”]/);
    }
    const es = TEMPLATE_IDS.map((k) => catalogs.es[`text.${k}`]!).join('\n');
    expect(es).toMatch(/\bSu\b/); // "su cita", "su tecnico": usted, never "tu"
    expect(es).toMatch(/\bResponda\b/);
    expect(es).toMatch(/\bElija\b/);
    expect(es).not.toMatch(/\b(tu|tus|tienes|responde|elige|ti)\b/i);
    expect(es).not.toMatch(/\ba\. ?m\.|\bp\. ?m\./i);
    // Every Spanish template is GSM-7 basic by wording (a-, i-, o- and u-acute never appear), and "Llegará" never does.
    expect([...es.replace(/\{[A-Za-z]+\}/g, '')].every((ch) => isGsm7BasicChar(ch))).toBe(true);
    expect(es).not.toMatch(/llegar[aá]/i);
    // The accents that stay are the allowed ones.
    expect(es).toContain('mañana');
    expect(es).toContain('técnico');
  });

  // why: FR-TEXT-10
  it('the catalog lint fails on a curly quote or apostrophe in a template, and passes the real catalog', () => {
    expect(checkParity(catalogs.en, catalogs.es)).toEqual([]);
    const curly = { ...catalogs.en, 'text.late': 'Brightwater: Don’t worry, {tech} is late.' };
    expect(checkParity(curly, { ...catalogs.es, 'text.late': 'Brightwater: {tech} se retrasa.' })).toContainEqual({ kind: 'curly-quote', key: 'text.late' });
  });

  // why: FR-TEXT-6
  it('renders each of the 5 templates in the customer language: Rosa Delgado\'s 5 texts arrive in Spanish', () => {
    const values = {
      weekday: 'mar', date: '15 de sep', window: '10 AM-12 PM', service: 'ajuste de calefactor', tech: 'Mario', arrival: '10:40 AM',
      mapLink: `${LINK_HOST}/m/7Hk2Ab9Q`, rescheduleLink: `${LINK_HOST}/r/7Hk2Ab9Q`, phone: '(614) 555-0100',
    };
    const es = TEMPLATE_IDS.map((k) => renderTemplate(catalog, k, 'es', values).body);
    const en = TEMPLATE_IDS.map((k) => renderTemplate(catalog, k, 'en', { ...values, weekday: 'Tue', date: 'Sep 15', window: '10 AM-12 PM' }).body);
    expect(es.join(' ')).toMatch(/Responda|Siga|Elija|Disculpe/);
    expect(en.join(' ')).toMatch(/Reply|Follow|Pick|Sorry/);
    for (const body of [...es, ...en]) expect(analyzeSms(body)).toMatchObject({ encoding: 'GSM-7', messages: 1 });
    for (const body of es) expect(body).not.toMatch(/\b(Reply|Follow|Sorry|Pick a new)\b/);
  });

  // why: FR-TEXT-9, FR-TEXT-10, F-419
  it('the Spanish confirmation and R-reply leave the weekday out on every day: the date names the day, and each fits 1 message at the SD-17 maxima', () => {
    const maxima = { date: 'x'.repeat(12), window: 'x'.repeat(14), service: 'x'.repeat(22), rescheduleLink: 'x'.repeat(20), phone: 'x'.repeat(14) };
    for (const kind of ['confirmation', 'r_reply'] as const) {
      const body = renderTemplate(catalog, kind, 'es', { weekday: 'sáb', date: '19 de sep', window: '8-10 AM', service: 'ajuste de calefactor', rescheduleLink: `${LINK_HOST}/r/7Hk2Ab9Q`, phone: '(614) 555-0100' }).body;
      expect(body).toContain('19 de sep');
      expect(body).not.toMatch(/\b(fin|sáb|sab|sábado|sabado)\b/i);
      const full = renderTemplate(catalog, kind, 'es', { weekday: 'xxxx', ...maxima }).body;
      expect(analyzeSms(full)).toMatchObject({ encoding: 'GSM-7', messages: 1 });
    }
    expect(renderTemplate(catalog, 'confirmation', 'es', { weekday: 'sáb', date: '19 de sep', window: 'de 8 a 10 AM', service: 'ajuste de calefactor' }).body).toContain('el técnico llega de 8 a 10 AM');
  });

  // why: FR-TEXT-3; F-490
  it('puts the arrival time and a live map link on the text link host in the on-the-way text, in both languages', () => {
    for (const lang of LANGS) {
      const body = renderTemplate(catalog, 'on_the_way', lang, { tech: 'Maria', arrival: '10:40 AM', mapLink: `${LINK_HOST}/m/7Hk2Ab9Q` }).body;
      expect(body).toContain('10:40 AM');
      expect(body).toContain(`${LINK_HOST}/m/7Hk2Ab9Q`);
      expect(body.match(/Maria/g)).toHaveLength(2); // the name in texts: the greeting and the link notice, in both languages (F-490: the English follow line is the story's 'Follow the van:', no name)
    }
  });

  // why: FR-TEXT-18
  it('every text any template can render names the text link host and no other host', () => {
    const slots = realSlotValues(catalogs, LINK_HOST);
    for (const kind of TEMPLATE_IDS) {
      for (const lang of LANGS) {
        const template = catalogs[lang][`text.${kind}`]!;
        const body = template.replace(/\{([A-Za-z]+)\}/g, (_, slot: string) =>
          slot === 'weekday' ? slots.weekday(lang, 6) : (slots.values[slot as keyof typeof slots.values][lang][0] as string),
        );
        expect(foreignHosts(body, LINK_HOST), `${kind} ${lang}: ${body}`).toEqual([]);
        if (kind === 'on_the_way' || kind === 'r_reply') expect(body).toContain(`${LINK_HOST}/`);
      }
    }
    // The detector bites: a template whose link is on another host is found.
    expect(foreignHosts('Follow live: bw.example.net/m/AbC12345', LINK_HOST)).toEqual(['bw.example.net']);
  });
});

describe('the window label names the branch zone (UD-15, owner ruling 037420bb, F-1122)', () => {
  const at = (iso: string) => Temporal.Instant.from(iso);
  // why: FR-TEXT-17, FR-TEXT-9 a text prints the window with the zone abbreviation at that time, and the longest label fits the window slot's maximum
  it('prints EDT in September and EST in November, and fits SD-17\'s window maximum of 15', () => {
    expect(windowLabelZoned(at('2026-09-15T14:00:00Z'), at('2026-09-15T16:00:00Z'), 'America/New_York')).toBe('10 AM-12 PM EDT');
    expect(windowLabelZoned(at('2026-11-03T15:00:00Z'), at('2026-11-03T17:00:00Z'), 'America/New_York')).toBe('10 AM-12 PM EST');
    expect(windowLabelZoned(at('2026-11-03T15:00:00Z'), at('2026-11-03T17:00:00Z'), 'America/New_York').length).toBeLessThanOrEqual(15);
  });

  // why: FR-TEXT-9 text-budget-check enumerates every window with each zone abbreviation, so SD-17's window maximum of 15 is checked on the label a text prints (F-1152)
  it('enumerates every real window with its zone for text-budget-check, none over 15 characters in English or 20 in Spanish', () => {
    const values = realSlotValues(catalogs, LINK_HOST).values.window;
    for (const lang of LANGS) {
      const max = lang === 'en' ? 15 : 20;
      expect(values[lang].every((w) => /E[DS]T$/.test(w) && w.length <= max)).toBe(true);
    }
    expect(values.en).toContain('10 AM-12 PM EST');
    expect(values.en).toContain('8-10 AM EDT');
    expect(values.es).toContain('de 10 AM a 12 PM EST');
    expect(values.es).toContain('de 8 a 10 AM EDT');
  });
});
