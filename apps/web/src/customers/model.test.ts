// SPDX-License-Identifier: AGPL-3.0-or-later
// The customer screens' pure rules (P4-CUSTOMERS): the search text's highlighting and emptiness, the New customer and Edit customer
// form rules, phone and window text.
import { catalogs } from '@bw/i18n';
import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import type { ClientT } from '../shell/intl.tsx';
import {
  clockText, CONTROL_CONTRACT, EMPTY_FORM, equipmentLine, formatPhone, formHasInput, formProblems, jobsSearchRequest, lineWord, markParts, NO_FILTERS, noteWhen, searchIsEmpty,
  textsAllowed, usDigits, windowText,
  type CustomerForm,
} from './model.ts';

const STREET = { streetId: '0192f000-0000-7000-8000-0000000000b1', name: 'Calumet St', city: 'Clintonville', zip: '43202', branch: 'columbus' };
const valid: CustomerForm = { ...EMPTY_FORM, name: 'Lucia Moreno', mobile: '(614) 555-0172', street: STREET, streetText: 'Calumet St, Clintonville, 43202', houseNumber: '2310' };

describe('search text (FR-DISP-7, FR-DISP-30)', () => {
  // why: FR-DISP-7 the matched part of a name is marked the way the server matches it: apostrophes ignored, capitals ignored
  it('marks the part of the name the folded query matches', () => {
    expect(markParts("Sean O'Brien", 'obrien')).toEqual([{ text: 'Sean ', hit: false }, { text: "O'Brien", hit: true }]);
    expect(markParts("Kathleen O'Brien-Miller", "O'BRIEN")).toEqual([{ text: 'Kathleen ', hit: false }, { text: "O'Brien", hit: true }, { text: '-Miller', hit: false }]);
    expect(markParts('Kathy OBrien', 'obrien').find((p) => p.hit)?.text).toBe('OBrien');
    expect(markParts('Harold Jenkins', 'obrien')).toEqual([{ text: 'Harold Jenkins', hit: false }]);
    expect(markParts('Harold Jenkins', '')).toEqual([{ text: 'Harold Jenkins', hit: false }]);
  });

  // why: FR-DISP-30 no text and no filter is the Empty state (nothing is sent); any filter makes a search
  it('is empty only with no text and no filter', () => {
    expect(searchIsEmpty('   ', NO_FILTERS)).toBe(true);
    expect(searchIsEmpty('obrien', NO_FILTERS)).toBe(false);
    expect(searchIsEmpty('', { ...NO_FILTERS, upcomingVisit: false })).toBe(false);
  });
});

describe('phone and window text (FR-DISP-31)', () => {
  // why: FR-DISP-31 a mobile number is shown as (614) 555-0163 and read as 10 US digits however it was typed
  it('formats E.164 and reads 10 digits, with or without a leading 1', () => {
    expect(formatPhone('+16145550163')).toBe('(614) 555-0163');
    expect(formatPhone(null)).toBe('');
    expect(usDigits('(614) 555-0172')).toBe('6145550172');
    expect(usDigits('1-614-555-0172')).toBe('6145550172');
    expect(usDigits('555-0172')).toBeNull();
  });

  // why: FR-DISP-31 a visit window and an arrival estimate read as the pages print them
  it('prints windows and arrival times', () => {
    expect(windowText('2026-09-17T10:00:00-04:00[America/New_York]', '2026-09-17T12:00:00-04:00[America/New_York]')).toBe('10 AM-12 PM');
    expect(windowText('2026-09-17T08:00:00-04:00[America/New_York]', '2026-09-17T10:00:00-04:00[America/New_York]')).toBe('8-10 AM');
    expect(clockText('2026-09-15T10:40:00-04:00[America/New_York]')).toBe('10:40 AM');
    expect(clockText('2026-09-15T14:00:00-04:00[America/New_York]')).toBe('2:00 PM');
  });
});

