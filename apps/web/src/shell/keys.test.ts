// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { BRANCHES } from './branches.ts';
import { callMode, PHONE_QUERY, searchQuery, slashFocusesSearch, telHref } from './keys.ts';

describe('"/" shortcut (CTL-CMP-07-10)', () => {
  const page = { tagName: 'BODY' };
  // why: FR-DISP-11 with the shortcut on, as it is by default, pressing "/" on the board focuses the box
  it('focuses search with the switch on, outside any text field', () => {
    expect(slashFocusesSearch({ key: '/' }, page, true)).toBe(true);
    expect(slashFocusesSearch({ key: '/' }, { tagName: 'BUTTON' }, true)).toBe(true);
    expect(slashFocusesSearch({ key: '/', ctrlKey: true }, page, true)).toBe(false);
    expect(slashFocusesSearch({ key: 'a' }, page, true)).toBe(false);
  });
  // why: FR-DISP-11 "/" typed in a note field stays in the note; with the shortcut off "/" leaves focus where it was
  it('leaves "/" in a text field, and does nothing with the switch off', () => {
    for (const t of [{ tagName: 'TEXTAREA' }, { tagName: 'INPUT', type: 'text' }, { tagName: 'INPUT', type: 'search' }, { tagName: 'DIV', isContentEditable: true }]) {
      expect(slashFocusesSearch({ key: '/' }, t, true), t.tagName).toBe(false);
    }
    expect(slashFocusesSearch({ key: '/' }, { tagName: 'INPUT', type: 'checkbox' }, true)).toBe(true);
    expect(slashFocusesSearch({ key: '/' }, page, false)).toBe(false);
  });
  // why: FR-DISP-11 the 1 box searches as typed (apostrophes kept: "O'Brien"); CTL-CMP-07-05
  it('sends the query exactly as typed, trimmed only, from 2 characters', () => {
    expect(searchQuery(" O'Brien ")).toBe("O'Brien");
    expect(searchQuery('2')).toBeNull();
    expect(searchQuery('24825')).toBe('24825');
  });
});

describe('CMP-16 call button', () => {
  // why: FR-DISP-20 a telephone link on a phone, the number shown on a computer
  it('dials on a phone and reveals the number on a computer, by the SD-33 media query only', () => {
    const seen: string[] = [];
    expect(callMode((q) => (seen.push(q), { matches: true }))).toBe('dial');
    expect(callMode(() => ({ matches: false }))).toBe('reveal');
    expect(callMode(undefined)).toBe('reveal');
    expect(seen).toEqual([PHONE_QUERY]);
    expect(PHONE_QUERY).toBe('(pointer: coarse) and (hover: none)');
  });
  // why: FR-DISP-20 every number a sample Call control dials is in the FR-IMP-7 range or a branch office number
  it('links the number with its country code, and every branch office number is in the sample range', () => {
    expect(telHref('(614) 555-0112')).toBe('tel:+16145550112');
    for (const b of BRANCHES) expect(b.officePhone, b.name).toMatch(/^\((614|937)\) 555-01\d\d$/);
  });
});
