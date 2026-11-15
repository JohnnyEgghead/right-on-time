// SPDX-License-Identifier: AGPL-3.0-or-later
import IntlMessageFormat from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import { catalogs } from '../../../../packages/i18n/src/catalog.ts';
import { TEXT_STATUSES } from '../../../../packages/outbox/src/model.ts';
import {
  actionsOpen, can, closedKey, CONTROL_CONTRACT, equipmentWord, feedKey, findParts, laborMinutes, linesDiffer, needsParts, editRefusalShown, equipmentSuggestions, equipmentTypeSent, notesOf, refusalShown, rescheduleDone, textCount, textStatusKey,
  type Job, type Lines,
} from './model.ts';

const span = (a: string, b: string) => `${a.slice(11, 16)}-${b.slice(11, 16)}`;
const refusal = (code: string, detail: Record<string, unknown> = {}) => ({ ok: false as const, code, status: 409, detail });
const lines = (o: Partial<Lines> = {}): Lines => ({ parts: [], noPartsUsed: false, hours: '1', minutes: '05', ...o });

describe('the job page rules', () => {
  // why: F-803, CTL-OFC-20-03 (the toast states the server's answer about the technician and any text; API-24's textSent had no reader)
  it.each([
    ['en', { technicianKept: true, textSent: true }, 'The visit is moved to Thu, 10-12; the technician is kept. A new confirmation text is going to the customer.'],
    ['en', { technicianKept: false, textSent: false }, 'The visit is moved to Thu, 10-12; it now has no technician. No text goes to the customer.'],
    ['es', { technicianKept: true, textSent: false }, 'La visita se movió al Thu, 10-12; se mantiene el técnico. No se envía ningún texto al cliente.'],
    ['es', { technicianKept: false, textSent: true }, 'La visita se movió al Thu, 10-12; ahora no tiene técnico. Se envía un texto de confirmación nuevo al cliente.'],
  ] as const)('words a moved visit in %s for %j', (lang, outcome, words) => {
    const shown = rescheduleDone(outcome, 'Thu', '10-12');
    expect(new IntlMessageFormat(catalogs[lang][shown.key as keyof typeof catalogs.en] as string, lang).format(shown.values)).toBe(words);
  });

  // why: F-505 (CTL-OFC-03-04 to -08 are enabled for a job not Done, No one home or Canceled)
  it('opens the office actions for Scheduled, On the way and On site, and closes them with the state words otherwise', () => {
    expect(['scheduled', 'on_the_way', 'on_site'].map((s) => actionsOpen(s as never))).toEqual([true, true, true]);
    expect(['done', 'no_one_home', 'canceled'].map((s) => [actionsOpen(s as never), closedKey(s as never)])).toEqual([
      [false, 'job.closed.done'], [false, 'job.closed.noOneHome'], [false, 'job.closed.canceled'],
    ]);
  });

  // why: F-565 (a role-gated control shows only for a role whose API-07 keys hold its contract ID)
  it('shows a role-gated control only when the API-07 keys hold its contract ID', () => {
    expect(can(['SCR-OFC-03', 'API-25'], CONTROL_CONTRACT.cancel)).toBe(true);
    expect(can(['SCR-OFC-03', 'API-22'], CONTROL_CONTRACT.cancel)).toBe(false);
    expect(can(null, CONTROL_CONTRACT.finish)).toBe(false);
  });

  // why: FR-TEXT-20 (the live count is the shared segment counter: 160 GSM-7, 70 once a character outside it is typed)
  it('counts the office text as the server does', () => {
    expect(textCount('')).toMatchObject({ limit: 160, left: 160, fits: true, encoding: 'gsm7' });
    expect(textCount('a'.repeat(160))).toMatchObject({ left: 0, fits: true });
    expect(textCount('a'.repeat(161))).toMatchObject({ fits: false });
    expect(textCount('Llegará pronto')).toMatchObject({ encoding: 'ucs2', limit: 70, outside: 'á', fits: true });
    expect(textCount('á'.repeat(71)).fits).toBe(false);
  });

  // why: F-872 (Edit job details has no window to pick, so window_full must not say Pick another)
  it('says the new service needs a full window in Edit job details, and keeps the other refusals as they are', () => {
    expect(editRefusalShown(refusal('window_full'), span)).toEqual({ key: 'job.refused.windowFullEdit' });
    expect(editRefusalShown(refusal('version_conflict'), span)).toEqual({ key: 'job.refused.conflict' });
  });
  // why: F-565 (Edit job details shows API-27's time_overlap and window_full with their catalog messages)
  it('names the block of a time_overlap and the window of a window_full, and the rule of a rule_refused', () => {
    expect(refusalShown(refusal('time_overlap', { block: { label: 'Supply run', start: '2026-09-15T14:00:00-04:00', end: '2026-09-15T14:30:00-04:00' } }), span))
      .toEqual({ key: 'job.refused.overlap', values: { block: 'Supply run', time: '14:00-14:30' } });
    expect(refusalShown(refusal('window_full'), span)).toEqual({ key: 'job.refused.windowFull' });
    // why: F-506 (rule_refused carries the catalog key naming the rule)
    expect(refusalShown(refusal('rule_refused', { key: 'rule.jobClosed' }), span)).toEqual({ key: 'rule.jobClosed' });
    expect(refusalShown(refusal('rule_refused', { key: 'not a key' }), span)).toEqual({ key: 'job.refused.rule' });
  });

  // why: FR-BILL-3 (the office finish refuses neither parts nor No parts used without a call; labor is required)
  it('requires parts or No parts used, and labor over 0', () => {
    expect(needsParts(lines())).toBe(true);
    expect(needsParts(lines({ noPartsUsed: true }))).toBe(false);
    expect(needsParts(lines({ parts: [{ partId: 'p', name: 'Filter', code: 'F-1', quantity: 1 }] }))).toBe(false);
    expect([laborMinutes({ hours: '1', minutes: '05' }), laborMinutes({ hours: '0', minutes: '0' }), laborMinutes({ hours: 'x', minutes: '1' })]).toEqual([65, null, null]);
  });

  // why: FR-BILL-7 (correction mode saves only when a line differs from what billing receives)
  it('sees a change in the parts, their quantity, No parts used or the labor, and none otherwise', () => {
    const a = lines({ parts: [{ partId: 'p', name: 'Filter', code: 'F-1', quantity: 1 }] });
    expect(linesDiffer(a, { ...a })).toBe(false);
    expect(linesDiffer(a, { ...a, parts: [{ ...a.parts[0]!, quantity: 2 }] })).toBe(true);
    expect(linesDiffer(a, { ...a, minutes: '10' })).toBe(true);
    expect(linesDiffer(lines({ noPartsUsed: true }), lines())).toBe(true);
  });

  // why: FR-BILL-3 (OA-54: a part is found by name or code on the seeded list; free text adds nothing)
  it('finds parts by name or code', () => {
    const parts = [{ name: 'Furnace filter 16x25x4', code: 'FLT-16254' }, { name: 'Flame sensor', code: 'FS-200' }];
    expect(findParts(parts, 'fs-2').map((p) => p.code)).toEqual(['FS-200']);
    expect(findParts(parts, 'filter').map((p) => p.code)).toEqual(['FLT-16254']);
    expect(findParts(parts, 'nothing like it')).toEqual([]);
  });
});

