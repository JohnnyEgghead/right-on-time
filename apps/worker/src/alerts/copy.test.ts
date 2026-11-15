// SPDX-License-Identifier: AGPL-3.0-or-later
// The words of an alert email: every SD-30 type has a subject and a body in both languages, every slot a rule can fill
// is filled, and no placeholder is left in the text. Pure: no database.
import { describe, expect, it } from 'vitest';
import { ALERT_TYPES } from '@bw/domain';
import { alertEmailWords } from './copy.ts';

const VALUES = { jobNumber: 24825, typicalMs: 6200, minutes: 14, textId: 'x' };

describe('alert email copy', () => {
  // why: FR-AUTH-8, SD-30
  it('has a subject and body in en and es for every alert type, with every slot filled', () => {
    for (const type of ALERT_TYPES) {
      for (const lang of ['en', 'es'] as const) {
        const w = alertEmailWords(type, lang, VALUES);
        expect(w.subject.length, `${type} ${lang} subject`).toBeGreaterThan(0);
        expect(w.body.length, `${type} ${lang} body`).toBeGreaterThan(0);
        expect(w.subject + w.body, `${type} ${lang}`).not.toMatch(/[{}]/);
      }
      expect(alertEmailWords(type, 'en', VALUES).subject, type).not.toBe(alertEmailWords(type, 'es', VALUES).subject);
    }
  });

  // why: FR-AUTH-8
  it('writes the values it is given into the body', () => {
    expect(alertEmailWords('billing_waiting_person', 'en', VALUES).body).toContain('24825');
    expect(alertEmailWords('board_delay_over_goal', 'es', VALUES).body).toContain('6200');
  });

  // why: F-1277, FR-AUTH-8: the email names the call list only for a text that is on it (a text about a visit; SPECIFICATIONS 753)
  it.each([
    ['en', 'call list', 'text log'],
    ['es', 'lista de llamadas', 'registro de mensajes'],
  ] as const)('a gave-up text in %s: a text about a visit names the call list; an office text about no visit names the text log', (lang, callList, textLog) => {
    const visit = alertEmailWords('text_gave_up', lang, { textId: 'x', jobNumber: 24825 });
    expect(visit.body).toContain(callList);
    expect(visit.body).not.toContain(textLog);
    // The outbox and the check write a no-visit text's values with no jobNumber (tryText.ts reportGaveUp, rules.ts text_gave_up).
    const noVisit = alertEmailWords('text_gave_up', lang, { textId: 'x' });
    expect(noVisit.body).not.toContain(callList);
    expect(noVisit.body).toContain(textLog);
    expect(noVisit.subject).toBe(visit.subject);
    expect(noVisit.subject + noVisit.body).not.toMatch(/[{}]/);
  });
});
