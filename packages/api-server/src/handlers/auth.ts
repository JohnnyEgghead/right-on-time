// SPDX-License-Identifier: AGPL-3.0-or-later
// The sign-in handlers (P2-AUTH; SPECIFICATIONS 6.8, SD-8, SD-9, SD-47; UI-SPECIFICATION 12.2):
//   API-01 enter the access code      API-02 app info          API-03 sign in (email or employee number, password)
//   API-04 sample people              API-05 sign in as        API-06 sign out
//   API-15 sample technician sign-ins
// Each durable write and its re-run semantics:
//   - API-03 / API-05: 1 INSERT of a fresh random session (sessions.ts startSession) and 1 UPDATE of the user's last sign-in
//     columns, in the call's transaction; a retry after an unknown outcome makes a second, independent session.
//   - API-06: DELETE of the presented session by hash; replaying it is a no-op. The cookie is cleared by the kernel on
//     every answer (mount.ts), so a failed or refused call still ends the browser's session (F-230).
//   - API-01 writes nothing: it verifies against the active system.access_code row (hashed at start, web.ts) and issues the
//     signed cookie.
import type { appInfo as appInfoRow, enterAccessCode, samplePeople, signIn, signInAs, signOut, techSignIns } from '@bw/api';
import { hashPassword, samplePassword, showSamplePassword, verifyPassword } from '@bw/db';
import type { z } from 'zod';
import { issueAccessCookie } from '../kernel/access-code.ts';
import { hashToken, isTokenShape, secureCookies, SqlSessionStore, sessionCookie, startSession } from '../kernel/sessions.ts';
import type { Handler, HandlerContext, Role, Tx } from '../types.ts';

type Out<R extends { response: z.ZodType }> = z.output<R['response']>;

/**
 * The 5 technicians the approved start page lists (mockups/pages/r1-gate-a-start.html SIGNS, CTL-GATE-02-04), in its order.
 * API-15 lists only these, each only when they can sign in (SIGNABLE). Owner ruling b66aaae8 (Nov 1, 2026; F-283): the start
 * page shows a short list, the approved frame's people, not every sample technician. This is the only place the set is kept.
 */
