// SPDX-License-Identifier: AGPL-3.0-or-later
// The shown pair's rows (DuplicatesScreen rowsOf, CTL-OFC-14-06 in UI-SPECIFICATION v0.13; owner ruling d9901466 "Match the design
// fully"): the 10 rows in their order with each row's content, and no Email row (F-870).
import { formatterFor } from '@bw/i18n/src/format.ts';
import { describe, expect, it } from 'vitest';
import type { ClientT } from '../shell/intl.tsx';
import { rowsOf } from './DuplicatesScreen.tsx';
import type { PairRecord } from './model.ts';

const tOf = (lang: 'en' | 'es'): ClientT => Object.assign(formatterFor(lang), { lang, rich: () => null }) as unknown as ClientT;

const A: PairRecord = {
  customerId: 'a', oldCustomerNumber: 'C100001', name: "Kathleen O'Brien", street: '2240 Riverside Dr', city: 'Upper Arlington', state: 'OH', zip: '43221',
  phones: [{ number: '+16145550163', kind: 'mobile' }, { number: '+16145550199', kind: 'home' }], textLanguage: 'en', customerSince: '2015-03-02',
  branchId: 'columbus', plan: 'comfort_club', notes: 'Side gate code 4471. Small dog in the yard.',
  equipment: [{ type: 'furnace', year: 2016, details: null }, { type: 'air_conditioner', year: 2016, details: 'serial 4TTR-88213' }],
  visits: { count: 9, first: '2020-03-11', last: '2026-04-02', lastVisit: { date: '2026-04-02', service: '', serviceId: 'furnace_tune_up' } },
};
const B: PairRecord = {
  ...A, customerId: 'b', oldCustomerNumber: 'C100002', name: 'Kathy OBrien', phones: [], plan: 'none', notes: null, equipment: [],
  visits: { count: 2, first: '2021-07-20', last: '2023-05-09', lastVisit: { date: '2023-05-09', service: 'Water heater install', serviceId: null } },
};

describe('the shown pair rows (CTL-OFC-14-06)', () => {
  // why: F-621, F-870 the 10 rows of v0.13 in its order, each with the content its row gives, and no other row (no Email)
  it('draws the 10 rows in order with their 2-line cells, the Plan and Notes rows, and no Email row', () => {
    const rows = rowsOf(A, B, tOf('en'));
    expect(rows.map((r) => r.label)).toEqual(['Name', 'Address', 'Phone', 'Text language', 'Customer since', 'Equipment', 'Visits', 'Branch', 'Plan', 'Notes']);
    const [, addr, phone, , since, equip, visits, , plan, notes] = rows;
    expect(addr!.a).toEqual({ main: '2240 Riverside Dr', sub: ['Upper Arlington, OH 43221'] });
    expect(phone!.a).toEqual({ main: '(614) 555-0163 - mobile', sub: ['(614) 555-0199 - home'] });
    expect(phone!.b).toEqual({ main: 'None' });
    expect(since!.a.main).toBe('Mar 2015');
    expect(equip!.a).toEqual({ main: 'Gas furnace, 2016', sub: ['Central air conditioner, 2016, serial 4TTR-88213'] });
    expect(equip!.b).toEqual({ main: 'None' });
    expect(visits!.a).toEqual({ main: '9 visits, Mar 2020 - Apr 2026', sub: ['Last: Furnace tune-up, Apr 2, 2026'] });
    expect(visits!.b).toEqual({ main: '2 visits, Jul 2021 and May 2023', sub: ['Last: Water heater install, May 9, 2023'] });
    expect([plan!.a.main, plan!.b.main, plan!.same]).toEqual(['Comfort Club member', 'None', false]);
    expect([notes!.a.main, notes!.b.main]).toEqual(['Side gate code 4471. Small dog in the yard.', 'None']);
    expect(rows.filter((r) => r.same).map((r) => r.label)).toEqual(['Address', 'Text language', 'Customer since', 'Branch']);
  });

  // why: F-621 a record with 1 visit, or all its visits in 1 month, names that month once; one with none shows the count alone
  it('names a single month once and shows a record with no visits as its count alone', () => {
    const one = rowsOf({ ...A, visits: { count: 1, first: '2023-05-09', last: '2023-05-09', lastVisit: { date: '2023-05-09', service: 'Repair', serviceId: null } } },
      { ...B, visits: { count: 0, first: null, last: null, lastVisit: null } }, tOf('en'))[6]!;
    expect(one.a).toEqual({ main: '1 visit, May 2023', sub: ['Last: Repair, May 9, 2023'] });
    expect(one.b).toEqual({ main: '0 visits' });
  });

  // why: FR-LANG-2 the new rows and lines read in Spanish on a Spanish page
  it('words the rows in Spanish for a Spanish reader', () => {
    const rows = rowsOf(A, B, tOf('es'));
    expect(rows.map((r) => r.label)).toContain('Membresía');
    expect(rows[6]!.b.sub?.[0]).toMatch(/^Última: Water heater install, /);
    expect(rows[8]!.a.main).toBe('Miembro del Comfort Club');
  });
});
