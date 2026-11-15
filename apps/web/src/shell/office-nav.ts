// SPDX-License-Identifier: AGPL-3.0-or-later
// CMP-07 menu (CTL-CMP-07-02) and CMP-08 admin side menu (CTL-CMP-08-01).
// FR-DISP-10: Board, Jobs, Customers, Technicians and Reports, in that order. OI-22: those 5 keep their relative order and
// the UI specification places Messages, Billing and Admin among them: Board, Jobs, Customers, Technicians, Messages,
// Billing, Reports, Admin. Each entry shows only when API-07's permissions hold its screen (section 2.4).
import type { MessageKey } from '@bw/i18n';

export interface NavEntry {
  id: string;
  label: MessageKey;
  href: string;
  /** The screens this entry opens; the entry shows when the user may open any of them. */
  screens: readonly string[];
  /** Path prefixes that mark this entry current (aria-current). */
  match: readonly string[];
}

export const ADMIN_ENTRIES: readonly NavEntry[] = [
  { id: 'windows', label: 'shell.admin.windows', href: '/office/admin/windows', screens: ['SCR-OFC-12'], match: ['/office/admin/windows'] },
  { id: 'users', label: 'shell.admin.users', href: '/office/admin/users', screens: ['SCR-OFC-43'], match: ['/office/admin/users'] },
  { id: 'import', label: 'shell.admin.import', href: '/office/admin/import', screens: ['SCR-OFC-13', 'SCR-OFC-14', 'SCR-OFC-15'], match: ['/office/admin/import'] },
  { id: 'health', label: 'shell.admin.health', href: '/office/admin/health', screens: ['SCR-OFC-16'], match: ['/office/admin/health'] },
  { id: 'clock', label: 'shell.admin.clock', href: '/office/admin/clock', screens: ['SCR-OFC-17'], match: ['/office/admin/clock'] },
];

export const OFFICE_SECTIONS: readonly NavEntry[] = [
  { id: 'board', label: 'shell.office.nav.board', href: '/office/board', screens: ['SCR-OFC-02', 'SCR-OFC-34'], match: ['/office/board'] },
  { id: 'jobs', label: 'shell.office.nav.jobs', href: '/office/jobs', screens: ['SCR-OFC-30', 'SCR-OFC-03', 'SCR-OFC-04'], match: ['/office/jobs'] },
  { id: 'customers', label: 'shell.office.nav.customers', href: '/office/customers', screens: ['SCR-OFC-05', 'SCR-OFC-06'], match: ['/office/customers'] },
  { id: 'technicians', label: 'shell.office.nav.technicians', href: '/office/technicians', screens: ['SCR-OFC-07'], match: ['/office/technicians'] },
  { id: 'messages', label: 'shell.office.nav.messages', href: '/office/messages', screens: ['SCR-OFC-08', 'SCR-OFC-09'], match: ['/office/messages'] },
  { id: 'billing', label: 'shell.office.nav.billing', href: '/office/billing', screens: ['SCR-OFC-10'], match: ['/office/billing'] },
  { id: 'reports', label: 'shell.office.nav.reports', href: '/office/reports', screens: ['SCR-OFC-11'], match: ['/office/reports'] },
  { id: 'admin', label: 'shell.office.nav.admin', href: '/office/admin/windows', screens: ADMIN_ENTRIES.flatMap((e) => e.screens), match: ['/office/admin'] },
];

/** The entries a user with these permissions sees, in spec order. Admin opens the first admin page the user may open. */
export function visibleEntries(entries: readonly NavEntry[], permissions: readonly string[]): NavEntry[] {
  const may = new Set(permissions);
  const out: NavEntry[] = [];
  for (const e of entries) {
    if (!e.screens.some((s) => may.has(s))) continue;
    if (e.id === 'admin') {
      const first = ADMIN_ENTRIES.find((a) => a.screens.some((s) => may.has(s)));
      out.push(first ? { ...e, href: first.href } : e);
    } else out.push(e);
  }
  return out;
}

export function isCurrent(entry: NavEntry, pathname: string): boolean {
  return entry.match.some((m) => pathname === m || pathname.startsWith(`${m}/`));
}
