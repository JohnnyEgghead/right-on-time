// SPDX-License-Identifier: AGPL-3.0-or-later
// The Messages pages' pure side (FR-TEXT-13, FR-TEXT-15, FR-TEXT-24, FR-TEXT-25): the log's rows, the status words the page and its export
// share, the outcome buttons' rules (UD-53) and the What to say script in both languages.
import { clockOfWire, statusChip, statusNote, windowLabelOfWire } from '@bw/i18n';
import { formatterFor } from '@bw/i18n/src/format.ts';
import { describe, expect, it } from 'vitest';
import { betweenWords, logRows, outcomeRules, scriptParts, showsButtons, statusFactsOf, timeWords } from './model.ts';
import { CALLS_SUCCESS, LOG_SUCCESS } from './preview-data.ts';

const en = formatterFor('en');
const es = formatterFor('es');
const w = timeWords(en, 'en', 'America/New_York');

describe('the text log rows', () => {
  // why: FR-TEXT-15
  it('merges the texts and the replies newest first', () => {
    const rows = logRows(LOG_SUCCESS);
    expect(rows).toHaveLength(11);
    const times = rows.map((r) => clockOfWire(r.at));
    expect(times).toEqual(['10:29 AM', '10:28 AM', '10:27 AM', '10:24 AM', '10:12 AM', '9:56 AM', '9:52 AM', '9:14 AM', '8:47 AM', '8:00 AM', '7:41 AM']);
    expect(rows.filter((r) => r.kind === 'reply')).toHaveLength(3);
  });

  // why: FR-TEXT-15
  it('says a held, a failed and a delivered text in words with the reason, in both languages', () => {
    const [held, , failed, , , , , , , heldThenSent] = LOG_SUCCESS.texts;
    const facts = (r: typeof held) => statusFactsOf(r!, 'America/New_York');
    expect(statusChip(facts(held), en, w)).toEqual({ tone: 'held', label: 'Held until 8 AM' });
    expect(statusNote(facts(held), en, w)).toBe('Pacific time; sends 11:00 AM EDT');
    expect(statusChip(facts(failed), en, w).label).toBe('Failed - retrying');
    expect(statusNote(facts(failed), en, w)).toBe('attempt 2 of 5, next try 10:31 AM');
    expect(statusChip(facts(LOG_SUCCESS.texts[1]), en, w)).toEqual({ tone: 'site', label: 'Delivered' });
    expect(statusNote(facts(heldThenSent ?? LOG_SUCCESS.texts[7]), en, w)).toBe('held overnight, sent 8:00 AM');
    const wEs = timeWords(es, 'es', 'America/New_York');
    expect(statusChip(facts(held), es, wEs).label).toBe('Retenido hasta las 8 AM');
    expect(statusNote(facts(held), es, wEs)).toBe('hora del Pacífico; sale a las 11:00 AM EDT');
    expect(statusChip(facts(failed), es, wEs).label).toBe('Falló - reintentando');
  });
});

describe('the call list rows', () => {
  // why: FR-TEXT-25
  it('offers Mark confirmed and Reschedule on a scheduled visit and takes No answer off once the row is Confirmed or Reschedule (UD-53)', () => {
    const [confirmed, noAnswer, , reschedule, open] = CALLS_SUCCESS.reminderCalls;
    expect(outcomeRules(open!)).toEqual({ confirm: true, reschedule: true, noAnswer: true });
    expect(outcomeRules(noAnswer!)).toEqual({ confirm: true, reschedule: true, noAnswer: true });
    expect(outcomeRules(confirmed!).noAnswer).toBe(false);
    expect(outcomeRules(reschedule!).noAnswer).toBe(false);
    expect(outcomeRules({ outcome: null, visit: { jobStatus: 'canceled' } })).toEqual({ confirm: false, reschedule: false, noAnswer: true });
  });

  // why: FR-TEXT-25
  it('shows the outcome buttons again only on a row that has no outcome or whose Change is open', () => {
    expect(showsButtons(null, false)).toBe(true);
    expect(showsButtons({ kind: 'confirmed', by: 'x', at: 'y' }, false)).toBe(false);
    expect(showsButtons({ kind: 'confirmed', by: 'x', at: 'y' }, true)).toBe(true);
  });

  // why: FR-TEXT-25
  it('fills the script with the visit\'s technician and window, in English and in Spanish', () => {
    const row = CALLS_SUCCESS.reminderCalls[4]!; // Margaret Ellison: Maria Santos, 12-2 PM
    const parts = (t: typeof en) => scriptParts(row, t, '2026-09-15');
    expect(parts(en).filter((p) => p.bold).map((p) => p.text)).toEqual(['Maria', '12 and 2 PM']);
    expect(parts(en).map((p) => p.text).join('')).toBe('"Hello, this is Brightwater Heating & Air calling about your visit tomorrow. Your technician, Maria, arrives between 12 and 2 PM. Will someone be home to let Maria in?"');
    expect(parts(es).filter((p) => p.bold).map((p) => p.text)).toEqual(['Maria', 'las 12 y las 2 PM']);
    expect(parts(es).map((p) => p.text).join('')).toContain('Su técnico, Maria, llega entre las 12 y las 2 PM.');
    expect(betweenWords({ start: '2026-09-16T10:00:00-04:00[America/New_York]', end: '2026-09-16T12:00:00-04:00[America/New_York]' }, en)).toBe('10 AM and 12 PM');
    expect(windowLabelOfWire(row.visit.window)).toBe('12-2 PM');
  });

  // why: FR-TEXT-25
  it('writes a script with no technician when the visit has none', () => {
    const row = { visit: { day: '2026-09-16', window: CALLS_SUCCESS.reminderCalls[0]!.visit.window, technicianInTexts: null } };
    expect(scriptParts(row, en, '2026-09-15').map((p) => p.text).join('')).toContain('Your technician arrives between 8 and 10 AM.');
  });

  // why: FR-TEXT-25 F-655
  it('names the visit\'s own day when it is not tomorrow: today, or the weekday and date of a failed text\'s visit later in the week', () => {
    const failed = CALLS_SUCCESS.failedTexts[0]!; // Gail Porter: visit Thu, Sep 17, listed on Sep 15
    const say = (t: typeof en, callDate: string, row: typeof failed = failed) => scriptParts(row, t, callDate).map((p) => p.text).join('');
    expect(say(en, '2026-09-15')).toContain('calling about your visit on Thu, Sep 17. Your technician, Maria,');
    expect(say(en, '2026-09-15')).not.toContain('tomorrow');
    expect(say(es, '2026-09-15')).toContain('por su visita del jue, 17 de sep. Su técnico, Maria,');
    expect(say(es, '2026-09-15')).not.toContain('mañana');
    expect(say(en, '2026-09-17')).toContain('calling about your visit today.');
    expect(say(es, '2026-09-17')).toContain('por su visita de hoy.');
    expect(say(en, '2026-09-16')).toContain('calling about your visit tomorrow.');
    const noTech = { visit: { ...failed.visit, technicianInTexts: null } };
    expect(scriptParts(noTech, en, '2026-09-17').map((p) => p.text).join('')).toContain('your visit today. Your technician arrives between');
  });
});
