// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract rows of the auth area. A new row is added here with defineContract (from ../contract.ts) and its examples;
// its handler and policy entry are in packages/api-server.
// API-07 who am I and API-08 save my settings are the calls of the office top bar (CMP-07) and the language switch (CMP-03).
// The rest of the area (sign-in, sessions, users) follows them in this file.
import { z } from 'zod';
import { defineContract, type ContractRow } from '../contract.ts';
import { ROLES } from '../envelope.ts';

const language = z.enum(['en', 'es']);
const onOff = z.enum(['on', 'off']);

export const whoAmI = defineContract({
  id: 'API-07',
  name: 'Who am I',
  method: 'GET',
  path: '/me',
  request: z.object({}),
  response: z.object({
    userId: z.string(),
    // user.name (SPECIFICATIONS section 3, v0.6): every user has one, so the top bar always shows a name (F-223).
    name: z.string(),
    role: z.enum(ROLES),
    skill: z.string().nullable(),
    branch: z.string(),
    employeeNumber: z.string().nullable(),
    language,
    slashShortcut: onOff,
    /** The screen keys of UI-SPECIFICATION 2.4 this role may open, from the policy table (SPECIFICATIONS FR-DISP-10). */
    permissions: z.array(z.string()),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', expectStatus: 401 }],
});

export const saveMySettings = defineContract({
  id: 'API-08',
  name: 'Save my settings',
  method: 'PATCH',
  path: '/me',
  request: z
    .object({ language: language.optional(), slashShortcut: onOff.optional() })
    .refine((v) => v.language !== undefined || v.slashShortcut !== undefined, { message: 'language or slashShortcut' }),
  response: z.object({ language, slashShortcut: onOff }),
  errors: [],
  labels: [],
  // Signed out, the choice stays in the browser (SPECIFICATIONS FR-LANG-1): the call answers it back and stores nothing.
  examples: [{ name: 'signed out: answered back, nothing stored', input: { language: 'es' }, expectStatus: 200 }],
});

// The access code (API-01), app info (API-02), sign-in (API-03), the sample people and signing in as one (API-04, API-05), sign-out (API-06) and sample technician sign-ins (API-15) (UI-SPECIFICATION 12.2; SPECIFICATIONS 6.8, SD-8, SD-9, SD-47).
const nothing = z.object({});
const signedInUser = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
  branch: z.string(),
  language,
  employeeNumber: z.string().nullable(),
});
/** API-03 and API-05 answer the user; a native sign-in (API-03 with client native) also answers its bearer token, once. */
const signedIn = z.object({ user: signedInUser, token: z.string().nullable() });

export const enterAccessCode = defineContract({
  id: 'API-01',
  name: 'Enter access code',
  method: 'POST',
  path: '/access-code',
  request: z.object({ code: z.string().min(1).max(200) }),
  response: nothing,
  successStatus: [204],
  errors: ['code_invalid'],
  labels: [],
  examples: [{ name: 'a wrong code', input: { code: 'not-the-code' }, expectStatus: 403 }],
});

export const appInfo = defineContract({
  id: 'API-02',
  name: 'App info',
  method: 'GET',
  path: '/app-info',
  request: z.object({}),
  response: z.object({ demoMode: z.boolean(), accessCodeOn: z.boolean(), sourceUrl: z.string(), sourceCommit: z.string() }),
  errors: [],
  labels: [],
  examples: [{ name: 'answers with no session and no code', expectStatus: 200 }],
});

export const signIn = defineContract({
  id: 'API-03',
  name: 'Sign in',
  method: 'POST',
  path: '/sessions',
  request: z.object({
    login: z.string().min(1).max(254),
    password: z.string().min(1).max(200),
    client: z.enum(['web', 'native']).default('web'),
    keepSignedIn: z.boolean().default(false),
  }),
  response: signedIn,
  errors: ['credentials_invalid', 'account_turned_off'],
  labels: [],
  examples: [{ name: 'an unknown login', input: { login: 'nobody@example.test', password: 'wrong-example', client: 'web' }, expectStatus: 401 }],
});

