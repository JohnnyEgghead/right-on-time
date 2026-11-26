// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixtures for text-budget-check: stand-in templates and slot values, committed so the 5
// FR-TEXT-9 fail inputs run as must-fail arms every time, whatever the real templates hold. These are test copy, not product copy. The Spanish Saturday label is the correct "sáb" (F-419): no Spanish
// word for Saturday is GSM-7 basic, so the Spanish copy leaves the weekday out and the date names the day (FR-TEXT-10).
import type { CheckInput, FailureKind, Lang, SlotValues, Template } from './text-budget.ts';
import { BOOKABLE_DAYS } from './text-budget.ts';

const EN_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ES_DAYS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ES_MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const dayNumbers = Array.from({ length: 31 }, (_, i) => i + 1);
// The arms prove detection, not coverage, so they use the first and last day of each month.
const armDayNumbers = [1, 30];

export function standInSlotValues(overrides: Partial<SlotValues> = {}, days: number[] = dayNumbers): SlotValues {
  return {
    weekday: (lang: Lang, day: number): string => (lang === 'en' ? EN_DAYS : ES_DAYS)[day - 1] as string,
    values: {
      date: {
        en: EN_MONTHS.flatMap((m) => days.map((d) => `${m} ${d}`)),
        es: ES_MONTHS.flatMap((m) => days.map((d) => `${d} de ${m}`)),
      },
      window: {
        en: ['8-10 AM', '10 AM-12 PM', '12-2 PM', '2-4 PM', '4-6 PM', '8 AM-12 PM', '12-4 PM', '2-6 PM'],
        es: ['de 8 a 10 AM EDT', 'de 10 AM a 12 PM EDT', 'de 12 a 2 PM EDT', 'de 2 a 4 PM EDT', 'de 4 a 6 PM EDT', 'de 8 AM a 12 PM EDT', 'de 12 a 4 PM EDT', 'de 2 a 6 PM EDT'],
      },
      service: {
        en: ['Tune-up', 'Repair visit', 'New system estimate', 'Duct cleaning'],
        es: ['Mantenimiento', 'Visita de reparacion', 'Presupuesto nuevo', 'Limpieza de ductos'],
      },
      tech: { en: ['Mario', 'Ana', 'José Luis', 'Zachary Q.'], es: ['Mario', 'Ana', 'José Luis', 'Zachary Q.'] },
      arrival: { en: ['8:00 AM', '12:45 PM'], es: ['8:00 AM', '12:45 PM'] },
      mapLink: { en: ['bw.j7l.io/m/AbC12345'], es: ['bw.j7l.io/m/AbC12345'] },
      rescheduleLink: { en: ['bw.j7l.io/r/AbC12345'], es: ['bw.j7l.io/r/AbC12345'] },
      phone: { en: ['(555) 555-0100'], es: ['(555) 555-0100'] },
    },
    ...overrides,
  };
}

export const GOOD_TEMPLATES: readonly Template[] = [
  {
    id: 'confirmation',
    text: {
      en: 'Brightwater: Your {service} visit is booked for {weekday}, {date}, {window}. We will text you when we are on the way.',
      es: 'Brightwater: Su visita de {service} esta reservada para el {date}, {window}. Le avisaremos cuando vayamos en camino.',
    },
  },
  {
    id: 'reminder',
    text: {
      en: 'Brightwater: A reminder that your visit is tomorrow, {window}. Reply here if you need to change it. We will see you then.',
      es: 'Brightwater: Le recordamos que su visita es manana, {window}. Responda aqui si necesita cambiarla. Le esperamos.',
    },
  },
  {
    id: 'on-the-way',
    text: {
      en: 'Brightwater: {tech} is on the way and expects to arrive at {arrival}. Follow {tech} live: {mapLink}',
      es: 'Brightwater: {tech} va en camino y espera llegar a las {arrival}. Siga a {tech} en vivo: {mapLink}',
    },
  },
  {
    id: 'late',
    text: {
      en: 'Brightwater: Sorry, {tech} is running late and now expects to arrive at {arrival}. Thank you for your patience.',
      es: 'Brightwater: Lo sentimos, {tech} se retrasa y ahora espera llegar a las {arrival}. Gracias por su paciencia.',
    },
  },
  {
    id: 'r-reply',
    text: {
      en: 'Brightwater: No problem. Pick a new time for your {weekday}, {date} visit: {rescheduleLink} or call {phone}. Your visit stays booked until you change it.',
      es: 'Brightwater: Elija otra hora para su visita del {date}: {rescheduleLink} o llame al {phone}. Sigue reservada hasta que la cambie.',
    },
  },
];

