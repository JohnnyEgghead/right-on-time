// SPDX-License-Identifier: AGPL-3.0-or-later
// Policy of the auth area: the gate's start page, the sign-in pages, the email pages and the users page (UI-SPECIFICATION
// 2.4). The lane that builds an auth contract adds its api(row, access) entry here and its handler beside it.
import {
  appInfo, emailByLink, enterAccessCode, inviteUser, passwordLink, requestReset, roleAccess, samplePeople, saveMySettings, searchUsers, setPassword,
  setUserRole, signIn, signInAs, signOut, techSignIns, turnUserOff, turnUserOn, userChanges, whoAmI,
} from '@bw/api';
import type { PolicyEntry } from '../types.ts';
import { api, MANAGER, ONE_TIME, page, PUBLIC, roles, token } from './entry.ts';

export const authPolicy: PolicyEntry[] = [
  // P2-AUTH. API-01, API-02 and API-03 answer before the access code (SD-47 step 1); every other row here needs the code or a
  // password session. Sign out is for the signed-in roles (its callers CTL-CMP-07-08, CTL-TEC-10-04, CTL-SHR-01-03); the kernel clears the session cookie on every answer, a refusal included (F-230). The sample
  // lists and Sign in as are public by role: the handlers answer only with demo mode on (FR-AUTH-5), after the code.
  api(enterAccessCode, PUBLIC),
  api(appInfo, PUBLIC),
  api(signIn, PUBLIC),
  api(samplePeople, PUBLIC),
  api(signInAs, PUBLIC),
  api(signOut, roles('office', 'manager', 'technician')),
  // P2-SHELL: who am I for every signed-in role (its callers: CMP-07, CMP-08, SCR-TEC-10, the SCR-SHR pages); saving the
  // settings is public (CMP-03 is on every page; signed out, nothing is stored).
  api(whoAmI, roles('office', 'manager', 'technician')),
  api(saveMySettings, PUBLIC),
  api(techSignIns, PUBLIC),
  // P4-ACCOUNTS: the users page is for managers only (FR-AUTH-12, section 2.4); Forgot password is public behind the code
  // (UD-46); an email opens by its one-time link, a password page by its password link (SD-29).
  api(searchUsers, MANAGER),
  api(inviteUser, MANAGER),
  api(setUserRole, MANAGER),
  api(turnUserOff, MANAGER),
  api(roleAccess, MANAGER),
  api(userChanges, MANAGER),
  api(requestReset, PUBLIC),
  api(emailByLink, ONE_TIME),
  api(passwordLink, token('password')),
  api(setPassword, token('password')),
  api(turnUserOn, MANAGER),
  page('SCR-GATE-02', '/', PUBLIC),
  page('SCR-OFC-01', '/sign-in', PUBLIC, true),
  page('SCR-TEC-01', '/tech/sign-in', PUBLIC, true),
  page('SCR-TEC-11', '/tech/install', PUBLIC),
  page('SCR-EML-01', '/email/{oneTimeToken}', ONE_TIME),
  page('SCR-EML-02', '/set-password/{passwordToken}', token('password')),
  page('SCR-EML-03', '/forgot-password', PUBLIC),
  page('SCR-OFC-43', '/office/admin/users', MANAGER),
];
