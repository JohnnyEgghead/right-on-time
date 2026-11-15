// SPDX-License-Identifier: AGPL-3.0-or-later
// F-253: the catalog keys the seed writes (branch.name_key, service_type.*_key, arrival_window.label_key) are a contract
// between the seed and the UI lanes that render them (D-16 gives the values to those lanes). Each key family is checked in
// both catalogs from the moment its rendering lane has landed; a family not yet rendered is listed with the lane that owes
// its values, so a landed lane moves its family into the checked set and no seeded key can go missing silently.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRANCHES, FOUR_HOUR_WINDOWS, SERVICES, TWO_HOUR_WINDOWS } from './reference-data.ts';

const CATALOG = path.resolve(import.meta.dirname, '../../../i18n/catalog');
const read = (lang: string) => JSON.parse(readFileSync(path.join(CATALOG, `${lang}.json`), 'utf8')) as Record<string, string>;

const hh = (h: number) => String(h).padStart(2, '0');
/** Every key the seed writes, by family (packages/db/src/seed/index.ts, steps 1, 3 and 8). */
export const SEEDED_KEYS: Record<string, string[]> = {
  'service screen label': SERVICES.map((s) => `service.${s.id}.screen`),
  'service text label': SERVICES.map((s) => `service.${s.id}.text`),
  'service price text': SERVICES.map((s) => `service.${s.id}.price`),
  'service typical length': SERVICES.map((s) => `service.${s.id}.length`),
  'branch name': BRANCHES.map((b) => `branch.${b.id}`),
  'window label': [...TWO_HOUR_WINDOWS.map(([s]) => `window.two_hour.${hh(s)}`), ...FOUR_HOUR_WINDOWS.map(([s]) => `window.four_hour.${hh(s)}`)],
};

/** The families whose rendering lane has landed: P4-BOARD (job blocks), P3-TEXTS (the customer texts) and P5-BOOKING (the service price and length lines). */
export const RENDERED = ['service screen label', 'service text label', 'service price text', 'service typical length'];
/** The families no landed lane renders yet, each with the lane that owes its catalog values. */
export const PENDING: Record<string, string> = {
  'branch name': 'the first lane that renders a branch name from its name_key (the top bar names branches from apps/web/src/shell/branches.ts)',
  'window label': 'the first lane that renders a window from its label_key (P5-BOOKING; the board builds window text from its times)',
};

describe('seeded catalog keys (F-253)', () => {
  // why: F-253 every key a landed lane renders resolves in both catalogs
  it('resolves every seeded key of a rendered family in en.json and es.json', () => {
    const en = read('en');
    const es = read('es');
    const missing = RENDERED.flatMap((f) => (SEEDED_KEYS[f] ?? []).flatMap((k) => [...(k in en ? [] : [`en ${k}`]), ...(k in es ? [] : [`es ${k}`])]));
    expect(missing).toEqual([]);
  });

  // why: F-253 no seeded key family is left unaccounted: it is checked, or pending with the lane that owes it
  it('names every seeded family as rendered or pending, and a pending family has no key in the catalog yet', () => {
    expect([...RENDERED, ...Object.keys(PENDING)].sort()).toEqual(Object.keys(SEEDED_KEYS).sort());
    const en = read('en');
    // A pending family that gains a key has landed: move it into RENDERED so all its keys are checked.
    for (const f of Object.keys(PENDING)) expect((SEEDED_KEYS[f] ?? []).filter((k) => k in en), f).toEqual([]);
  });
});