const samplePerson = z.object({ personId: z.string(), name: z.string(), job: z.string(), role: z.enum(ROLES), branch: z.string(), language });

export const samplePeople = defineContract({
  id: 'API-04',
  name: 'Sample people',
  method: 'GET',
  path: '/demo/people',
  request: z.object({ app: z.enum(['office', 'tech']) }),
  response: z.object({ people: z.array(samplePerson) }),
  errors: ['demo_mode_off'],
  labels: [],
  examples: [{ name: 'demo mode off', input: { app: 'office' }, expectStatus: 403 }],
});

export const signInAs = defineContract({
  id: 'API-05',
  name: 'Sign in as',
  method: 'POST',
  path: '/demo/sessions',
  request: z.object({ personId: z.string().min(1).max(64), keepSignedIn: z.boolean().default(false) }),
  response: signedIn,
  errors: ['demo_mode_off'],
  labels: [],
  examples: [{ name: 'demo mode off', input: { personId: '0192f000-0000-7000-8000-000000000000' }, expectStatus: 403 }],
});

export const signOut = defineContract({
  id: 'API-06',
  name: 'Sign out',
  method: 'DELETE',
  path: '/sessions/current',
  request: z.object({}),
  response: nothing,
  successStatus: [204],
  errors: [],
  labels: [],
  // F-230: every answer, a refusal included, also clears the session cookie (the browser cannot clear an httpOnly cookie).
  examples: [{ name: 'no session: refused, and the answer still clears the cookie', expectStatus: 401 }],
});

export const techSignIns = defineContract({
  id: 'API-15',
  name: 'Sample technician sign-ins',
  method: 'GET',
  path: '/demo/tech-sign-ins',
  request: z.object({}),
  response: z.object({
    signIns: z.array(z.object({ name: z.string(), branch: z.string(), language, email: z.string(), password: z.string() })),
    iosAppLink: z.string().nullable(),
  }),
  errors: ['demo_mode_off'],
  labels: [],
  examples: [{ name: 'demo mode off', expectStatus: 403 }],
});

// P4-ACCOUNTS: the users page (API-149 to API-154, API-170), Forgot password (API-165) and the email pages (API-166 to API-168)
// (UI-SPECIFICATION 12.2; SPECIFICATIONS 6.8 FR-AUTH-8, FR-AUTH-9, FR-AUTH-12, SD-29).
/** An RFC 9557 time with its offset and IANA zone (UI-SPECIFICATION 12.1 item 5). */
const wireTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\[[^\]]+\]$/);
export const USER_STATUSES = ['active', 'invited', 'turned_off'] as const;
const userStatus = z.enum(USER_STATUSES);
const branchId = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
const uuidParam = z.uuid();
/** A one-time email link or a password link token: 32 random bytes, base64url (SD-29). */
const linkToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const emailAddress = z.email().max(254);

const userRow = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  branch: z.string(),
  title: z.string().nullable(),
  /** A technician's van number and primary skill (CTL-OFC-43-14); null for other roles or a technician with no technician row. */
  van: z.string().nullable(),
  primarySkill: z.string().nullable(),
  lastSignInAt: wireTime.nullable(),
  lastSignInApp: z.enum(['office', 'tech_web', 'tech_native']).nullable(),
  status: userStatus,
  /** The at of the latest invited (while Invited) or turned_off (while Turned off) change; null while Active (FR-AUTH-12). */
  statusSince: wireTime.nullable(),
});
/** What API-150, API-151, API-152 and API-170 answer: the changed user as the list shows them. */
const changedUser = z.object({ user: userRow });

