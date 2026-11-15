// SPDX-License-Identifier: AGPL-3.0-or-later
// The fixed data of the account pages' preview states (harness build only): the people, roles and emails the approved frames
// show (mockups/pages/admin-users.html, r1-eml-email.html, r1-eml-setpw.html, r1-eml-forgot.html), so the look comparator
// reads the app in each state its frame shows. Reference data for previews, never a release answer.
import { MANAGER } from '../shell/preview-fixtures.ts';
import type { Me } from '../shell/OfficeTopBar.tsx';
import type { OpenedEmail, PasswordLinkInfo, RoleAreas, UserChange, UserItem, UserSearch } from './api.ts';

const Z = '[America/New_York]';
const at = (s: string) => `${s}-04:00${Z}`;
export const ME: Me = { ...MANAGER, userId: 'u-dana' };

const user = (o: Partial<UserItem> & Pick<UserItem, 'id' | 'name' | 'email' | 'role' | 'branch'>): UserItem => ({
  title: null, van: null, primarySkill: null, lastSignInAt: null, lastSignInApp: null, status: 'active', statusSince: null, ...o,
});

export const USERS: UserItem[] = [
  user({ id: 'u-dana', name: 'Dana Ruiz', email: 'druiz@brightwaterair.com', role: 'manager', branch: 'columbus', title: 'Director of Operations', lastSignInAt: at('2026-09-15T07:48:00'), lastSignInApp: 'office' }),
  user({ id: 'u-pat', name: 'Pat Kessler', email: 'pkessler@brightwaterair.com', role: 'manager', branch: 'dayton', title: 'Branch manager', lastSignInAt: at('2026-09-14T16:52:00'), lastSignInApp: 'office' }),
  user({ id: 'u-keisha', name: 'Keisha Thompson', email: 'kthompson@brightwaterair.com', role: 'office', branch: 'columbus', title: 'Dispatcher', lastSignInAt: at('2026-09-15T07:31:00'), lastSignInApp: 'office' }),
  user({ id: 'u-ana', name: 'Ana Gutierrez', email: 'agutierrez@brightwaterair.com', role: 'office', branch: 'columbus', title: 'Customer service (Spanish)', lastSignInAt: at('2026-09-15T08:05:00'), lastSignInApp: 'office' }),
  user({ id: 'u-omar', name: 'Omar Haddad', email: 'ohaddad@brightwaterair.com', role: 'office', branch: 'dayton', title: 'Customer service', lastSignInAt: at('2026-08-28T15:15:00'), lastSignInApp: 'office', status: 'turned_off', statusSince: at('2026-09-04T17:02:00') }),
  user({ id: 'u-maria', name: 'Maria Santos', email: 'msantos@brightwaterair.com', role: 'technician', branch: 'columbus', van: '12', primarySkill: 'heating_cooling', lastSignInAt: at('2026-09-15T07:12:00'), lastSignInApp: 'tech_native' }),
  user({ id: 'u-luis', name: 'Luis Ortega', email: 'lortega@brightwaterair.com', role: 'technician', branch: 'columbus', van: '18', primarySkill: 'heating_cooling', lastSignInAt: at('2026-09-15T07:09:00'), lastSignInApp: 'tech_native' }),
  user({ id: 'u-derek', name: 'Derek Simmons', email: 'dsimmons@brightwaterair.com', role: 'technician', branch: 'dayton', van: '41', primarySkill: 'heating_cooling', status: 'invited', statusSince: at('2026-09-14T14:10:00') }),
];

export const SEARCH: UserSearch = {
  users: USERS, pages: 3, total: 107,
  counts: { active: { manager: 6, office: 14, technician: 85 }, byStatus: { active: 105, invited: 1, turned_off: 1 } },
};
export const EMPTY: UserSearch = { ...SEARCH, users: [], pages: 0, total: 0 };

export const AREAS: RoleAreas = [
  { area: 'board', office: true, technician: false, manager: true },
  { area: 'jobs_customers', office: true, technician: false, manager: true },
  { area: 'technicians', office: true, technician: false, manager: true },
  { area: 'messages', office: true, technician: false, manager: true },
  { area: 'reports', office: false, technician: false, manager: true },
  { area: 'admin', office: false, technician: false, manager: true },
  { area: 'phone_app', office: false, technician: true, manager: false },
  { area: 'customer_phones', office: true, technician: true, manager: true },
];

export const CHANGES: UserChange[] = [
  { userName: 'Derek Simmons', what: 'invited', role: 'technician', branch: 'dayton', byName: 'Dana R.', at: at('2026-09-14T14:10:00') },
  { userName: 'Omar Haddad', what: 'turned_off', role: 'office', branch: 'dayton', byName: 'Pat Kessler', at: at('2026-09-04T17:02:00') },
];
export const CHANGED: UserChange[] = [{ userName: 'Omar Haddad', what: 'turned_back_on', role: 'office', branch: 'dayton', byName: 'Dana R.', at: at('2026-09-15T10:34:00') }];

export const OMAR = USERS[4]!;
export const TANYA = user({ id: 'u-tanya', name: 'Tanya Brooks', email: 'tbrooks@brightwaterair.com', role: 'office', branch: 'columbus', title: 'Dispatcher' });

export const RESET_EMAIL: OpenedEmail = {
  inboxFor: 'keisha.t@brightwater.example', from: 'Right On Time <no-reply@brightwater.example>', to: 'keisha.t@brightwater.example',
  subject: 'Choose a new password', sentAt: at('2026-09-15T10:26:00'), language: 'en', recipientFirstName: 'Keisha',
  body: [
    'Hi Keisha,',
    'Someone asked to reset the password for your Right On Time account. Choose a new password with the button below.',
    '{link}',
    'If you did not ask for this, you can ignore this email. Your password stays the same.',
    'Brightwater Heating & Air',
  ].join('\n\n'),
  links: [{ kind: 'reset', href: '/set-password/preview' }],
};

export const DEREK_LINK: PasswordLinkInfo = { kind: 'invite', user: { name: 'Derek Simmons', role: 'technician', branch: 'dayton' }, app: 'tech' };
