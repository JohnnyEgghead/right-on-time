// SPDX-License-Identifier: AGPL-3.0-or-later
// The New job page's pure rules (P4-NEWJOB): when Schedule is allowed, which days are offered, the technician lines of FR-DISP-28
// (the reason line, "Lightest day", Not suggested), the room bar and the confirmation words, in both languages.
import { catalogs } from '@bw/i18n';
import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import type { ClientT } from '../shell/intl.tsx';
import {
  canSchedule, confirmationKey, hasInput, hourText, listed, noOpenWindow, noTexts, NO_PICKS, offeredDays, reasonLine, roomFill, standout, takeHandoff, writeHandoff,
  type Day, type Tech,
} from './model.ts';
import { NJ_DAYS, NJ_TECHS } from './preview-data.ts';

const tOf = (lang: 'en' | 'es') => {
  const intl = createIntl({ locale: lang, messages: catalogs[lang] as Record<string, string>, onError: () => undefined });
  return ((key: string, values?: Record<string, string | number>) => intl.formatMessage({ id: key }, values)) as unknown as ClientT;
};
const [kevin, marcus, greg] = NJ_TECHS.technicians as [Tech, Tech, Tech];

describe('Schedule and the days (FR-DISP-8)', () => {
  // why: FR-DISP-8 (Schedule is enabled once the customer, service, day and window are picked; the technician is optional)
  it('allows Schedule with the customer, service, day and window picked, and no technician', () => {
    const picks = { ...NO_PICKS, serviceId: 'water_heater', day: '2026-09-17', windowId: 'w12' };
    expect(canSchedule({ id: 'c' }, picks)).toBe(true);
    expect(canSchedule({ id: 'c' }, { ...picks, windowId: null })).toBe(false);
    expect(canSchedule(null, picks)).toBe(false);
  });

  // why: FR-DISP-8 (the office can pick a day whose online booking has closed; a Full day is drawn and cannot be picked, a Closed day is not drawn)
  it('drops a Closed day, keeps a Full one, and says No windows for a day whose windows are all Full', () => {
    const closed: Day = { date: '2026-09-20', mode: 'sunday', state: 'closed', reason: 'sunday', left: 0, windows: [] };
    expect(offeredDays([...NJ_DAYS, closed]).map((d) => d.date)).toEqual(NJ_DAYS.map((d) => d.date));
    expect(offeredDays(NJ_DAYS).find((d) => d.state === 'full')?.date).toBe('2026-09-15');
    expect(noOpenWindow(NJ_DAYS[3] as Day)).toBe(true);
    expect(noOpenWindow(NJ_DAYS[2] as Day)).toBe(false);
  });

  // why: FR-DISP-8 (Cancel and the Jobs crumb ask before leaving when the page holds input, UIS.FR-FLOW-3)
  it('holds input once something is typed or picked', () => {
    expect(hasInput('', null, NO_PICKS)).toBe(false);
    expect(hasInput(' hen', null, NO_PICKS)).toBe(true);
    expect(hasInput('', { id: 'c' }, NO_PICKS)).toBe(true);
    expect(hasInput('', null, { ...NO_PICKS, day: '2026-09-17' })).toBe(true);
  });

  // why: FR-DISP-8 (the room bar of a window: 1, 2 and 3 left draw 80, 60 and 40 as DK-89 does, Full draws 100)
  it('fills the room bar as DK-89 draws it', () => {
    expect([1, 2, 3].map((n) => roomFill(n, false))).toEqual([80, 60, 40]);
    expect(roomFill(0, true)).toBe(100);
    expect(roomFill(9, false)).toBe(0);
  });
});

describe('the suggested technicians (FR-DISP-28, CTL-OFC-04-08, CTL-OFC-04-17)', () => {
  const en = tOf('en');
  const noSkill: Tech = { ...greg, id: 'ns', name: 'Dee', suggested: false, reason: 'skill_missing', room: true };
  const full: Tech = { ...marcus, id: 'nr', name: 'Full', room: false };

  // why: FR-DISP-28 (technicians with room are listed, those who lack the skill after the others as Not suggested; one with no room is not offered)
  it('lists those with room, the suggested first in the server\'s order, then Not suggested, and leaves out one with no room', () => {
    const l = listed([kevin, full, noSkill, marcus, greg]);
    expect(l.suggested.map((x) => x.name)).toEqual(['Kevin Doyle', 'Marcus Bell', 'Greg Hoffman']);
    expect(l.notSuggested.map((x) => x.name)).toEqual(['Dee']);
  });

  // why: FR-DISP-28 (the reason line says the skill, the minutes from the stop before with its time and area, and the load that day)
  it('words the reason line from the answer: skill, minutes from the stop before, and jobs of capacity', () => {
    expect(reasonLine(en, kevin, 'plumbing', null)).toBe('Services plumbing; 9 minutes from the 10 AM job in Gahanna; 4 of 5 booked.');
    expect(reasonLine(en, { ...kevin, stopBefore: null, minutesFromStopBefore: 1 }, 'heating_cooling', null)).toBe('Services heating and cooling; 1 minute from the branch; 4 of 5 booked.');
    expect(reasonLine(en, greg, 'plumbing', 'lightest')).toBe('Lightest day; services plumbing; 26 minutes from the 9 AM job in Dublin; 2 of 5 booked.');
    expect(hourText('2026-09-17T08:20:00-04:00[America/New_York]')).toBe('8:20 AM');
  });

  // why: FR-DISP-28 (a technician who lacks the skill shows Not suggested with the reason: No plumbing skill)
  it('gives a Not suggested row its reason in words', () => {
    expect(reasonLine(en, noSkill, 'plumbing', null)).toBe('No plumbing skill');
    expect(reasonLine(tOf('es'), noSkill, 'plumbing', null)).toBe('Sin habilidad de plomería');
  });

  // why: FR-DISP-28 (the word "Lightest day" or "Closest" starts the line of a technician below the top row who has the lowest load or the fewest minutes)
  it('marks Lightest day on the technician below the top with the lowest load, and nothing on the top row', () => {
    const s = [kevin, marcus, greg];
    expect(standout(s, greg.id)).toBe('lightest');
    expect(standout(s, kevin.id)).toBeNull();
    expect(standout(s, marcus.id)).toBeNull();
    expect(standout([kevin], kevin.id)).toBeNull();
    expect(standout([kevin, { ...marcus, minutesFromStopBefore: 3, load: { jobs: 5, capacity: 5 } }], marcus.id)).toBe('closest');
  });

  // why: FR-DISP-28 (the page names its words in both languages: Spanish wording of the reason line)
  it('words the same line in Spanish', () => {
    expect(reasonLine(tOf('es'), kevin, 'plumbing', null)).toBe('Atiende plomería; 9 minutos del trabajo de las 10 AM en Gahanna; 4 de 5 con trabajo.');
  });
});

