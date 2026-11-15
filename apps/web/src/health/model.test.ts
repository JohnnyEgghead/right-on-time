// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ALERT_TYPES } from '../../../../packages/domain/src/alerts.ts';
import { catalogs } from '@bw/i18n/src/catalog.ts';
import { formatterFor } from '@bw/i18n/src/format.ts';
import { alertOpenLabel, alertText, alertTitle, alertTypeName } from '../shell/alert-words.ts';
import { HEALTH_SUCCESS } from './preview-data.ts';
import { alertWhen, applyInput, canApply, locationWords, nightLabel, overallText, realWhen, seconds, simInForce, sizeText, sparkPoints, zoneWord } from './model.ts';

const en = formatterFor('en');
const es = formatterFor('es');

describe('the words of the System health page', () => {
  // why: FR-HLTH-1 the backup's size, nights and times read as the stored record, real times with their zone
  it('words a size, a real time with its zone, a night and a demo-day alert time', () => {
    expect(sizeText(2_400_000_000)).toBe('2.4 GB');
    expect(sizeText(31_000_000)).toBe('31.0 MB');
    expect(realWhen('2026-09-15T02:30:00-04:00[America/New_York]', 'en', en)).toBe('Tue, Sep 15, 2:30 AM EDT');
    expect(realWhen('2026-09-15T02:30:00-04:00[America/New_York]', 'es', es, false)).toMatch(/^sep 15, 2:30 a\. ?m\. EDT$|^Sep 15, 2:30 AM EDT$/i);
    expect(nightLabel('2026-09-09', en)).toBe('Wed 9');
    expect(alertWhen('2026-09-15T10:27:00-04:00[America/New_York]', HEALTH_SUCCESS.asOf, 'en', en)).toBe('Today, 10:27 AM');
    expect(alertWhen('2026-09-13T03:23:00-04:00[America/New_York]', HEALTH_SUCCESS.asOf, 'en', en)).toBe('Sun, Sep 13, 3:23 AM');
  });

  // why: FR-HLTH-3 the typical and slowest values read in seconds with 1 place against the 5 s goal
  it('words the delay in seconds and the overall chip', () => {
    expect(seconds(1300)).toBe('1.3');
    expect(seconds(2949)).toBe('2.9');
    expect(overallText({ working: true, needsOffice: 2 }, en)).toBe('All working, 2 items need the office');
    expect(overallText({ working: true, needsOffice: 0 }, en)).toBe('All working');
    expect(overallText({ working: false, needsOffice: 1 }, en)).toBe('Needs attention, 1 item needs the office');
  });

  // why: FR-HLTH-3 the chart plots one point per minute of the last 60 minutes and nothing older
  it('keeps one point per minute (the slowest) and drops what is older than 60 minutes', () => {
    const end = '2026-09-15T10:28:00-04:00[America/New_York]';
    const pts = sparkPoints([
      { at: '2026-09-15T10:28:00-04:00[America/New_York]', ms: 900 },
      { at: '2026-09-15T10:26:30-04:00[America/New_York]', ms: 1500 },
      { at: '2026-09-15T10:26:10-04:00[America/New_York]', ms: 4000 },
      { at: '2026-09-15T09:10:00-04:00[America/New_York]', ms: 7000 },
    ], end);
    expect(pts).toEqual([{ ago: 1, ms: 4000 }, { ago: 0, ms: 900 }]);
  });

  // why: FR-TEXT-16 Apply sends the mode's own inputs, refuses N outside 1 to 20 and a missing customer, and stays off while the pick is in force
  it('builds the apply body per mode and enables Apply only for a valid change', () => {
    const now = { mode: 'up' as const, customerId: null, customerName: null, nLeft: null, setBy: null, setAt: null };
    expect(applyInput({ mode: 'all_fail', customerId: null, n: '' })).toEqual({ ok: true, body: { mode: 'all_fail' } });
    expect(applyInput({ mode: 'fail_next_n', customerId: null, n: '3' })).toEqual({ ok: true, body: { mode: 'fail_next_n', n: 3 } });
    for (const bad of ['', '0', '21', '2.5', 'abc', '-1']) expect(applyInput({ mode: 'fail_next_n', customerId: null, n: bad })).toEqual({ ok: false, field: 'n' });
    expect(applyInput({ mode: 'fail_customer', customerId: null, n: '' })).toEqual({ ok: false, field: 'customer' });
    expect(applyInput({ mode: 'fail_customer', customerId: 'c-1', n: '' })).toEqual({ ok: true, body: { mode: 'fail_customer', customerId: 'c-1' } });
    expect(canApply({ mode: 'up', customerId: null, n: '' }, now)).toBe(false);
    expect(canApply({ mode: 'all_fail', customerId: null, n: '' }, now)).toBe(true);
    expect(canApply({ mode: 'fail_next_n', customerId: null, n: '25' }, now)).toBe(false);
    expect(canApply({ mode: 'fail_next_n', customerId: null, n: '3' }, { ...now, mode: 'fail_next_n', nLeft: 3 })).toBe(false);
    expect(simInForce(now, en)).toEqual({ mode: 'Simulator up', by: 'Setup' });
    expect(simInForce({ ...now, mode: 'fail_next_n', nLeft: 3, setBy: 'Dana R.' }, en)).toEqual({ mode: 'Fail the next 3 sends', by: 'Dana R.' });
    expect(simInForce({ ...now, mode: 'fail_customer', customerName: 'Linh Pham', setBy: 'Dana R.' }, en)).toEqual({ mode: 'Fail sends to Linh Pham', by: 'Dana R.' });
    expect(zoneWord('America/Los_Angeles', en)).toBe('Pacific');
    expect(zoneWord('Pacific/Honolulu', en)).toBe('Pacific/Honolulu');
  });
});