export const searchUsers = defineContract({
  id: 'API-149',
  name: 'Users',
  method: 'POST',
  path: '/user-searches',
  request: z.object({
    query: z.string().max(100).default(''),
    role: z.enum(['all', ...ROLES]).default('all'),
    branch: z.union([z.literal('all'), branchId]).default('all'),
    status: z.enum(['all', ...USER_STATUSES]).default('all'),
    page: z.number().int().min(1).default(1),
  }),
  response: z.object({
    users: z.array(userRow),
    pages: z.number().int().min(0),
    /** The matching users over every page. */
    total: z.number().int().min(0),
    /** Over every user, whatever the filters: the Active people by role, and the people by status (CTL-OFC-43-10). */
    counts: z.object({
      active: z.object({ manager: z.number().int(), office: z.number().int(), technician: z.number().int() }),
      byStatus: z.object({ active: z.number().int(), invited: z.number().int(), turned_off: z.number().int() }),
    }),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: {}, expectStatus: 401 }],
});

export const inviteUser = defineContract({
  id: 'API-150',
  name: 'Invite a user',
  method: 'POST',
  path: '/users/invitations',
  request: z.object({ name: z.string().trim().min(1).max(120), email: emailAddress, role: z.enum(ROLES), branch: branchId }),
  response: z.object({
    user: userRow,
    /** The invite's employee number for a technician (SD-29, OI-26); null for other roles. */
    employeeNumber: z.string().nullable(),
    /** The one-time link that opens the invite email, shown to the inviting manager once (FR-AUTH-8). */
    emailLink: z.string(),
  }),
  successStatus: [201],
  errors: ['already_a_user'],
  labels: [],
  examples: [{ name: 'signed out', input: { name: 'Nadia Price', email: 'nadia.price@example.test', role: 'office', branch: 'columbus' }, expectStatus: 401 }],
});

export const setUserRole = defineContract({
  id: 'API-151',
  name: "Set a user's role",
  method: 'PUT',
  path: '/users/{userId}/role',
  request: z.object({ userId: uuidParam, role: z.enum(ROLES) }),
  response: changedUser,
  errors: ['rule_refused'],
  labels: [],
  examples: [{ name: 'signed out', input: { userId: '0192f000-0000-7000-8000-000000000000', role: 'office' }, expectStatus: 401 }],
});

export const turnUserOff = defineContract({
  id: 'API-152',
  name: 'Turn a user off',
  method: 'POST',
  path: '/users/{userId}/turn-off',
  request: z.object({ userId: uuidParam }),
  response: changedUser,
  errors: ['rule_refused'],
  labels: [],
  examples: [{ name: 'signed out', input: { userId: '0192f000-0000-7000-8000-000000000000' }, expectStatus: 401 }],
});

/** The areas of the role table (CTL-OFC-43-11), in the approved page's order. */
export const ROLE_AREAS = ['board', 'jobs_customers', 'technicians', 'messages', 'reports', 'admin', 'phone_app', 'customer_phones'] as const;

