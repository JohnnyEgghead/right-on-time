// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1523: the slot samples sit at SD-17's maxima (the link host plus 8 characters, the Spanish window with its zone: 20 each).
// SC-05: the 10 sample texts (the 4 STORY.md section 2 texts plus the R-reply, each in English and Spanish) each fit 1 GSM-7
// message (FR-TEXT-9) and each Spanish text carries a passing review record from an agent other than its author (FR-LANG-4).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeSms } from '@bw/sms';

import { catalogs } from '../../i18n/src/catalog.ts';
import { authorsFromGit, checkReviews, parseReviewFile, valueHash } from '../../i18n/src/catalog-review.ts';
import { renderTemplate } from './render.ts';
import { textCatalogOf } from './slots.ts';

const catalog = textCatalogOf(catalogs);
const KINDS = ['confirmation', 'reminder', 'on_the_way', 'late', 'r_reply'] as const;
const values = {
  en: {
    weekday: 'Tue', date: 'Sep 15', window: '10 AM-12 PM', service: 'furnace tune-up', tech: 'Maria', arrival: '10:40 AM',
    mapLink: 'bw.j7l.io/m/7Hk2Xq9a', rescheduleLink: 'bw.j7l.io/r/7Hk2Xq9a', phone: '(614) 555-0100',
  },
  es: {
    weekday: 'mar', date: '15 de sep', window: 'de 10 AM a 12 PM EDT', service: 'ajuste de calefactor', tech: 'Maria', arrival: '10:40 AM',
    mapLink: 'bw.j7l.io/m/7Hk2Xq9a', rescheduleLink: 'bw.j7l.io/r/7Hk2Xq9a', phone: '(614) 555-0100',
  },
};

describe('SC-05 the 10 sample texts', () => {
  // why: FR-TEXT-9 SC-05 each of the 10 samples (5 templates in 2 languages) passes the segment check: GSM-7, 1 message
  it('renders as 1 GSM-7 message each, in English and Spanish', () => {
    const bodies = (['en', 'es'] as const).flatMap((lang) => KINDS.map((k) => renderTemplate(catalog, k, lang, values[lang]).body));
    expect(bodies).toHaveLength(10);
    for (const body of bodies) expect(analyzeSms(body)).toMatchObject({ encoding: 'GSM-7', messages: 1 });
  });

  // why: FR-LANG-4 SC-05 each Spanish sample text holds a current pass record from a reviewer who is not its author, and none is pending
  it('has every Spanish template with a current pass record from another agent, none pending', () => {
    const dir = fileURLToPath(new URL('../../i18n/catalog/', import.meta.url));
    const review = parseReviewFile(readFileSync(`${dir}es.review.json`, 'utf8'));
    const keys = KINDS.map((k) => `text.${k}`);
    expect(review.pending.filter((k) => keys.includes(k))).toEqual([]);
    for (const key of keys) {
      const rec = review.reviews[key];
      expect(rec?.v, key).toBe('pass');
      expect(rec?.h, key).toBe(valueHash(catalogs.es[key] as string));
    }
    const authors = authorsFromGit(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/i18n/catalog/es.json');
    const mine = checkReviews(catalogs.es, review, authors, { strict: true }).issues.filter((i) => keys.includes(i.key));
    expect(mine).toEqual([]);
  });
});
