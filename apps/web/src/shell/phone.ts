// SPDX-License-Identifier: AGPL-3.0-or-later
// The 1 way a stored phone number is shown (F-1888). Numbers are stored as they came: a mobile as E.164 ("+16145550163"), a home
// phone as typed ("(614) 555-0163", "614.555.0163"). Every screen shows them through formatPhone; a tel: link keeps its own digits
// (keys.ts telHref). No React, no network.

const digits = (s: string) => s.replace(/\D/g, '');

/** 10 digits (or 11 with a leading 1) of a US number; null otherwise (FR-TEXT-13, CTL-OFC-38-02). */
export function usDigits(text: string): string | null {
  const d = digits(text);
  if (d.length === 10) return d;
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return null;
}

/** "(614) 555-0163" for an E.164 number or any 10-digit text; the input back when it is neither. */
export function formatPhone(value: string | null): string {
  if (!value) return '';
  const d = usDigits(value);
  return d ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : value;
}