describe('the words of the stored codes (F-698)', () => {
  const langs = ['en', 'es'] as const;

  // why: F-698, FR-TEXT-15 (CTL-OFC-03-17: every outbox_text.status has a word, in both languages)
  it('words every text status', () => {
    for (const lang of langs) for (const s of TEXT_STATUSES) expect(catalogs[lang][textStatusKey(s) as keyof (typeof catalogs)['en']], `${lang} ${s}`).toBeTruthy();
    expect(textStatusKey('delivered')).toBe('msg.status.delivered');
    expect(textStatusKey('held')).toBe('msg.statusOpt.held');
  });

  // why: F-698, CTL-OFC-03-17 (a technician's status row names the action, never "Status changed")
  it('names the action of a technician\'s status change, in both languages', () => {
    const words = (to: string) => catalogs.en[feedKey({ kind: 'status', values: { 'to.status': to } }) as keyof (typeof catalogs)['en']];
    expect(['on_the_way', 'on_site', 'done', 'no_one_home'].map(words)).toEqual(['On my way', 'Arrived', 'Finished', 'No one home']);
    for (const to of ['on_the_way', 'on_site', 'done', 'no_one_home']) expect(catalogs.es[feedKey({ kind: 'status', values: { 'to.status': to } }) as keyof (typeof catalogs)['es']]).toBeTruthy();
    expect(feedKey({ kind: 'assigned', values: {} })).toBe('job.feed.kind.assigned');
  });

  // why: F-698, CTL-OFC-03-11 (equipment.type's seeded codes print as words; a type someone typed prints as typed)
  it('words the equipment codes and leaves a typed type as it is', () => {
    for (const lang of langs) {
      const t = (k: string) => catalogs[lang][k as keyof (typeof catalogs)['en']] as string;
      expect(equipmentWord(t, 'air_conditioner')).toBe(t('customers.equipment.air_conditioner'));
      expect(equipmentWord(t, 'Boiler, oil')).toBe('Boiler, oil');
    }
  });
});

