// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeSms, isGsm7 } from './gsm.ts';

// OUTSIDE vectors. packages/sms/vectors/ holds verbatim copies of the test data of the
// open-source split-sms library (MIT, David Wood), https://github.com/codesleuth/split-sms,
// commit 20b271e7c08adfce880b714f65a4f9c5dec0f8ad, files test/testdata/gsm.test.json and
// unicode.test.json. Their expected values (parts, totalBytes) come from that library,
// not from this repo. Mapping: messages = parts.length; units = totalBytes for GSM-7
// (septets, extension characters count 2), totalBytes / 2 for UCS-2 (UTF-16 units).
interface Vector {
  description: string;
  message: string;
  parts: unknown[];
  totalBytes: number;
}
const load = (f: string): Vector[] =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../vectors/${f}`, import.meta.url)), 'utf8')) as Vector[];

// The 2 vectors below are excluded from the vector loop: they drive the library's forced-GSM splitter
// (lib/gsmsplitter.js at 20b271e7), which replaces each non-GSM character with a space, so they test that
// lossy substitution, not GSM 03.38. The library's public split() switches to UCS-2 for both texts. The
// GSM 03.38 counts for the same 2 texts are asserted below instead (F-169).
const EXCLUDED = new Set(['Split 160 two-byte character message', 'Split 160 surrogate-pairs character message']);

// The "every valid GSM character" string from split-sms test/gsmvalidator.test.js.
const ALL_GSM =
  '@Δ\x200¡P¿p£_!1AQaq$Φ"2BRbr¥Γ#3CScsèΛ¤4DTdtéΩ%5EUeuùΠ&6FVfvìΨ\'7GWgwòΣ(8HXhxÇΘ)9IYiy\nΞ*:JZjzØ+;KÄkäøÆ,<LÖlö\ræ-=MÑmñÅß.>NÜnüåÉ/?O§oà|^€{}[~]\\\f';

describe('segment counter against outside GSM 03.38 vectors', () => {
  const vectors = [...load('split-sms-gsm.test.json'), ...load('split-sms-unicode.test.json')].filter(
    (v) => !EXCLUDED.has(v.description),
  );

  // why: HC-06
  it('loads the vendored vectors', () => {
    expect(vectors.length).toBe(19);
  });

  for (const v of vectors) {
    // why: HC-06 the analyzer gives each outside vector's message count and unit count
    it(`matches: ${v.description}`, () => {
      const a = analyzeSms(v.message);
      expect(a.messages).toBe(v.parts.length);
      expect(a.units).toBe(a.encoding === 'GSM-7' ? v.totalBytes : v.totalBytes / 2);
    });
  }

  // why: HC-06
  it('counts the 2 excluded vectors as UCS-2 texts: 160 snowmen are 160 units, 3 messages; 160 whales are 320 units, 5 messages', () => {
    expect(analyzeSms('\u2603'.repeat(160))).toEqual({ encoding: 'UCS-2', units: 160, messages: 3 });
    expect(analyzeSms('\u{1F40B}'.repeat(160))).toEqual({ encoding: 'UCS-2', units: 320, messages: 5 });
  });

  // why: HC-06
  it('accepts every GSM character in the outside all-characters string', () => {
    expect(isGsm7(ALL_GSM)).toBe(true);
  });
});

describe('HC-06 acceptance: 160 GSM-7 or 70 UCS-2 per message, 1 UCS-2 character switches the text', () => {
  // why: HC-06
  it('holds 160 GSM-7 characters in 1 message and 161 in 2', () => {
    expect(analyzeSms('a'.repeat(160))).toEqual({ encoding: 'GSM-7', units: 160, messages: 1 });
    expect(analyzeSms('a'.repeat(161)).messages).toBe(2);
  });

  // why: HC-06
  it('holds 70 UCS-2 characters in 1 message and 71 in 2', () => {
    expect(analyzeSms('☃'.repeat(70)).messages).toBe(1);
    expect(analyzeSms('☃'.repeat(71)).messages).toBe(2);
  });

  // why: HC-06
  it.each(['á', 'í', 'ó', 'ú', '’', '“'])(
    'one %s switches a 160-character text to UCS-2 and 3 messages',
    (ch) => {
      const a = analyzeSms(`${'a'.repeat(159)}${ch}`);
      expect(a.encoding).toBe('UCS-2');
      expect(a.messages).toBe(3);
    },
  );

  // why: HC-06
  it('keeps e-acute and n-tilde in GSM-7', () => {
    expect(analyzeSms('éñ').encoding).toBe('GSM-7');
  });
});