export const START_PAGE_SIGN_INS: readonly string[] = [
  'maria.santos@brightwater.example',
  'luis.ortega@brightwater.example',
  'ryan.mitchell@brightwater.example',
  'derek.simmons@brightwater.example',
  'teresa.molina@brightwater.example',
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The shown form of a sample password (SD-9): 5 and 5 characters with a hyphen. */
const SHOWN_SAMPLE = /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/;

export const enterAccessCodeHandler: Handler<Out<typeof enterAccessCode>> = async (req, tx, ctx) => {
  const { code } = req.params as { code: string };
  const row = (await tx.query<{ code_hash: string }>('SELECT code_hash FROM system.access_code WHERE active ORDER BY created_real DESC LIMIT 1')).rows[0];
  if (!row || !(await verifyPassword(code, row.code_hash))) return { ok: false, status: 403, code: 'code_invalid' };
  if (ctx.accessKey === null) throw new Error('API-01 was mounted without the access signing key');
  return { ok: true, status: 204, data: {}, cookies: [issueAccessCookie(ctx.accessKey, ctx.clock, ctx.secure)] };
};

export const appInfoHandler: Handler<Out<typeof appInfoRow>> = async (_req, _tx, ctx) => {
  const repo = (ctx.settings.SOURCE_REPO_URL ?? '').replace(/\/$/, '');
  const commit = ctx.settings.PUBLIC_COMMIT ?? 'unknown';
  // FR-DIST-3: the source link is the repo at the commit of the running release; a developer build (commit unknown) links the repo.
  const sourceUrl = commit === 'unknown' ? repo : `${repo}/commit/${commit}`;
  return { ok: true, status: 200, data: { demoMode: ctx.settings.DEMO_MODE, accessCodeOn: ctx.settings.ACCESS_CODE_ON, sourceUrl, sourceCommit: commit } };
};

interface LoginRow {
  id: string;
  name: string;
  role: Role;
  branch_id: string;
  language: 'en' | 'es';
  status: string;
  password_hash: string | null;
  employee_number: string | null;
  sample: boolean;
}

const LOGIN_COLUMNS = 'id, name, role, branch_id, language, status, password_hash, employee_number, sample';

let burn: Promise<string> | undefined;
/** A verify against a real hash for a login that matches no user, so a wrong login costs what a wrong password costs. */
async function burnOne(password: string): Promise<void> {
  await verifyPassword(password, await (burn ??= hashPassword('no such user')));
}

/** FR-AUTH-3 and the manager ruling: a sample person's shown password (xxxxx-xxxxx) is accepted with its hyphen stripped. */
async function passwordMatches(user: Pick<LoginRow, 'password_hash' | 'sample'>, typed: string): Promise<boolean> {
  // F-284: an Invited user (no hash) pays the verify an unknown login pays, so the time does not tell the two apart.
  if (user.password_hash === null) {
    await burnOne(typed);
    return false;
  }
  if (await verifyPassword(typed, user.password_hash)) return true;
  if (user.sample && SHOWN_SAMPLE.test(typed)) return verifyPassword(typed.replace('-', '').toUpperCase(), user.password_hash);
  return false;
}

/** The session, its last-sign-in columns (SPECIFICATIONS section 3 writer table) and the answer shared by API-03 and API-05. */
async function openSession(
  tx: Tx, ctx: HandlerContext, user: LoginRow, demoNow: string,
  how: { client: 'web' | 'native'; via: 'password' | 'sign_in_as'; keepSignedIn: boolean },
) {
  const token = await startSession(new SqlSessionStore(tx), ctx.clock, { userId: user.id, role: user.role }, how);
  const app = how.client === 'native' ? 'tech_native' : user.role === 'technician' ? 'tech_web' : 'office';
  await tx.query('UPDATE world."user" SET last_sign_in_at = $2::timestamptz, last_sign_in_app = $3 WHERE id = $1', [user.id, demoNow, app]);
  // FR-TECH-15 (SPECIFICATIONS 6.3 Me screen): a technician's day starts at its first sign-in or applied status item by the demo clock, so
  // the Me screen's start time is the earlier of the two (F-1007: a status item entered offline and sent after a later sign-in counts by its own time).
  if (user.role === 'technician') {
    await tx.query(
      `INSERT INTO world.technician_day (technician_id, date, started_at)
       SELECT t.id, ($2::timestamptz AT TIME ZONE b.zone)::date, $2::timestamptz
         FROM world.technician t JOIN world.branch b ON b.id = t.branch_id WHERE t.user_id = $1
       ON CONFLICT (technician_id, date) DO UPDATE SET started_at = LEAST(world.technician_day.started_at, EXCLUDED.started_at)`, [user.id, demoNow]);
  }
  const data = {
    user: { id: user.id, name: user.name, role: user.role, branch: user.branch_id, language: user.language, employeeNumber: user.employee_number },
    token: how.client === 'native' ? token : null,
  };
  const cookies = how.client === 'web' ? [sessionCookie(token, how.keepSignedIn, secureCookies(ctx.settings.APP_ORIGIN))] : [];
  return { ok: true as const, status: 200 as const, data, cookies };
}

export const signInHandler: Handler<Out<typeof signIn>> = async (req, tx, ctx) => {
  const p = req.params as { login: string; password: string; client: 'web' | 'native'; keepSignedIn: boolean };
  const login = p.login.trim();
  // FR-AUTH-11: an email, or a 5-digit employee number (a technician's); a wrong one answers what a wrong email answers.
  const byNumber = /^\d{5}$/.test(login);
  const user = (await tx.query<LoginRow>(`SELECT ${LOGIN_COLUMNS} FROM world."user" WHERE ${byNumber ? 'employee_number' : 'email'} = $1`, [login])).rows[0];
  if (!user) {
    await burnOne(p.password);
    return { ok: false, status: 401, code: 'credentials_invalid' };
  }
  if (!(await passwordMatches(user, p.password))) return { ok: false, status: 401, code: 'credentials_invalid' };
  if (user.status === 'turned_off') return { ok: false, status: 403, code: 'account_turned_off' };
  if (user.status !== 'active') return { ok: false, status: 401, code: 'credentials_invalid' };
  return openSession(tx, ctx, user, req.demoNow.toString(), { client: p.client, via: 'password', keepSignedIn: p.keepSignedIn });
};

/** A sample person who can sign in: sample, Active, with a password (an Invited user has none). */
const SIGNABLE = `sample AND status = 'active' AND password_hash IS NOT NULL`;

/**
 * The 5 people the approved office sign-in frame lists under Sign in as (mockups/pages/office-signin.html, CTL-OFC-01-05), in its
 * order: Dana Ruiz, Keisha Thompson, Ana Gutierrez, Maria Santos, Luis Ortega. API-04 lists only these and API-05 signs in only as
 * them, each only while they can sign in (SIGNABLE). Owner ruling b66aaae8 ("A short list", Nov 1, 2026): a Sign in as list shows
 * the approved frame's people, not every sample person with a password (F-281, F-317, F-1654). This is the only place the set is kept.
 */
export const SIGN_IN_AS_LISTED: readonly string[] = [
  'dana.ruiz@brightwater.example',
  'keisha.t@brightwater.example',
  'ana.gutierrez@brightwater.example',
  'maria.santos@brightwater.example',
  'luis.ortega@brightwater.example',
];

/**
 * F-288 (owner ruling cb5d1273, "Code required"): the sample lists (API-04, API-05, API-15) answer only a caller who entered the access
 * code (or when the code is off). A password session passes the gate (SD-47 step 2) but not these three rows.
 */
function codeOk(ctx: HandlerContext): boolean {
  return !ctx.settings.ACCESS_CODE_ON || ctx.codeEntered;
}

export const samplePeopleHandler: Handler<Out<typeof samplePeople>> = async (req, tx, ctx) => {
  if (!ctx.settings.DEMO_MODE) return { ok: false, status: 403, code: 'demo_mode_off' };
  if (!codeOk(ctx)) return { ok: false, status: 403, code: 'access_code_required' };
  const { app } = req.params as { app: 'office' | 'tech' };
  const rows = (
    await tx.query<{ id: string; name: string; title: string | null; role: Role; branch_id: string; language: 'en' | 'es' }>(
      `SELECT id, name, title, role, branch_id, language FROM world."user"
        WHERE ${SIGNABLE} AND email = ANY($1::citext[]) ${app === 'tech' ? `AND role = 'technician'` : ''}
        ORDER BY array_position($1::citext[], email)`,
      [SIGN_IN_AS_LISTED],
    )
  ).rows;
  const people = rows.map((r) => ({ personId: r.id, name: r.name, job: r.title ?? 'Technician', role: r.role, branch: r.branch_id, language: r.language }));
  return { ok: true, status: 200, data: { people } };
};

export const signInAsHandler: Handler<Out<typeof signInAs>> = async (req, tx, ctx) => {
  if (!ctx.settings.DEMO_MODE) return { ok: false, status: 403, code: 'demo_mode_off' };
  if (!codeOk(ctx)) return { ok: false, status: 403, code: 'access_code_required' };
  const p = req.params as { personId: string; keepSignedIn: boolean };
  if (!UUID.test(p.personId)) return { ok: false, status: 404, code: 'not_found' };
  const user = (await tx.query<LoginRow>(`SELECT ${LOGIN_COLUMNS} FROM world."user" WHERE id = $1 AND ${SIGNABLE} AND email = ANY($2::citext[])`, [p.personId, SIGN_IN_AS_LISTED])).rows[0];
  if (!user) return { ok: false, status: 404, code: 'not_found' };
  return openSession(tx, ctx, user, req.demoNow.toString(), { client: 'web', via: 'sign_in_as', keepSignedIn: p.keepSignedIn });
};

export const signOutHandler: Handler<Out<typeof signOut>> = async (_req, tx, ctx) => {
  if (ctx.presented && isTokenShape(ctx.presented.token)) await new SqlSessionStore(tx).remove(hashToken(ctx.presented.token));
  return { ok: true, status: 204, data: {} };
};

export const techSignInsHandler: Handler<Out<typeof techSignIns>> = async (_req, tx, ctx) => {
  if (!ctx.settings.DEMO_MODE) return { ok: false, status: 403, code: 'demo_mode_off' };
  if (!codeOk(ctx)) return { ok: false, status: 403, code: 'access_code_required' };
  const seed = ctx.settings.SAMPLE_PASSWORD_SEED;
  // SD-9: the plain value is derived on request from the seed and the email; the database holds only the hash. Only a user who
  // can sign in is listed (an Invited technician has no password, F-273).
  const rows = seed
    ? (
        await tx.query<{ name: string; email: string; branch_id: string; language: 'en' | 'es' }>(
          `SELECT name, email::text AS email, branch_id, language FROM world."user" WHERE ${SIGNABLE} AND role = 'technician' AND email = ANY($1::citext[])`,
          [START_PAGE_SIGN_INS],
        )
      ).rows
    : [];
  const order = (e: string) => START_PAGE_SIGN_INS.indexOf(e.toLowerCase());
  const signIns = rows
    .sort((a, b) => order(a.email) - order(b.email))
    .map((r) => ({ name: r.name, branch: r.branch_id, language: r.language, email: r.email, password: showSamplePassword(samplePassword(seed!, r.email)) }));
  const link = ctx.settings.IOS_INSTALL_KIND === undefined || ctx.settings.IOS_INSTALL_KIND === 'none' ? null : (ctx.settings.IOS_INSTALL_LINK ?? null) || null;
  return { ok: true, status: 200, data: { signIns, iosAppLink: link } };
};