describe('the confirmation words (CTL-OFC-04-19, CMP-11, GAP-10)', () => {
  // why: FR-DISP-29 (the notice and the toast say what the customer gets: a confirmation text in their language, held to 8 AM in quiet hours, or no texts)
  it('words the server\'s answer about the confirmation text, and who gets no texts', () => {
    expect(confirmationKey({ status: 'queued' })).toBe('newjob.done.sent');
    expect(confirmationKey({ status: 'held' })).toBe('newjob.done.held');
    expect(confirmationKey(null)).toBe('newjob.done.noTexts');
    expect(noTexts({ mobile: '+16145550148', textsOn: true })).toBe(false);
    expect(noTexts({ mobile: '+16145550148', textsOn: false })).toBe(true);
    expect(noTexts({ mobile: null, textsOn: true })).toBe(true);
    const en = tOf('en');
    expect(en('newjob.notice.texts', { name: 'Lucia', language: 'Spanish' })).toBe('Lucia gets a confirmation text in Spanish within 1 minute, and a reminder at 6 PM the evening before.');
    expect(en('newjob.done.sent', { n: 24877, name: 'Harold' })).toBe('Job 24877 scheduled. Harold gets a confirmation text.');
  });

  // why: F-806, CTL-OFC-04-14, CTL-OFC-04-13, CTL-OFC-04-19 (a live value keeps the Spanish grammatical: 1 window is singular, and a language word mid-sentence is lower case)
  it('words the room and the text language as Spanish needs them', () => {
    const es = tOf('es');
    expect([es('newjob.left', { n: 1 }), es('newjob.left', { n: 3 })]).toEqual(['queda 1', 'quedan 3']);
    expect([es('newjob.window.leftSelected', { n: 1 }), es('newjob.window.leftSelected', { n: 2 })]).toEqual(['queda 1 - elegido', 'quedan 2 - elegido']);
    expect(es('newjob.customer.textsIn', { language: es('newjob.language.en') })).toBe('textos en inglés');
    expect(es('newjob.notice.texts', { name: 'Lucia', language: es('newjob.language.es') })).toContain('texto de confirmación en español en 1 minuto');
    expect(tOf('en')('newjob.left', { n: 1 })).toBe('1 left');
  });

  // why: F-804, F-807, CTL-OFC-04-19, CTL-OFC-04-13 (a same-day job has no evening before, so the notice promises no reminder; a visit today reads today)
  it('words a day that is today', () => {
    for (const lang of ['en', 'es'] as const) expect(tOf(lang)('newjob.notice.textsToday', { name: 'Lucia', language: 'x' })).not.toMatch(/reminder|recordatorio/);
    expect(tOf('en')('newjob.visit.today', { window: '10 AM-12 PM' })).toBe('Visit today, 10 AM-12 PM');
    expect(tOf('es')('newjob.visit.today', { window: '10 AM-12 PM' })).toBe('Visita hoy, 10 AM-12 PM');
  });

  // why: FR-DISP-8 (the toast the job page shows after Schedule travels with the job number and is read once, for that job only)
  it('hands the toast to the job page once, for the job that was made', () => {
    const store = new Map<string, string>();
    (globalThis as unknown as { window: unknown }).window = { sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } };
    writeHandoff({ jobNumber: 24877, key: 'newjob.done.sent', values: { n: 24877, name: 'Harold' } });
    expect(takeHandoff(24800)).toBeNull();
    writeHandoff({ jobNumber: 24877, key: 'newjob.done.sent', values: { n: 24877, name: 'Harold' } });
    expect(takeHandoff(24877)).toMatchObject({ key: 'newjob.done.sent' });
    expect(takeHandoff(24877)).toBeNull();
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  // why: F-835 (F-798 fix) blocked storage must not break Schedule or the job page: the write is swallowed and the read answers null, so the job page keeps the Board trail (CTL-OFC-03-01) and shows no toast
  it('swallows a write and answers null on a read when sessionStorage throws', () => {
    const boom = () => { throw new Error('SecurityError: storage is blocked'); };
    (globalThis as unknown as { window: unknown }).window = { sessionStorage: { getItem: boom, setItem: boom, removeItem: boom } };
    try {
      expect(() => writeHandoff({ jobNumber: 24877, key: 'newjob.done.sent', values: { n: 24877, name: 'Harold' } })).not.toThrow();
      expect(takeHandoff(24877)).toBeNull();
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  });
});
