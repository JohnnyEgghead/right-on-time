// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCatalog } from './catalog-format.ts';

const es = parseCatalog(readFileSync(fileURLToPath(new URL('../catalog/es.json', import.meta.url)), 'utf8'), 'es.json');

/** Every Spanish key that promises the R reply to a customer (or tells the office what the customer is asked). */
const PROMISES = ['booking.done.n2.body', 'booking.fine', 'text.confirmation', 'text.reminder', 'text.reminder_today', 'windows.rules.reminder.d'];

describe('the Spanish R reply word (F-1525, F-1564; owner answer c9fd8cfe "Use cambiar")', () => {
  // why: F-1525 a customer reads one reply word in every Spanish text, so no value may promise "R para reprogramar" (or any word but cambiar)
  it('names the R reply "R para cambiar" in every key that promises it, and in no other way', () => {
    for (const key of PROMISES) expect(es[key], key).toContain('R para cambiar.');
    const wrong = Object.entries(es).filter(([, v]) => /\bR para (?!cambiar\b)/.test(v)).map(([k]) => k);
    expect(wrong).toEqual([]);
  });
});