export const roleAccess = defineContract({
  id: 'API-153',
  name: 'Role access',
  method: 'GET',
  path: '/roles',
  request: z.object({}),
  response: z.object({
    areas: z.array(z.object({ area: z.enum(ROLE_AREAS), office: z.boolean(), technician: z.boolean(), manager: z.boolean() })),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', expectStatus: 401 }],
});

export const userChanges = defineContract({
  id: 'API-154',
  name: 'Recent user changes',
  method: 'GET',
  path: '/users/changes',
  request: z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(10) }),
  response: z.object({
    changes: z.array(z.object({
      userName: z.string(),
      what: z.enum(['invited', 'role_set', 'turned_off', 'turned_back_on']),
      /** The user's role and branch, for "invited as Technician, Dayton" and "now a Manager". */
      role: z.enum(ROLES),
      branch: z.string(),
      /** Who made the change; null for setup (SPECIFICATIONS section 3 user_change.by). */
      byName: z.string().nullable(),
      at: wireTime,
    })),
    next: z.string().nullable(),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', expectStatus: 401 }],
});

export const RESET_REFUSALS = ['no_account', 'protection_on', 'account_turned_off'] as const;

export const requestReset = defineContract({
  id: 'API-165',
  name: 'Request a password reset',
  method: 'POST',
  path: '/password-resets',
  request: z.object({ email: emailAddress, app: z.enum(['office', 'tech']) }),
  response: z.object({ sent: z.boolean(), reason: z.enum(RESET_REFUSALS).nullable(), emailLink: z.string().nullable() }),
  successStatus: [202],
  errors: [],
  labels: [],
  examples: [{ name: 'not an email address', input: { email: 'not-an-address', app: 'office' }, expectStatus: 422 }],
});

export const emailByLink = defineContract({
  id: 'API-166',
  name: 'Email by one-time link',
  method: 'GET',
  path: '/emails/{oneTimeToken}',
  request: z.object({ oneTimeToken: linkToken }),
  response: z.object({
    /** Whose on-screen inbox this is, the person the email was sent to (CTL-EML-01-01). */
    inboxFor: z.string(),
    from: z.string(),
    to: z.string(),
    subject: z.string(),
    sentAt: wireTime,
    /** Paragraphs separated by a blank line; a paragraph that is exactly {link} is where the email's button stands. */
    body: z.string(),
    /** The email's written language (the recipient's, FR-AUTH-8) and the recipient's first name, for the "as written" line. */
    language,
    recipientFirstName: z.string(),
    /** The email's button: an invite's or a reset's password link (SCR-EML-02), or an alert's System health (SCR-OFC-16). */
    links: z.array(z.object({ kind: z.enum(['invite', 'reset', 'system_health']), href: z.string() })),
  }),
  errors: ['gone'],
  labels: [],
  examples: [{ name: 'a link that does not exist', input: { oneTimeToken: 'A'.repeat(43) }, expectStatus: 404 }],
});

export const passwordLink = defineContract({
  id: 'API-167',
  name: 'Password link',
  method: 'GET',
  path: '/password-tokens/{passwordToken}',
  request: z.object({ passwordToken: linkToken }),
  response: z.object({
    kind: z.enum(['invite', 'reset']),
    user: z.object({ name: z.string(), role: z.enum(ROLES), branch: z.string() }),
    app: z.enum(['office', 'tech']),
  }),
  errors: ['gone', 'account_turned_off'],
  labels: [],
  examples: [{ name: 'a link that does not exist', input: { passwordToken: 'A'.repeat(43) }, expectStatus: 404 }],
});

/** SD-29: 10 to 128 characters, not the email, not 1 repeated character. */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export const setPassword = defineContract({
  id: 'API-168',
  name: 'Set a password',
  method: 'POST',
  path: '/password-tokens/{passwordToken}',
  // The rules that need the user (not the email, not 1 repeated character) are the handler's; the length is checked here.
  request: z.object({ passwordToken: linkToken, password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX) }),
  response: z.object({ app: z.enum(['office', 'tech']) }),
  errors: ['gone', 'account_turned_off'],
  labels: [],
  examples: [{ name: 'a link that does not exist', input: { passwordToken: 'A'.repeat(43), password: 'an-example-phrase' }, expectStatus: 404 }],
});

export const turnUserOn = defineContract({
  id: 'API-170',
  name: 'Turn a user back on',
  method: 'POST',
  path: '/users/{userId}/turn-on',
  request: z.object({ userId: uuidParam }),
  response: changedUser,
  errors: ['rule_refused'],
  labels: [],
  examples: [{ name: 'signed out', input: { userId: '0192f000-0000-7000-8000-000000000000' }, expectStatus: 401 }],
});

export const authContracts: ContractRow[] = [
  enterAccessCode, appInfo, signIn, samplePeople, signInAs, signOut, whoAmI, saveMySettings, techSignIns,
  searchUsers, inviteUser, setUserRole, turnUserOff, roleAccess, userChanges, requestReset, emailByLink, passwordLink, setPassword, turnUserOn,
];