describe('the notes (F-701)', () => {
  // why: F-701, FR-DISP-5 (the job's notes and the customer's show together, newest first)
  it('merges the job\'s and the customer\'s notes, newest first', () => {
    const note = (id: string, at: string) => ({ id, kind: 'office', author: null, body: id, at, sentAt: at, enteredOffline: false }) as Job['notes'][number];
    const z = '-04:00[America/New_York]';
    expect(notesOf({ notes: [note('job', `2026-09-10T09:00:00${z}`)], customer: { notes: [note('newer', `2026-09-12T09:00:00${z}`), note('older', `2025-10-14T11:00:00${z}`)] } }).map((n) => n.id))
      .toEqual(['newer', 'job', 'older']);
  });
});

describe('the equipment Type field (CTL-OFC-37-01)', () => {
  // why: F-852 a typed type was stored as typed, so a Spanish page read "Water heater 2024" beside a seeded "Calentador de agua"
  it('sends a suggested word or a code as its code, and anything else as typed', () => {
    const t = (key: string) => ({ 'customers.equipment.water_heater': 'Water heater', 'customers.equipment.furnace': 'Furnace', 'customers.equipment.air_conditioner': 'Air conditioner', 'customers.equipment.thermostat': 'Thermostat' } as Record<string, string>)[key] ?? key;
    expect(equipmentSuggestions(t as never).map((s) => s.code)).toEqual(['furnace', 'air_conditioner', 'water_heater', 'thermostat']);
    expect(equipmentTypeSent(t as never, ' water HEATER ')).toBe('water_heater');
    expect(equipmentTypeSent(t as never, 'thermostat')).toBe('thermostat');
    expect(equipmentTypeSent(t as never, 'Heat pump')).toBe('Heat pump');
  });
});

describe('job page read-failure words', () => {
  // why: UI-SPECIFICATION CTL-OFC-23-01, F-704 (API-07 and API-110 failing are said in words, never a quiet negative: UI-SPECIFICATION 297)
  it('has the words for a failed API-07 read and a failed API-110 read, in both languages', () => {
    const en = catalogs.en as Record<string, string>;
    const es = catalogs.es as Record<string, string>;
    expect(en['job.actionsError']).toBe('Your actions could not load.');
    expect(en['job.edit.servicesError']).toBe('The services could not load.');
    expect(es['job.actionsError']).toBeTruthy();
    expect(es['job.edit.servicesError']).toBeTruthy();
  });
});