describe('the words of the alert lists (F-432, F-352)', () => {
  // why: FR-HLTH-4 an Open alert names the failed text: the sentence carries the customer and the kind of text, in both languages
  it('words a text_gave_up alert with its customer in English and Spanish', () => {
    const a = { type: 'text_gave_up', messageKey: 'alert.text_gave_up', messageValues: { textId: 't', customer: 'Linh Pham', kind: 'confirmation', jobNumber: 24811 } };
    expect(alertText(en, a)).toBe('The confirmation to Linh Pham was not sent after 5 tries. It is on the call list.');
    expect(alertText(es, a)).toContain('Linh Pham');
    expect(alertText(es, a)).toContain('confirmación');
    expect(alertTitle(en, a)).toBe('Text could not be sent');
    expect(alertOpenLabel(en, a)).toBe('Open the call list');
  });

  // why: F-1277, FR-TEXT-12 an office text about no visit is on no call list, so its alert uses the kit 0.9 frame's words and link name, in both languages
  it('words the alert for an office text about no visit as the frame does, with no call list', () => {
    const a = { type: 'text_gave_up', messageKey: 'alert.text_gave_up', messageValues: { textId: 't', customer: 'Rosa Castillo', kind: 'office' } };
    expect(alertText(en, a)).toBe('The office text to Rosa Castillo was not sent after 5 tries.');
    expect(alertOpenLabel(en, a)).toBe('Open the text');
    expect(alertText(es, a)).toBe('El texto de la oficina para Rosa Castillo no se envió después de 5 intentos.');
    expect(alertOpenLabel(es, a)).toBe('Abrir el texto');
  });

  // why: F-432 every alert type the checks write has its words in both catalogs, and its sentence formats with the values its rule writes
  it('has a title, a sentence, an open link and a settings name for every SD-30 type in both catalogs', () => {
    const values: Record<string, Record<string, string | number>> = {
      text_gave_up: { textId: 't', customer: 'Linh Pham', kind: 'late', jobNumber: 1 }, billing_waiting_person: { jobNumber: 24790 }, billing_retrying_long: { jobNumber: 24790 },
      offline_conflict: { conflictId: 'c', jobNumber: 24790 }, backup_failed: { reason: 'failed' }, restore_test_failed: {}, board_delay_over_goal: { typicalMs: 6200 },
      restore_test_passed: { minutes: 23 }, world_reset: {}, billing_reset_waiting: {},
    };
    for (const lang of ['en', 'es'] as const) {
      const t = formatterFor(lang);
      for (const type of ALERT_TYPES) {
        const a = { type, messageKey: `alert.${type}`, messageValues: values[type]! };
        for (const text of [alertText(t, a), alertTitle(t, a), alertOpenLabel(t, a), alertTypeName(t, type)]) {
          expect(text, `${lang} ${type}`).not.toMatch(/^alert\./);
          expect(text.length, `${lang} ${type}`).toBeGreaterThan(3);
        }
      }
    }
    // the 1 extra sentence is the no-visit office text's (F-1277): it is the same type with its own words
    expect(Object.keys(catalogs.en).filter((k) => /^alert\.[a-z_]+$/.test(k)).sort()).toEqual([...ALERT_TYPES, 'text_gave_up_office'].map((x) => `alert.${x}`).sort());
  });
});

describe('the data locations (FR-HLTH-2, FR-LANG-2)', () => {
  // why: FR-HLTH-2, FR-LANG-2 the settings' location values read in the page's language (F-665, owner: Translate them); an operator's own value shows as set
  it('translates the known values and keeps any other', () => {
    expect(locationWords(en, 'This computer')).toBe('This computer');
    expect(locationWords(es, 'This computer')).toBe('Esta computadora');
    expect(locationWords(es, 'AWS Lightsail, US East (Virginia)')).toBe('AWS Lightsail, este de EE. UU. (Virginia)');
    expect(locationWords(es, 'AWS Lightsail object storage, US East (Ohio)')).toBe('Almacenamiento de objetos de AWS Lightsail, este de EE. UU. (Ohio)');
    expect(locationWords(es, 'Rack 4, Dayton')).toBe('Rack 4, Dayton');
  });
});