export function goodInput(light = false): CheckInput {
  return { templates: GOOD_TEMPLATES, days: BOOKABLE_DAYS, slots: standInSlotValues({}, light ? armDayNumbers : dayNumbers) };
}

function withText(id: string, lang: Lang, text: string): Template[] {
  return GOOD_TEMPLATES.map((t) => (t.id === id ? { ...t, text: { ...t.text, [lang]: text } } : t));
}

export interface Arm {
  name: string;
  /** Every case must fail with at least one failure of `expect`. */
  expect: FailureKind;
  cases: CheckInput[];
}

/** The 5 FR-TEXT-9 fail inputs. Each arm is a must-fail case the check runs every time. */
export const ARMS: readonly Arm[] = [
  {
    name: 'arm-1-llegara-ucs2',
    expect: 'not-gsm7',
    cases: [{ ...goodInput(true), templates: withText('late', 'es', 'Brightwater: Llegará a las {arrival}.') }],
  },
  {
    name: 'arm-2-161-gsm7-characters',
    expect: 'over-160',
    cases: [{ ...goodInput(true), templates: withText('reminder', 'en', `Brightwater: ${'a'.repeat(148)}`) }],
  },
  {
    name: 'arm-3-curly-apostrophe',
    expect: 'not-gsm7',
    cases: [
      { ...goodInput(true), templates: withText('reminder', 'en', 'Brightwater: Don’t forget, your visit is {window}.') },
    ],
  },
  {
    name: 'arm-4-weekday-enumeration-skips-saturday',
    expect: 'missing-day',
    cases: [{ ...goodInput(true), days: [1, 2, 3, 4, 5] }],
  },
  {
    name: 'arm-5-spanish-render-outputs-sab-or-sabado',
    expect: 'not-gsm7',
    cases: ['Sáb', 'sábado'].map((label) => ({
      ...goodInput(true),
      // The good Spanish copy leaves the weekday out (F-419), so this arm's Spanish r-reply prints it: the render is
      // what must fail, not only the label.
      templates: withText('r-reply', 'es', 'Brightwater: Elija otra hora para su visita del {weekday}, {date}: {rescheduleLink} o llame al {phone}.'),
      slots: standInSlotValues({
        weekday: (lang: Lang, day: number): string =>
          lang === 'es' && day === 6 ? label : standInSlotValues().weekday(lang, day),
      }, armDayNumbers),
    })),
  },
];

/** Arms 6 to 9: cases the budget check must refuse (an extension character in a render, a slot with no values, a formatted placeholder, fixed copy over budget at the maxima), each closing a gap the check once had (F-163, F-165, F-166, F-167). */
const stand = standInSlotValues({}, armDayNumbers);
export const CHECK_ARMS: readonly Arm[] = [
  {
    name: 'arm-6-extension-character-in-a-render',
    expect: 'not-gsm7',
    cases: [{ ...goodInput(true), templates: withText('reminder', 'en', 'Brightwater: Your visit is [{window}].') }],
  },
  {
    name: 'arm-7-slot-with-an-empty-value-list',
    expect: 'no-renders',
    cases: [{ ...goodInput(true), slots: { ...stand, values: { ...stand.values, tech: { en: [], es: [] } } } }],
  },
  {
    name: 'arm-8-formatted-placeholder',
    expect: 'formatted-slot',
    cases: [
      {
        ...goodInput(true),
        templates: withText('late', 'en', 'Brightwater: {tech} is late, now arriving {arrival, time, short}.'),
      },
    ],
  },
  {
    // The render is 160 septets at the stand-in values and 164 at the SD-17 maxima; the fixed copy, 149, is also 4 over
    // the budget of 145.
    name: 'arm-9-fixed-copy-over-budget-at-the-maxima',
    expect: 'over-160',
    cases: [{ ...goodInput(true), templates: withText('reminder', 'en', `Brightwater: ${'a'.repeat(135)} {window}`) }],
  },
  {
    // F-1443: a Spanish confirmation whose fixed copy is 107 characters, 1 over the SD-17 budget of 106, though it is well under 160 septets.
    name: 'arm-10-spanish-confirmation-fixed-copy-over-budget',
    expect: 'fixed-over-budget',
    cases: [{ ...goodInput(true), templates: withText('confirmation', 'es', `${'a'.repeat(107)} {date}`) }],
  },
];
