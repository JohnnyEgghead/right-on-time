// SPDX-License-Identifier: AGPL-3.0-or-later
// The users page, Forgot password and the email pages (P4-ACCOUNTS; UI-SPECIFICATION 12.2; SPECIFICATIONS 6.8 FR-AUTH-8,
// FR-AUTH-9, FR-AUTH-12, SD-29), over the on-screen email store of @bw/db (email-store.ts):
//   API-149 users          API-150 invite             API-151 set role        API-152 turn off      API-170 turn back on
//   API-153 role access    API-154 recent changes     API-165 forgot password
//   API-166 email by one-time link                    API-167 password link   API-168 set a password
//
// Tokens (SD-29). Every link is 32 random bytes; only its SHA-256 is ever stored. The plain value of an email link is in the
// answer of the call that sent the email (shown once to the person whose action sent it). The plain value of a password
// link is never stored either: the invite or reset writes a password_token whose plain value is dropped at once, and the
// email's opening (API-166, itself one-time) re-mints that token (a new random value, the same row, kind and expiry, the
// F-431 pattern), so the only place the link exists is the 1 answer that shows the opened email. An email finds its token
// by user, kind and expiry: the token expires exactly its lifetime after the email's sent_at.
//
// Each durable write and its re-run semantics:
//   - API-150: 1 user, 1 user_change invited, 1 password_token, 1 email_message and 1 email_link, in the call's transaction; a
//     retry after an unknown outcome answers already_a_user (the address is taken).
//   - API-151 / API-152 / API-170: 1 UPDATE of the user and 1 user_change; API-152 also deletes the user's sessions. A retry
//     answers rule_refused (the role or status is already the asked one).
//   - API-165: 1 password_token, 1 email_message and 1 email_link; a retry sends a second, independent email.
//   - API-166: spends the email link (1 conditional UPDATE) and re-mints the password token; a retry answers gone.
//   - API-168: the hash, the status (Invited becomes Active, OI-43), every unused password token of the user spent, the
//     user's sessions ended and 1 user_change password_set; a retry answers gone.
// No call logs a token, a link or a password.
import { createHash } from 'node:crypto';
import type {
  emailByLink, inviteUser, passwordLink, requestReset, roleAccess, searchUsers, setPassword, setUserRole, turnUserOff, turnUserOn, userChanges,
} from '@bw/api';
import { decodeCursor, encodeCursor, PAGE_SIZE, ROLE_AREAS } from '@bw/api';
import { foldStreetName, hashPassword, newToken, openEmailLink, sendEmail } from '@bw/db';
import { Temporal, toWire } from '@bw/time';
import type { z } from 'zod';
import { DEFAULT_ZONE } from '../kernel/mount.ts';
import type { ApiResult, Handler, Role, TokenCheck, Tx } from '../types.ts';
import { EMAIL_FROM, firstName, inviteEmail, resetEmail, type EmailLanguage } from './account-email.ts';
import { permissionsOf } from './me.ts';

type Out<R extends { response: z.ZodType }> = z.output<R['response']>;
type In<R extends { request: z.ZodType }> = z.output<R['request']>;

/** SD-29 lifetimes, in demo time: an invite link 7 days, a reset link 60 minutes. Hours, so a DST change never moves them. */
export const INVITE_HOURS = 7 * 24;
export const RESET_HOURS = 1;
/** SD-29: the seed starts the employee numbers at 40701; a new one is 1 above the highest in the world. */
export const FIRST_EMPLOYEE_NUMBER = 40701;

const sha256 = (token: string): Buffer => createHash('sha256').update(token).digest();
const wire = (d: Date): string => toWire(Temporal.Instant.fromEpochMilliseconds(d.getTime()), DEFAULT_ZONE);
const refuse = <T>(status: number, code: 'not_found' | 'rule_refused' | 'validation_failed' | 'already_a_user' | 'gone' | 'account_turned_off'): ApiResult<T> =>
  ({ ok: false, status, code });
