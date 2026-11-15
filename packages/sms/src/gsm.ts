// SPDX-License-Identifier: AGPL-3.0-or-later
// GSM 03.38 (3GPP TS 23.038) segment arithmetic (HC-06).
// 1 message holds 160 GSM-7 septets or 70 UCS-2 units. A longer text is sent as
// concatenated parts of 153 septets or 67 units. One character outside the GSM-7
// alphabets switches the whole text to UCS-2.

// Default alphabet, septet 0x00 to 0x7F in order (0x1B is the escape, not a character).
const BASIC_CHARS =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001BÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
// Extension table: each of these costs 2 septets (escape plus code).
const EXT_CHARS = '\f^{}\\[~]|€';

const BASIC = new Set(BASIC_CHARS.replace('\u001B', ''));
const EXT = new Set(EXT_CHARS);

export type SmsEncoding = 'GSM-7' | 'UCS-2';

export interface SmsAnalysis {
  encoding: SmsEncoding;
  /** Septets for GSM-7 (extension characters count 2), UTF-16 units for UCS-2. */
  units: number;
  /** Messages the text needs. An empty text is 1 message. */
  messages: number;
}

export function isGsm7Char(ch: string): boolean {
  return BASIC.has(ch) || EXT.has(ch);
}

export function isGsm7BasicChar(ch: string): boolean {
  return BASIC.has(ch);
}

/** The characters of text that are not in the GSM-7 alphabets (by code point). */
export function nonGsm7Chars(text: string): string[] {
  return [...text].filter((ch) => !isGsm7Char(ch));
}

export function isGsm7(text: string): boolean {
  return nonGsm7Chars(text).length === 0;
}

/** Pack costs (each at most `size`) into parts without splitting a cost across parts. */
function countParts(costs: number[], size: number): number {
  let parts = 1;
  let used = 0;
  for (const c of costs) {
    if (used + c > size) {
      parts += 1;
      used = 0;
    }
    used += c;
  }
  return parts;
}

export function analyzeSms(text: string): SmsAnalysis {
  if (isGsm7(text)) {
    const costs = [...text].map((ch) => (EXT.has(ch) ? 2 : 1));
    const units = costs.reduce((a, b) => a + b, 0);
    return { encoding: 'GSM-7', units, messages: units <= 160 ? 1 : countParts(costs, 153) };
  }
  // UCS-2: a character outside the BMP is a surrogate pair of 2 units, never split.
  const costs = [...text].map((ch) => ch.length);
  const units = costs.reduce((a, b) => a + b, 0);
  return { encoding: 'UCS-2', units, messages: units <= 70 ? 1 : countParts(costs, 67) };
}
