// SPDX-License-Identifier: AGPL-3.0-or-later
// Rendering, counting and the simulator's verdict as pure rules (FR-TEXT-9, FR-TEXT-16, FR-TEXT-20).
import { describe, expect, it } from 'vitest';
import { simulatorVerdict, SIMULATOR_REASON } from './gateway.ts';
import { catalogTexts, countBody, renderTemplate, TemplateRenderError } from './render.ts';

const catalog = catalogTexts({
  en: { 'text.reminder': 'Brightwater: A reminder that your visit is tomorrow, {window}.', 'text.late': 'x'.repeat(150) + ' {tech}' },
  es: { 'text.reminder': 'Brightwater: Le recordamos que su visita es manana, {window}.' },
});

describe('rendering a template (FR-TEXT-9)', () => {
  // why: FR-TEXT-9
  it('fills each slot in the customer language and counts it as 1 GSM-7 message', () => {
    const r = renderTemplate(catalog, 'reminder', 'es', { window: '8-10 AM' });
    expect(r).toEqual({ body: 'Brightwater: Le recordamos que su visita es manana, 8-10 AM.', encoding: 'gsm7', characters: 60, messages: 1 });
  });

  // why: FR-TEXT-9
  it('refuses a missing template, a missing slot value and a render over 1 message', () => {
    expect(() => renderTemplate(catalog, 'confirmation', 'en', {})).toThrow(TemplateRenderError);
    expect(() => renderTemplate(catalog, 'reminder', 'en', {})).toThrow(/slot \{window\}/);
    expect(() => renderTemplate(catalog, 'late', 'en', { tech: 'Marcus Bell' })).toThrow(/1 GSM-7 message/);
    expect(() => renderTemplate(catalog, 'reminder', 'en', { window: 'Llegará' })).toThrow(/gsm7|ucs2/);
  });

  // why: FR-TEXT-20
  it('counts an office body: an extension character counts 2, any other character switches to UCS-2 and 70', () => {
    expect(countBody('Price: 10€')).toMatchObject({ encoding: 'gsm7', characters: 11, messages: 1 });
    expect(countBody('a'.repeat(161))).toMatchObject({ encoding: 'gsm7', messages: 2 });
    expect(countBody('Llegará ' + 'a'.repeat(62))).toMatchObject({ encoding: 'ucs2', characters: 70, messages: 1 });
    expect(countBody('Llegará ' + 'a'.repeat(63))).toMatchObject({ encoding: 'ucs2', messages: 2 });
  });
});

describe('the text simulator modes (FR-TEXT-16)', () => {
  // why: FR-TEXT-16
  it('fails the sends each mode names and no others', () => {
    expect(simulatorVerdict(null, 'c1')).toEqual({ fail: false });
    expect(simulatorVerdict({ mode: 'up', customer_id: null, n_left: null }, 'c1')).toEqual({ fail: false });
    expect(simulatorVerdict({ mode: 'all_fail', customer_id: null, n_left: null }, 'c1')).toEqual({ fail: true, reason: SIMULATOR_REASON.all_fail });
    expect(simulatorVerdict({ mode: 'fail_customer', customer_id: 'c1', n_left: null }, 'c1')).toEqual({ fail: true, reason: SIMULATOR_REASON.fail_customer });
    expect(simulatorVerdict({ mode: 'fail_customer', customer_id: 'c1', n_left: null }, 'c2')).toEqual({ fail: false });
    expect(simulatorVerdict({ mode: 'fail_next_n', customer_id: null, n_left: 2 }, 'c1')).toEqual({ fail: true, reason: SIMULATOR_REASON.fail_next_n });
    expect(simulatorVerdict({ mode: 'fail_next_n', customer_id: null, n_left: 0 }, 'c1')).toEqual({ fail: false });
  });
});