const appOf = (role: string): 'office' | 'tech' => (role === 'technician' ? 'tech' : 'office');
const staffId = (req: { caller: { kind: string; userId?: string } }): string | null => (req.caller.kind === 'staff' ? (req.caller.userId ?? null) : null);

// ---------- the user row the list and every change answer ----------

interface UserRowDb {
  id: string; name: string; email: string; role: Role; branch_id: string; title: string | null; van: string | null; primary_skill: string | null;
  last_sign_in_at: Date | null; last_sign_in_app: 'office' | 'tech_web' | 'tech_native' | null; status: 'active' | 'invited' | 'turned_off'; status_since: Date | null;
}

const USER_SELECT = `
  SELECT u.id, u.name, u.email::text AS email, u.role, u.branch_id, u.title, v.number AS van, t.primary_skill,
         u.last_sign_in_at, u.last_sign_in_app, u.status,
         CASE WHEN u.status IN ('invited', 'turned_off')
              THEN (SELECT max(c.at) FROM world.user_change c WHERE c.user_id = u.id AND c.what = u.status) END AS status_since
    FROM world."user" u
    LEFT JOIN world.technician t ON t.user_id = u.id
    LEFT JOIN world.van v ON v.id = t.van_id`;

const ROLE_ORDER = `CASE u.role WHEN 'manager' THEN 0 WHEN 'office' THEN 1 ELSE 2 END`;

function toUser(r: UserRowDb): Out<typeof searchUsers>['users'][number] {
  return {
    id: r.id, name: r.name, email: r.email, role: r.role, branch: r.branch_id, title: r.title,
    van: r.van, primarySkill: r.primary_skill,
    lastSignInAt: r.last_sign_in_at ? wire(r.last_sign_in_at) : null, lastSignInApp: r.last_sign_in_app,
    status: r.status, statusSince: r.status_since ? wire(r.status_since) : null,
  };
}

async function readUser(tx: Tx, id: string) {
  const r = (await tx.query<UserRowDb>(`${USER_SELECT} WHERE u.id = $1`, [id])).rows[0];
  return r ? toUser(r) : null;
}

async function logChange(tx: Tx, userId: string, what: 'invited' | 'role_set' | 'turned_off' | 'turned_back_on' | 'password_set', by: string | null, now: string) {
  await tx.query(`INSERT INTO world.user_change (user_id, what, "by", at) VALUES ($1, $2, $3, $4)`, [userId, what, by, now]);
}

// ---------- API-149 users ----------

export const searchUsersHandler: Handler<Out<typeof searchUsers>> = async (req, tx) => {
  const p = req.params as In<typeof searchUsers>;
  const where: string[] = [];
  const args: unknown[] = [];
  const q = p.query.trim();
  if (q) {
    // FR-DISP-7 (Apostrophe search): the typed text is a parameter, folded as the stored key is, matched by substring.
    args.push(foldStreetName(q), q.toLowerCase());
    where.push(`(strpos(u.name_search, $${args.length - 1}) > 0 OR strpos(lower(u.email::text), $${args.length}) > 0)`);
  }
  if (p.role !== 'all') { args.push(p.role); where.push(`u.role = $${args.length}`); }
  if (p.branch !== 'all') { args.push(p.branch); where.push(`u.branch_id = $${args.length}`); }
  if (p.status !== 'all') { args.push(p.status); where.push(`u.status = $${args.length}`); }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM world."user" u ${filter}`, args)).rows[0]?.n ?? 0);
  const pages = Math.ceil(total / PAGE_SIZE);
  const rows = (
    await tx.query<UserRowDb>(`${USER_SELECT} ${filter} ORDER BY ${ROLE_ORDER}, u.name_search, u.id LIMIT ${PAGE_SIZE} OFFSET ${(p.page - 1) * PAGE_SIZE}`, args)
  ).rows;
  const c = (await tx.query<{ role: Role; status: string; n: string }>(`SELECT role, status, count(*) AS n FROM world."user" GROUP BY role, status`)).rows;
  const sum = (f: (r: (typeof c)[number]) => boolean) => c.filter(f).reduce((a, r) => a + Number(r.n), 0);
  const counts = {
    active: {
      manager: sum((r) => r.status === 'active' && r.role === 'manager'),
      office: sum((r) => r.status === 'active' && r.role === 'office'),
      technician: sum((r) => r.status === 'active' && r.role === 'technician'),
    },
    byStatus: { active: sum((r) => r.status === 'active'), invited: sum((r) => r.status === 'invited'), turned_off: sum((r) => r.status === 'turned_off') },
  };
  return { ok: true, status: 200, data: { users: rows.map(toUser), pages, total, counts } };
};

// ---------- API-150 invite ----------

/** SD-29: 1 above the highest employee number in the world, under a transaction lock so 2 invites never take the same one. */
export async function nextEmployeeNumber(tx: Tx): Promise<string> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('bw.employee_number'))`);
  const r = await tx.query<{ n: number | null }>(`SELECT max(employee_number::int) AS n FROM world."user" WHERE employee_number ~ '^[0-9]{5}$'`);
  const top = r.rows[0]?.n;
  return String(top === null || top === undefined ? FIRST_EMPLOYEE_NUMBER : top + 1);
}

