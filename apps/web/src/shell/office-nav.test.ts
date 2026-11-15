// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { serverT } from './i18n-server.ts';
import { ADMIN_ENTRIES, isCurrent, OFFICE_SECTIONS, visibleEntries } from './office-nav.ts';
import { MANAGER, OFFICE } from './preview-fixtures.ts';

const labels = (lang: 'en' | 'es', perms: readonly string[]) => visibleEntries(OFFICE_SECTIONS, perms).map((e) => serverT(lang)(e.label));

describe('CMP-07 office menu', () => {
  // why: FR-DISP-10 Board, Jobs, Customers, Technicians and Reports in that order (OI-22: more entries allowed)
  it('keeps the 5 booklet items in their order, with Messages, Billing and Admin where the UI specification places them', () => {
    const all = labels('en', MANAGER.permissions);
    expect(all).toEqual(['Board', 'Jobs', 'Customers', 'Technicians', 'Messages', 'Billing', 'Reports', 'Admin']);
    const booklet = ['Board', 'Jobs', 'Customers', 'Technicians', 'Reports'];
    expect(all.filter((l) => booklet.includes(l))).toEqual(booklet);
    expect(labels('es', MANAGER.permissions)).toEqual(['Tablero', 'Trabajos', 'Clientes', 'Técnicos', 'Mensajes', 'Facturación', 'Informes', 'Administración']);
  });

  // why: FR-DISP-10 each item opens its page for a role FR-AUTH-1 allows (section 2.4: Reports is managers only)
  it('shows only the sections the role may open, and Admin opens the first admin page it may open', () => {
    expect(labels('en', OFFICE.permissions)).not.toContain('Reports');
    expect(visibleEntries(OFFICE_SECTIONS, ['SCR-OFC-17']).map((e) => [e.id, e.href])).toEqual([['admin', '/office/admin/clock']]);
    expect(visibleEntries(OFFICE_SECTIONS, [])).toEqual([]);
  });

  // why: FR-DISP-10 the menu marks the open section (aria-current)
  it('marks the current section by its path prefix', () => {
    const jobs = OFFICE_SECTIONS.find((e) => e.id === 'jobs')!;
    expect(isCurrent(jobs, '/office/jobs/24825')).toBe(true);
    expect(isCurrent(jobs, '/office/jobsearch')).toBe(false);
  });
});

describe('CMP-08 admin side menu', () => {
  // why: FR-DISP-10 the admin entries follow the role (CTL-CMP-08-01, section 2.4)
  it('shows Users and roles, System health and Demo clock to managers only', () => {
    expect(visibleEntries(ADMIN_ENTRIES, MANAGER.permissions).map((e) => e.id)).toEqual(['windows', 'users', 'import', 'health', 'clock']);
    expect(visibleEntries(ADMIN_ENTRIES, OFFICE.permissions).map((e) => e.id)).toEqual(['windows', 'import']);
  });
});
