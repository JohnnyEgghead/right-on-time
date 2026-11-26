// SPDX-License-Identifier: AGPL-3.0-or-later
// The words of the billing pages that the page and the server must say alike: the pretend billing invoice's line facts (API-66) against the
// link's composer and the catalog (F-593), and the Fixed table's row words, which the page and the export API-159 both use (F-591).
import { describe, expect, it } from 'vitest';
import { DISCOUNT_LABEL, laborLabel, lineWordsOf, MEMBER_RATE_PERCENT, SERVICE_INVOICE_LABELS } from '@bw/domain';
import { leftHowText, leftReasonText, waitingReasonText, type LeftWords } from '@bw/i18n/src/billing-rows.ts';
import { catalogs } from '@bw/i18n/src/catalog.ts';
import { formatterFor } from '@bw/i18n/src/format.ts';

const en = formatterFor('en');
const es = formatterFor('es');
/** The page's labor words from minutes (PbsInvoiceBody labelOf), in a language. */
const laborWords = (t: typeof en, minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? t('pbs.line.labor.m', { m }) : m === 0 ? t('pbs.line.labor.h', { h }) : t('pbs.line.labor.hm', { h, m });
};

describe('the pretend billing invoice lines in the page language (API-66 words)', () => {
  // why: F-593 each composed label gives back the facts it was made from, and those facts compose the very label (a round trip)
  it('reads the facts of every service, labor and discount label the link composes, and no others', () => {
    for (const [id, label] of Object.entries(SERVICE_INVOICE_LABELS)) expect(lineWordsOf({ kind: 'service', label })).toEqual({ service: id });
    for (let minutes = 0; minutes <= 600; minutes += 1) expect(lineWordsOf({ kind: 'labor', label: laborLabel(minutes) })).toEqual({ laborMinutes: minutes });
    expect(lineWordsOf({ kind: 'discount', label: DISCOUNT_LABEL })).toEqual({ ratePercent: MEMBER_RATE_PERCENT });
    for (const label of ['Hours worked: 1 hr 0 min', 'Hours worked: ', 'Hours worked: 65 min', 'Hours worked: 1 hr  5 min']) {
      expect(lineWordsOf({ kind: 'labor', label }), label).toBeNull();
    }
    expect(lineWordsOf({ kind: 'service', label: 'AC tune up' })).toBeNull();
    expect(lineWordsOf({ kind: 'discount', label: 'Comfort Club discount, 10% off the service line' })).toBeNull();
    expect(lineWordsOf({ kind: 'part', label: 'Run capacitor 45/5 MFD' })).toBeNull();
    expect(lineWordsOf({ kind: 'work_done', label: 'AC tune-up, all readings normal' })).toBeNull();
  });

  // why: F-593 the English page says exactly what billing received, and the Spanish page says the FINAL frame's Spanish words
  // (mockups/pages/r1-pbs-a-invoice.html: "Revisión del aire", "Horas trabajadas: 1 h 5 min"), never an English catalog value.
  // The brand stays 'Comfort Club' in Spanish (owner ruling 62461d7b; F-631). Part names and work-done texts show as received:
  // a part name is the Parts page name (docs/UI-DESIGN-KIT.md D5a-4), a work-done text is the technician's own words.
  it('says the composed lines in English as received and in Spanish as the frame does', () => {
    for (const [id, label] of Object.entries(SERVICE_INVOICE_LABELS)) {
      expect(catalogs.en[`pbs.service.${id}`]).toBe(label);
      expect(catalogs.es[`pbs.service.${id}`], id).not.toBe(label);
    }
    for (const minutes of [0, 5, 59, 60, 65, 120, 129, 600]) expect(laborWords(en, minutes)).toBe(laborLabel(minutes));
    expect(en('pbs.line.discount', { rate: MEMBER_RATE_PERCENT })).toBe(DISCOUNT_LABEL);
    expect(catalogs.es['pbs.service.ac_tune_up']).toBe('Revisión del aire');
    expect(laborWords(es, 65)).toBe('Horas trabajadas: 1 h 5 min');
    expect(es('pbs.line.discount', { rate: 15 })).toBe('Descuento Comfort Club, 15% menos en la línea de servicio');
    expect(catalogs.es['shell.booking.club']).toBe('Comfort Club');
    // F-909: the job page's member badge keeps the brand word order too, never 'Club Comfort'
    expect(catalogs.es['job.customer.club']).toBe('Miembro del Comfort Club');
  });
});

describe('the billing list row words (the page and the export, @bw/i18n billing-rows)', () => {
  const row = (o: Partial<LeftWords>): LeftWords => ({ reasonKind: 'data_error', reason: 'Account closed', how: 'marked_fixed', tries: 1, by: 'Keisha Thompson', markedReason: null, ...o });

  // why: FR-BILL-11, F-591 a Mark fixed row says the reason the person typed and the person, never a catalog literal in its place
  it('says the typed Mark fixed reason with the person', () => {
    expect(leftHowText(row({ markedReason: 'Paid by phone, entered by hand' }), en)).toBe('Paid by phone, entered by hand, Keisha T.');
    expect(leftHowText(row({ markedReason: 'Pagado por teléfono' }), es)).toBe('Pagado por teléfono, marcado por Keisha T.');
    expect(leftHowText(row({ markedReason: 'Paid by phone', by: null }), en)).toBe('Paid by phone');
    // No reason on record (no writer leaves one): the person alone, never a catalog sentence in place of the typed words.
    expect(leftHowText(row({ markedReason: null }), en)).toBe('Keisha T.');
  });

  // why: FR-BILL-12, F-591 each way a job left the list names the try number or the person, and the reason is the table's short words
  it('names the try number or the person, with the short reason words', () => {
    expect(leftHowText(row({ how: 'automatic_retry', tries: 4, by: null }), en)).toBe('Automatic retry, try 4');
    expect(leftHowText(row({ how: 'sent_again', by: 'Marco Perez' }), en)).toBe('Sent again by Marco P.');
    expect(leftHowText(row({ how: 'corrected' }), en)).toBe('Corrected and sent again by Keisha T.');
    expect(leftHowText(row({ how: 'sent_again', by: null }), en)).toBe('Sent again');
    expect(leftReasonText(row({ reasonKind: 'timeout', reason: null }), en)).toBe('Did not answer');
    expect(leftReasonText(row({}), en)).toBe('Account closed');
    expect(waitingReasonText({ reasonKind: 'timeout', reason: null }, en)).toBe('Billing system did not answer');
    expect(waitingReasonText({ reasonKind: null, reason: null }, en)).toBe('Waiting for its first try');
  });
});
