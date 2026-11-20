// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1893 infra/README.md's settings table is held to the settings schema and to compose.yaml by this test, so the public copy's list of settings cannot drift.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { settingsSchema } from '../../packages/config/src/index.ts';

const root = path.resolve(import.meta.dirname, '../..');
const read = (f: string): string => readFileSync(path.join(root, f), 'utf8');

/** The rows of the "## The settings table" section: setting name to its default cell. */
function tableRows(): Map<string, string> {
  const section = read('infra/README.md').split('\n## The settings table\n')[1]?.split('\n## ')[0] ?? '';
  const rows = new Map<string, string>();
  for (const line of section.split('\n')) {
    const m = /^\| `([A-Z][A-Z0-9_]*)` \| (.+?) \| .+ \|$/.exec(line);
    if (m && m[1] !== 'HTTP_BIND') rows.set(m[1]!, m[2]!);
  }
  return rows;
}

/**
 * The own-copy default of each schema setting compose.yaml sets, at any indent and in any service: `KEY: ${KEY:-default}`.
 * Each place is kept, so a key set in 2 places with 2 defaults shows (F-1903).
 */
function composePlaces(): Map<string, string[]> {
  const keys = new Set(Object.keys(settingsSchema.shape));
  const out = new Map<string, string[]>();
  for (const m of read('infra/compose.yaml').matchAll(/^ *([A-Z][A-Z0-9_]*): \$\{\1:-(.*)\}$/gm)) {
    if (keys.has(m[1]!)) out.set(m[1]!, [...(out.get(m[1]!) ?? []), m[2]!]);
  }
  return out;
}

/** The first default of each key (the test below checks that every place agrees). */
function composeDefaults(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, places] of composePlaces()) out.set(key, places[0]!);
  return out;
}

describe('infra/README.md settings table (F-1893)', () => {
  // why: F-1893 the table's set of names equals the schema's set of keys, compared both ways
  it('names every key of the settings schema, and no other', () => {
    const table = [...tableRows().keys()].sort();
    const schema = Object.keys(settingsSchema.shape).sort();
    expect(table.filter((k) => !schema.includes(k)), 'in the table, not in the schema').toEqual([]);
    expect(schema.filter((k) => !table.includes(k)), 'in the schema, not in the table').toEqual([]);
  });

  // why: F-1893 each default the table gives equals the default compose.yaml sets, wherever compose sets it (F-1903)
  it('gives each key compose.yaml sets the same default as compose', () => {
    const rows = tableRows();
    const places = composePlaces();
    expect(places.size).toBeGreaterThan(10);
    for (const [key, defs] of places) {
      expect(new Set(defs).size, `${key} has 1 default in every place compose sets it`).toBe(1);
      const def = defs[0]!;
      // An empty default (`${KEY:-}`) is not set: the table's cell says "not set" (F-1903).
      if (def === '') expect(rows.get(key), `${key} has a "not set" row`).toMatch(/^not set\b/);
      else expect(rows.get(key), `${key} has a row`).toBe(`\`${def}\``);
    }
  });

  // why: F-1903 the keys compose sets outside the x-settings block are compared too, not skipped
  it('reads the keys compose sets outside the x-settings block', () => {
    const keys = [...composePlaces().keys()];
    for (const k of ['ACCESS_CODE', 'ACCESS_COOKIE_KEY', 'SAMPLE_PASSWORD_SEED', 'REVIEWER_PASSWORD', 'IOS_INSTALL_KIND', 'IOS_INSTALL_LINK']) expect(keys).toContain(k);
  });

  // why: F-1890 the own-copy default of the idle reset stays 120 in compose (0 turns it off but is never the default)
  it('keeps IDLE_RESET_MINUTES at 120 in compose', () => {
    expect(composeDefaults().get('IDLE_RESET_MINUTES')).toBe('120');
  });
});
