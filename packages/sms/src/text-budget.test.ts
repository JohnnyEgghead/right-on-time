// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { runCli } from './cli.ts';
import { analyzeSms } from './gsm.ts';
import { ARMS, CHECK_ARMS, GOOD_TEMPLATES, goodInput, standInSlotValues } from './fixtures.ts';
import { BOOKABLE_DAYS, FIXED_COPY_MAX, runTextBudgetCheck, SLOT_MAX, templatesFromCatalogs } from './text-budget.ts';

describe('text-budget-check (FR-TEXT-9)', () => {
  // why: FR-TEXT-9, F-419
  it('passes the good fixture set and counts its renders', () => {
    const r = runTextBudgetCheck(goodInput());
    expect(r.failures).toEqual([]);
    expect(r.outcome).toBe('pass');
    expect(r.templates).toBe(5);
    // English confirmation alone is 6 days x 372 dates x 8 windows x 4 services; the Spanish copy prints no weekday (F-419).
    expect(r.renders).toBeGreaterThan(80000);
  });

  // why: FR-TEXT-9
  it('renders every bookable day, Saturday included, as the visit day', () => {
    expect(BOOKABLE_DAYS).toEqual([1, 2, 3, 4, 5, 6]);
    const seen = new Set<string>();
    const input = goodInput();
    const wd = input.slots.weekday;
    input.slots.weekday = (lang, day) => {
      if (lang === 'en') seen.add(`${day}`);
      return wd(lang, day);
    };
    runTextBudgetCheck({ ...input, templates: GOOD_TEMPLATES.filter((t) => t.id === 'r-reply') });
    expect([...seen].sort()).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  for (const arm of ARMS) {
    // why: FR-TEXT-9 each arm fails the budget check with the failure kind it names
    it(`fails ${arm.name}`, () => {
      for (const c of arm.cases) {
        const r = runTextBudgetCheck(c);
        expect(r.outcome).toBe('fail');
        expect(r.failures.some((f) => f.kind === arm.expect)).toBe(true);
      }
    });
  }

  // why: FR-TEXT-9
  it('arm 2 is exactly 161 GSM-7 characters, 2 messages', () => {
    const arm = ARMS.find((a) => a.name.startsWith('arm-2'));
    const r = runTextBudgetCheck(arm!.cases[0]!);
    expect(r.failures.find((f) => f.kind === 'over-160')!.detail).toContain('161 septets, 2 messages');
  });

  // why: FR-TEXT-9
  it('arm 5 has 2 cases, "Sab" with accent and the long word, and each fails on UCS-2', () => {
    const arm = ARMS.find((a) => a.name.startsWith('arm-5'));
    expect(arm!.cases).toHaveLength(2);
    for (const c of arm!.cases) expect(runTextBudgetCheck(c).failures.some((f) => f.kind === arm!.expect)).toBe(true);
  });

  // why: FR-TEXT-9
  it('fails a slot value over its SD-17 maximum (a 4-character English weekday)', () => {
    const input = goodInput();
    const wd = input.slots.weekday;
    input.slots.weekday = (lang, day) => (lang === 'en' && day === 2 ? 'Tues' : wd(lang, day));
    const r = runTextBudgetCheck(input);
    expect(r.failures.some((f) => f.kind === 'slot-over-max')).toBe(true);
  });

  // why: FR-TEXT-9
  it('fails a template that uses a slot the budget table does not list', () => {
    const r = runTextBudgetCheck({
      ...goodInput(),
      templates: [{ id: 'x', text: { en: 'Hi {nope}', es: 'Hola {nope}' } }],
    });
    expect(r.failures.some((f) => f.kind === 'unknown-slot')).toBe(true);
  });
});

describe('text-budget-check over the real template set (W-50 zero-template trap)', { timeout: 60000 }, () => {
  const en = { 'common.ok': 'OK' };
  const es = { 'common.ok': 'OK' };

  // why: FR-TEXT-9
  it('reports an empty real set as outcome empty with 0 renders, never a pass', () => {
    const { templates } = templatesFromCatalogs(en, es);
    const r = runTextBudgetCheck({ ...goodInput(), templates });
    expect(r.outcome).toBe('empty');
    expect(r.renders).toBe(0);
  });

  // why: FR-TEXT-9
  it('cli prints the empty outcome and the render count, and --require-templates exits 2', () => {
    const soft = runCli(en, es, { requireTemplates: false });
    expect(soft.exit).toBe(0);
    expect(soft.lines.join('\n')).toContain('0 templates, 0 renders, outcome empty');
    expect(soft.lines.join('\n')).toContain('NOT a pass');
    expect(runCli(en, es, { requireTemplates: true }).exit).toBe(2);
  });

  // why: FR-TEXT-9
  it('cli runs the 5 FR-TEXT-9 arms and the 5 check arms every time and they all fail as expected', () => {
    const lines = runCli(en, es, { requireTemplates: false }).lines;
    expect(lines.filter((l) => l.startsWith('FAILS-AS-EXPECTED'))).toHaveLength(10);
  });

  // why: FR-TEXT-9
  it('cli checks real templates from text.<id> keys and fails a UCS-2 one', () => {
    const good = runCli({ 'text.late': 'Late at {arrival}' }, { 'text.late': 'Tarde a las {arrival}' }, {
      requireTemplates: false,
    });
    expect(good.exit).toBe(0);
    expect(good.lines.join('\n')).toContain('1 templates, 6 renders');
    const bad = runCli({ 'text.late': 'Late' }, { 'text.late': 'Llegará' }, { requireTemplates: false });
    expect(bad.exit).toBe(1);
  });

  // why: FR-TEXT-9
  it('cli fails a template present in one language only', () => {
    expect(runCli({ 'text.late': 'Late' }, {}, { requireTemplates: false }).exit).toBe(1);
  });

  // why: FR-TEXT-9
  it('fails each of the 4 check arms with its own kind (F-163, F-165, F-166, F-167)', () => {
    expect(CHECK_ARMS.map((a) => a.expect)).toEqual(['not-gsm7', 'no-renders', 'formatted-slot', 'over-160', 'fixed-over-budget']);
    for (const arm of CHECK_ARMS) {
      for (const c of arm.cases) expect(runTextBudgetCheck(c).failures.map((f) => f.kind)).toContain(arm.expect);
    }
  });

  // why: FR-TEXT-9
  // F-1122: the window slot's maximum is 15 with the zone named ("10 AM-12 PM EDT"), so the maxima total is 164 (it was 163 with 14)
  it('arm 9 passes at the stand-in values and fails only at the SD-17 maxima (F-167)', () => {
    const arm = CHECK_ARMS.find((a) => a.name.startsWith('arm-9'))!;
    const c = arm.cases[0]!;
    const atStandIns = c.templates.find((t) => t.id === 'reminder')!.text.en.replace('{window}', '10 AM-12 PM');
    expect(analyzeSms(atStandIns)).toMatchObject({ units: 160, messages: 1 });
    expect(runTextBudgetCheck(c).failures.find((f) => f.kind === 'over-160')?.detail).toContain('164 septets at the SD-17 slot maxima');
  });

  // why: FR-TEXT-9
  it('refuses an extension-table character in a slot value, which costs 2 septets (F-163)', () => {
    const base = standInSlotValues({}, [1]);
    const r = runTextBudgetCheck({
      ...goodInput(true),
      slots: { ...base, values: { ...base.values, service: { en: ['Tune [up]'], es: ['Mantenimiento'] } } },
    });
    expect(r.failures.map((f) => f.kind)).toContain('slot-not-basic');
  });
});

describe('SD-17 slot maxima and fixed-copy budgets (F-1443)', () => {
  // why: FR-TEXT-9 the Spanish window slot max is 20, English 15 (SD-17: "de 10 AM a 12 PM EDT" is 20 characters)
  it('holds the Spanish window maximum at 20 and the English at 15', () => {
    expect(SLOT_MAX.window).toEqual({ en: 15, es: 20 });
    expect('de 10 AM a 12 PM EDT'.length).toBe(20);
  });

  // why: FR-TEXT-9 the fixed-copy budgets are the SD-17 figures, none looser
  it('holds the SD-17 fixed-copy budgets', () => {
    expect(FIXED_COPY_MAX).toEqual({
      confirmation: { en: 114, es: 106 },
      reminder: { en: 145, es: 140 },
      reminder_today: { en: 145, es: 140 },
      on_the_way: { en: 112, es: 112 },
      late: { en: 142, es: 142 },
      r_reply: { en: 117, es: 114 },
    });
  });

  // why: FR-TEXT-9 a Spanish confirmation 1 character over the 106 fixed-copy budget fails, though it fits 160 characters
  it('fails a Spanish confirmation whose fixed copy is 107 characters', () => {
    const base = goodInput();
    const fixed = 'x'.repeat(107 - ' {date} {window} {service}'.replace(/\{\w+\}/g, '').length);
    const bad = { ...base, templates: [{ id: 'confirmation', text: { en: 'Brightwater: {weekday} {date} {window} {service}', es: `${fixed} {date} {window} {service}` } }] };
    const r = runTextBudgetCheck(bad);
    expect(r.failures.some((f) => f.kind === 'fixed-over-budget' && f.lang === 'es')).toBe(true);
    const ok = { ...base, templates: [{ id: 'confirmation', text: { en: bad.templates[0]!.text.en, es: `${fixed.slice(1)} {date} {window} {service}` } }] };
    expect(runTextBudgetCheck(ok).failures.some((f) => f.kind === 'fixed-over-budget')).toBe(false);
  });
});