/** A password token whose plain value is dropped at once; API-166 re-mints it when the email opens (see the file head). */
async function writePasswordToken(tx: Tx, userId: string, kind: 'invite' | 'reset', now: string): Promise<void> {
  // F-612: the newer email supersedes an earlier unused token of the same kind with the same expiry (2 sends at one demo instant, the clock
  // paused), so API-166's email-to-token match stays one to one.
  await tx.query(
    `UPDATE world.password_token SET used_at = $3::timestamptz
      WHERE user_id = $1 AND kind = $2 AND used_at IS NULL AND expires_at = $3::timestamptz + make_interval(hours => $4)`,
    [userId, kind, now, kind === 'invite' ? INVITE_HOURS : RESET_HOURS],
  );
  await tx.query(
    `INSERT INTO world.password_token (token_hash, user_id, kind, expires_at) VALUES ($1, $2, $3, $4::timestamptz + make_interval(hours => $5))`,
    [sha256(newToken()), userId, kind, now, kind === 'invite' ? INVITE_HOURS : RESET_HOURS],
  );
}

/**
 * The invite itself, shared by API-150 and API-147 (addTechnician, SD-29): the Invited user, its change row, its password token and its
 * email, with the one-time link shown to the person who invited. `already_a_user` is answered as `null`.
 */
