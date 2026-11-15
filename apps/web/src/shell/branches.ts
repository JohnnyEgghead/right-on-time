// SPDX-License-Identifier: AGPL-3.0-or-later
// The 3 branches (CTL-CMP-07-04) and their office numbers (CTL-CMP-14-01, CMP-15, CMP-16). Reference data, not copy:
// branch names are proper names and stay as they are in both languages (UI-SPECIFICATION 13.1 item 3; the kit frames
// mark them translate="no"). The office numbers are the branch office numbers FR-IMP-7 / CTL-CMP-16-01 allow.
export interface Branch {
  id: 'columbus' | 'dayton' | 'springfield';
  name: string;
  zone: string;
  officePhone: string;
}

export const BRANCHES: readonly Branch[] = [
  { id: 'columbus', name: 'Columbus', zone: 'America/New_York', officePhone: '(614) 555-0100' },
  { id: 'dayton', name: 'Dayton', zone: 'America/New_York', officePhone: '(937) 555-0101' },
  { id: 'springfield', name: 'Springfield', zone: 'America/New_York', officePhone: '(937) 555-0102' },
];

export const BRANCH_STORAGE_KEY = 'bw.branch';

export function branchById(id: string | null | undefined): Branch {
  return BRANCHES.find((b) => b.id === id) ?? BRANCHES[0]!;
}