describe('the customer form (FR-DISP-29, FR-DISP-31)', () => {
  // why: FR-DISP-29 a valid name, a picked street and a house number can be saved; the mobile number is optional
  it('has no problem with a name, a picked street and a house number', () => {
    expect(formProblems(valid)).toEqual([]);
    expect(formProblems({ ...valid, mobile: '' })).toEqual([]);
  });

  // why: FR-DISP-29 an empty name, a number that is not 10 digits, a street typed but not picked and a house number outside 1 to 99999 each stop the save
  it('names each problem: name, mobile, street and house number', () => {
    expect(formProblems({ ...valid, name: '  ' })).toEqual(['name']);
    expect(formProblems({ ...valid, mobile: '555-0172' })).toEqual(['mobile']);
    expect(formProblems({ ...valid, street: null })).toEqual(['street']);
    expect(formProblems({ ...valid, houseNumber: '0' })).toEqual(['house']);
    expect(formProblems({ ...valid, houseNumber: '100000' })).toEqual(['house']);
    expect(formProblems({ ...valid, houseNumber: '12a' })).toEqual(['house']);
    expect(formProblems(EMPTY_FORM)).toEqual(['name', 'street', 'house']);
  });

  // why: FR-DISP-29 texts need a mobile phone, and Cancel asks to discard only when there is input
  it('allows texts only with a mobile number and asks to discard only with input', () => {
    expect(textsAllowed({ mobile: '(614) 555-0172' })).toBe(true);
    expect(textsAllowed({ mobile: '' })).toBe(false);
    expect(formHasInput(EMPTY_FORM)).toBe(false);
    expect(formHasInput({ ...EMPTY_FORM, streetText: 'Cal' })).toBe(true);
  });
});

describe('equipment line (F-716)', () => {
  const intl = createIntl({ locale: 'en', messages: catalogs.en as Record<string, string>, onError: () => undefined });
  const t = ((key: string) => intl.formatMessage({ id: key })) as unknown as ClientT;

  // why: F-716 a Type someone typed in SCR-OFC-37 is no catalog key: it shows as typed, never as a key or as another key's words
  it('words a coded type from the catalog and shows a typed type as typed', () => {
    expect(equipmentLine(t, { type: 'furnace', year: 2011 })).toBe('Gas furnace 2011');
    expect(equipmentLine(t, { type: 'water_heater', year: null })).toBe('Water heater');
    expect(equipmentLine(t, { type: 'Boiler', year: 2015 })).toBe('Boiler 2015');
    expect(equipmentLine(t, { type: 'title', year: null })).toBe('title');
  });
});

describe('Also found in jobs (CTL-OFC-05-15; FR-DISP-30)', () => {
  const intl = createIntl({ locale: 'en', messages: catalogs.en as Record<string, string>, onError: () => undefined });
  const t = ((key: string, values?: Record<string, string | number>) => intl.formatMessage({ id: key }, values)) as unknown as ClientT;

  // why: FR-DISP-30 the jobs read is the Jobs page's search (tab All, Today and upcoming) in the Branch filter's branch or, with All branches, the top bar's; no text or no branch sends nothing
  it('builds the API-133 request from the text, the filter branch and the top-bar branch', () => {
    expect(jobsSearchRequest(' obrien ', 'dayton', 'columbus')).toEqual({ query: 'obrien', branch: 'dayton', tab: 'all', date: 'upcoming' });
    expect(jobsSearchRequest('obrien', null, 'columbus')).toEqual({ query: 'obrien', branch: 'columbus', tab: 'all', date: 'upcoming' });
    expect(jobsSearchRequest('   ', 'dayton', 'columbus')).toBeNull();
    expect(jobsSearchRequest('obrien', null, null)).toBeNull();
  });

  // why: FR-DISP-30 the line's service word starts in lower case ("furnace tune-up") and an acronym keeps its capitals ("AC tune-up")
  it('lowers the first letter of a service word but not an acronym', () => {
    expect(lineWord('Furnace tune-up')).toBe('furnace tune-up');
    expect(lineWord('AC tune-up')).toBe('AC tune-up');
  });

  // why: FR-DISP-31 a note on the customer page shows its time (CTL-OFC-06-22: author and time): the day in the page's year, the date with its year before it
  it('words a note\'s time with the weekday in the page\'s year and with the year before it', () => {
    expect(noteWhen(t, '2026-09-15T10:31:00-04:00[America/New_York]', 2026)).toBe('Tue, Sep 15, 10:31 AM');
    expect(noteWhen(t, '2025-10-14T09:00:00-04:00[America/New_York]', 2026)).toBe('Oct 14, 2025, 9:00 AM');
  });

  // why: FR-DISP-31 each role-gated control of the page reads the API entry it calls (F-565): Text API-143, Add equipment API-141, Edit API-142, Add note API-140, the inbox API-37
  it('names the contract each role-gated control calls', () => {
    expect(CONTROL_CONTRACT).toEqual({ inbox: 'API-37', text: 'API-143', addEquipment: 'API-141', editEquipment: 'API-142', note: 'API-140' });
  });
});