export async function inviteNewUser(tx: Tx, o: {
  by: string; now: string; name: string; email: string; role: Role; branch: string;
}): Promise<{ id: string; employeeNumber: string | null; emailLink: string } | null> {
  // F-765: 2 invites of 1 address in flight take turns, so the second finds the first's row and answers already_a_user, never a unique violation (500).
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('bw.invite_email.' || lower($1::text)))`, [o.email]);
  if ((await tx.query(`SELECT 1 FROM world."user" WHERE email = $1`, [o.email])).rows[0]) return null;
  const inviter = (await tx.query<{ language: EmailLanguage }>(`SELECT language FROM world."user" WHERE id = $1`, [o.by])).rows[0];
  // OI-39: the invited user's language starts as the inviting person's, so the invite email is written in it.
  const language: EmailLanguage = inviter?.language === 'es' ? 'es' : 'en';
  const employeeNumber = o.role === 'technician' ? await nextEmployeeNumber(tx) : null;
  const id = (
    await tx.query<{ id: string }>(
      `INSERT INTO world."user" (email, name, name_search, password_hash, role, branch_id, language, status, employee_number, title, sample, reviewer)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, 'invited', $7, NULL, false, false) RETURNING id`,
      [o.email, o.name, foldStreetName(o.name), o.role, o.branch, language, employeeNumber],
    )
  ).rows[0]!.id;
  await logChange(tx, id, 'invited', o.by, o.now);
  await writePasswordToken(tx, id, 'invite', o.now);
  const words = inviteEmail(language, { name: o.name, role: o.role, branch: o.branch, employeeNumber });
  const sent = await sendEmail(tx, { userId: id, toAddress: o.email, kind: 'invite', language, subject: words.subject, body: words.body, now: o.now, shownTo: [o.by] });
  return { id, employeeNumber, emailLink: `/email/${sent.links[0]!.token}` };
}

export const inviteUserHandler: Handler<Out<typeof inviteUser>> = async (req, tx) => {
  const by = staffId(req);
  if (!by) return { ok: false, status: 401, code: 'unauthenticated' };
  const p = req.params as In<typeof inviteUser>;
  const now = req.demoNow.toString();
  if (!(await tx.query(`SELECT 1 FROM world.branch WHERE id = $1`, [p.branch])).rows[0]) return refuse(422, 'validation_failed');
  const made = await inviteNewUser(tx, { by, now, name: p.name, email: p.email, role: p.role, branch: p.branch });
  if (!made) return refuse(409, 'already_a_user');
  const user = (await readUser(tx, made.id))!;
  return { ok: true, status: 201, data: { user, employeeNumber: made.employeeNumber, emailLink: made.emailLink } };
};

// ---------- API-151, API-152, API-170 ----------

async function target(tx: Tx, id: string) {
  return (await tx.query<{ id: string; role: Role; status: string; status_before_off: string | null }>(
    `SELECT id, role, status, status_before_off FROM world."user" WHERE id = $1 FOR UPDATE`, [id],
  )).rows[0];
}

export const setUserRoleHandler: Handler<Out<typeof setUserRole>> = async (req, tx) => {
  const by = staffId(req);
  const p = req.params as In<typeof setUserRole>;
  const u = await target(tx, p.userId);
  if (!u) return refuse(404, 'not_found');
  // CTL-OFC-43-07: never the signed-in manager's own row; the same role is no change.
  if (u.id === by || u.role === p.role) return refuse(409, 'rule_refused');
  await tx.query(`UPDATE world."user" SET role = $2 WHERE id = $1`, [u.id, p.role]);
  await logChange(tx, u.id, 'role_set', by, req.demoNow.toString());
  return { ok: true, status: 200, data: { user: (await readUser(tx, u.id))! } };
};

export const turnUserOffHandler: Handler<Out<typeof turnUserOff>> = async (req, tx) => {
  const by = staffId(req);
  const p = req.params as In<typeof turnUserOff>;
  const u = await target(tx, p.userId);
  if (!u) return refuse(404, 'not_found');
  if (u.id === by || (u.status !== 'active' && u.status !== 'invited')) return refuse(409, 'rule_refused');
  await tx.query(`UPDATE world."user" SET status = 'turned_off', status_before_off = status WHERE id = $1`, [u.id]);
  // FR-AUTH-12: turning off ends the user's sessions (the session layer also admits only an active user's session).
  await tx.query(`DELETE FROM system.session WHERE user_id = $1`, [u.id]);
  await logChange(tx, u.id, 'turned_off', by, req.demoNow.toString());
  return { ok: true, status: 200, data: { user: (await readUser(tx, u.id))! } };
};

export const turnUserOnHandler: Handler<Out<typeof turnUserOn>> = async (req, tx) => {
  const by = staffId(req);
  const p = req.params as In<typeof turnUserOn>;
  const u = await target(tx, p.userId);
  if (!u) return refuse(404, 'not_found');
  if (u.status !== 'turned_off') return refuse(409, 'rule_refused');
  // Back to the status they had when turned off: Active, or Invited (their invite link works again).
  await tx.query(`UPDATE world."user" SET status = coalesce(status_before_off, 'active'), status_before_off = NULL WHERE id = $1`, [u.id]);
  await logChange(tx, u.id, 'turned_back_on', by, req.demoNow.toString());
  return { ok: true, status: 200, data: { user: (await readUser(tx, u.id))! } };
};

// ---------- API-153 role access ----------

/**
 * The areas of CTL-OFC-43-11, each as the screens it is made of. An area is open to a role when the policy table admits the
 * role to every one of its screens (Admin: the office role opens Arrival windows and Import, but not Users, System health or
 * the demo clock, so it reads No), except Customer phones, which is open where any of its screens is (FR-AUTH-4: the
 * office's job page, the technician's own job). Read from the same table the kernel enforces (FR-AUTH-1).
 */
export const AREA_SCREENS: Readonly<Record<(typeof ROLE_AREAS)[number], { screens: readonly string[]; any?: true }>> = {
  board: { screens: ['SCR-OFC-02', 'SCR-OFC-34'] },
  jobs_customers: { screens: ['SCR-OFC-30', 'SCR-OFC-03', 'SCR-OFC-04', 'SCR-OFC-05', 'SCR-OFC-06'] },
  technicians: { screens: ['SCR-OFC-07'] },
  messages: { screens: ['SCR-OFC-08', 'SCR-OFC-09'] },
  reports: { screens: ['SCR-OFC-11'] },
  admin: { screens: ['SCR-OFC-12', 'SCR-OFC-13', 'SCR-OFC-14', 'SCR-OFC-15', 'SCR-OFC-16', 'SCR-OFC-17', 'SCR-OFC-43'] },
  phone_app: { screens: ['SCR-TEC-02', 'SCR-TEC-04', 'SCR-TEC-05', 'SCR-TEC-06', 'SCR-TEC-07', 'SCR-TEC-08', 'SCR-TEC-09', 'SCR-TEC-10', 'SCR-TEC-15', 'SCR-TEC-16'] },
  customer_phones: { screens: ['SCR-OFC-03', 'SCR-TEC-04'], any: true },
};

export function roleAreas(permissions: (role: Role) => readonly string[] = (r) => permissionsOf(r)) {
  const held = { office: new Set(permissions('office')), technician: new Set(permissions('technician')), manager: new Set(permissions('manager')) };
  const open = (role: Role, a: (typeof AREA_SCREENS)[keyof typeof AREA_SCREENS]) =>
    a.any ? a.screens.some((s) => held[role].has(s)) : a.screens.every((s) => held[role].has(s));
  return ROLE_AREAS.map((area) => {
    const a = AREA_SCREENS[area];
    return { area, office: open('office', a), technician: open('technician', a), manager: open('manager', a) };
  });
}

export const roleAccessHandler: Handler<Out<typeof roleAccess>> = async () => ({ ok: true, status: 200, data: { areas: roleAreas() } });

// ---------- API-154 recent changes ----------

export const userChangesHandler: Handler<Out<typeof userChanges>> = async (req, tx) => {
  const p = req.params as In<typeof userChanges>;
  const args: unknown[] = [];
  let after = '';
  if (p.cursor) {
    const c = decodeCursor(p.cursor);
    if (!c) return refuse(422, 'validation_failed');
    args.push(c.sortKey, c.id);
    after = `AND (c.at, c.id) < ($1::timestamptz, $2::uuid)`;
  }
  const rows = (
    await tx.query<{ id: string; at: Date; what: Out<typeof userChanges>['changes'][number]['what']; name: string; role: Role; branch_id: string; by_name: string | null }>(
      `SELECT c.id, c.at, c.what, u.name, u.role, u.branch_id, b.name AS by_name
         FROM world.user_change c JOIN world."user" u ON u.id = c.user_id LEFT JOIN world."user" b ON b.id = c."by"
        WHERE c.what IN ('invited', 'role_set', 'turned_off', 'turned_back_on') ${after}
        ORDER BY c.at DESC, c.id DESC LIMIT ${p.limit + 1}`,
      args,
    )
  ).rows;
  const page = rows.slice(0, p.limit);
  const last = page[page.length - 1];
  const next = rows.length > p.limit && last ? encodeCursor(last.at.toISOString(), last.id) : null;
  return {
    ok: true, status: 200,
    data: { changes: page.map((r) => ({ userName: r.name, what: r.what, role: r.role, branch: r.branch_id, byName: r.by_name, at: wire(r.at) })), next },
  };
};

// ---------- API-165 forgot password ----------

export const requestResetHandler: Handler<Out<typeof requestReset>> = async (req, tx, ctx) => {
  const p = req.params as In<typeof requestReset>;
  const no = (reason: 'no_account' | 'protection_on' | 'account_turned_off') => ({ ok: true as const, status: 202 as const, data: { sent: false, reason, emailLink: null } });
  // FR-AUTH-9: with reset protection on, every address gets the same answer and nothing is written.
  if (ctx.settings.RESET_PROTECTION) return no('protection_on');
  const u = (await tx.query<{ id: string; name: string; email: string; status: string; language: string; sample: boolean }>(
    `SELECT id, name, email::text AS email, status, language, sample FROM world."user" WHERE email = $1`, [p.email],
  )).rows[0];
  if (!u) return no('no_account');
  // Owner ruling 5a554f12 (Nov 2, 2026, "Block their reset"; F-333): with demo mode on, a sample person's reset is refused as
  // the hosted demo refuses it, so the password the start page lists keeps signing in.
  if (ctx.settings.DEMO_MODE && u.sample) return no('protection_on');
  // OI-45, SD-29: a turned-off user gets no reset email.
  if (u.status === 'turned_off') return no('account_turned_off');
  const now = req.demoNow.toString();
  const language: EmailLanguage = u.language === 'es' ? 'es' : 'en';
  await writePasswordToken(tx, u.id, 'reset', now);
  const words = resetEmail(language, { name: u.name });
  // The requester is signed out: the link is shown on the request page, and the store names the recipient as the person shown it.
  const sent = await sendEmail(tx, { userId: u.id, toAddress: u.email, kind: 'reset', language, subject: words.subject, body: words.body, now, shownTo: [u.id] });
  return { ok: true, status: 202, data: { sent: true, reason: null, emailLink: `/email/${sent.links[0]!.token}` } };
};

// ---------- API-166 email by one-time link ----------

export const emailByLinkHandler: Handler<Out<typeof emailByLink>> = async (req, tx) => {
  const p = req.params as In<typeof emailByLink>;
  const now = req.demoNow.toString();
  const opened = await openEmailLink(tx, p.oneTimeToken, now);
  // A second use, a reload, another session or an expired link: 410 with no content (FR-AUTH-8).
  if (!opened) return refuse(410, 'gone');
  const m = (await tx.query<{ user_id: string; sent_at: Date; name: string }>(
    `SELECT m.user_id, m.sent_at, u.name FROM world.email_message m JOIN world."user" u ON u.id = m.user_id WHERE m.id = $1`, [opened.emailId],
  )).rows[0]!;
  const links: Out<typeof emailByLink>['links'] = [];
  // F-612: of 2 emails of one kind written at one demo instant, only the newer opens a link (ids are time-ordered), so the match is one to one.
  const newer = opened.kind === 'alert' ? false : (await tx.query(
    `SELECT 1 FROM world.email_message WHERE user_id = $1 AND kind = $2 AND sent_at = $3 AND id > $4 LIMIT 1`,
    [m.user_id, opened.kind, m.sent_at.toISOString(), opened.emailId])).rows.length > 0;
  if (opened.kind === 'alert') links.push({ kind: 'system_health', href: '/office/admin/health' });
  else if (!newer) {
    const hours = opened.kind === 'invite' ? INVITE_HOURS : RESET_HOURS;
    const pt = (await tx.query<{ token_hash: Buffer }>(
      `SELECT token_hash FROM world.password_token
        WHERE user_id = $1 AND kind = $2 AND used_at IS NULL AND expires_at = $3::timestamptz + make_interval(hours => $4)
        ORDER BY token_hash LIMIT 1 FOR UPDATE`,
      [m.user_id, opened.kind, m.sent_at.toISOString(), hours],
    )).rows[0];
    if (pt) {
      const token = newToken();
      await tx.query(`UPDATE world.password_token SET token_hash = $2 WHERE token_hash = $1`, [pt.token_hash, sha256(token)]);
      links.push({ kind: opened.kind, href: `/set-password/${token}` });
    }
  }
  return {
    ok: true, status: 200,
    data: {
      inboxFor: opened.toAddress, from: EMAIL_FROM, to: opened.toAddress, subject: opened.subject, sentAt: wire(opened.sentAt), body: opened.body,
      language: opened.language, recipientFirstName: firstName(m.name), links,
    },
  };
};

// ---------- API-167, API-168 the password link ----------

interface TokenRow { token_hash: Buffer; user_id: string; kind: 'invite' | 'reset'; expires_at: Date; used_at: Date | null; email: string; name: string; role: Role; branch_id: string; status: string }

async function passwordToken(tx: Tx, token: string, lock: boolean): Promise<TokenRow | undefined> {
  return (await tx.query<TokenRow>(
    `SELECT t.token_hash, t.user_id, t.kind, t.expires_at, t.used_at, u.email::text AS email, u.name, u.role, u.branch_id, u.status
       FROM world.password_token t JOIN world."user" u ON u.id = t.user_id WHERE t.token_hash = $1 ${lock ? 'FOR UPDATE OF t, u' : ''}`,
    [sha256(token)],
  )).rows[0];
}

/** gone for a used or run-out link; account_turned_off (the link is kept, it works again once turned back on, OI-45). */
function linkRefusal<T>(t: TokenRow | undefined, now: Date): ApiResult<T> | null {
  if (!t) return refuse(404, 'not_found');
  if (t.used_at || t.expires_at.getTime() <= now.getTime()) return refuse(410, 'gone');
  if (t.status === 'turned_off') return refuse(403, 'account_turned_off');
  return null;
}

export const passwordLinkHandler: Handler<Out<typeof passwordLink>> = async (req, tx) => {
  const p = req.params as In<typeof passwordLink>;
  const t = await passwordToken(tx, p.passwordToken, false);
  const no = linkRefusal<Out<typeof passwordLink>>(t, new Date(req.demoNow.epochMilliseconds));
  if (no || !t) return no ?? refuse(404, 'not_found');
  return { ok: true, status: 200, data: { kind: t.kind, user: { name: t.name, role: t.role, branch: t.branch_id }, app: appOf(t.role) } };
};

/** SD-29's rules beyond the length: not the email, not 1 repeated character. */
export function passwordRuleBroken(password: string, email: string): 'is_email' | 'one_character' | null {
  if (password.trim().toLowerCase() === email.trim().toLowerCase()) return 'is_email';
  if ([...new Set(password)].length === 1) return 'one_character';
  return null;
}

export const setPasswordHandler: Handler<Out<typeof setPassword>> = async (req, tx) => {
  const p = req.params as In<typeof setPassword>;
  const t = await passwordToken(tx, p.passwordToken, true);
  const no = linkRefusal<Out<typeof setPassword>>(t, new Date(req.demoNow.epochMilliseconds));
  if (no || !t) return no ?? refuse(404, 'not_found');
  const broken = passwordRuleBroken(p.password, t.email);
  if (broken) return refuse(422, 'validation_failed');
  const now = req.demoNow.toString();
  // OI-43: an invited user becomes Active when the password is set (an invite, or a reset requested while Invited).
  await tx.query(`UPDATE world."user" SET password_hash = $2, status = CASE WHEN status = 'invited' THEN 'active' ELSE status END WHERE id = $1`,
    [t.user_id, await hashPassword(p.password)]);
  await tx.query(`UPDATE world.password_token SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL`, [t.user_id, now]);
  // The old password is refused from then on, and a session made with it ends.
  await tx.query(`DELETE FROM system.session WHERE user_id = $1`, [t.user_id]);
  await logChange(tx, t.user_id, 'password_set', t.user_id, now);
  return { ok: true, status: 200, data: { app: appOf(t.role) } };
};

// ---------- token checks the kernel runs before a token route ----------

/** The one-time email link and the password link checks (mount.ts): a known token passes; the handler decides gone. */
export const accountTokenChecks: { one_time: TokenCheck; password: TokenCheck } = {
  one_time: async (token, tx) => (await tx.query(`SELECT 1 FROM world.email_link WHERE token_hash = $1`, [sha256(token)])).rows.length > 0,
  password: async (token, tx) => (await tx.query(`SELECT 1 FROM world.password_token WHERE token_hash = $1`, [sha256(token)])).rows.length > 0,
};

