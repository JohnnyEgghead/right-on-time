// SPDX-License-Identifier: AGPL-3.0-or-later
// Sessions (SPECIFICATIONS SD-8, GAP-16; FR-AUTH-10). A token is 32 random bytes (base64url), stored only as its
// SHA-256. Web: cookie `bw_session` (httpOnly, Secure on HTTPS, SameSite=Lax). Native: `Authorization: Bearer`.
// Lifetimes are real time: idle limits by realNow('session_idle'), lengths by realNow('session_lifetime'), so a demo
// clock jump never ends a session.
//
// Durable writes and their re-run semantics:
//   - create: 1 INSERT of a fresh random hash; a retry after an unknown outcome makes a second, independent session
//     (the first, if it committed, simply idles out). Never an update of another row.
//   - touch: UPDATE last_seen_real = greatest(last_seen_real, now), at most once a minute per session; replaying it
//     converges (greatest), and never moves the idle limit backwards or revives a session past expires_real.
//   - remove: DELETE by hash; replaying it is a no-op.
import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '@bw/db';
import { Temporal, type Clock, type Instant } from '@bw/time';
import type { Caller, Role } from '../types.ts';

export const SESSION_COOKIE = 'bw_session';

export interface SessionRecord {
  tokenHash: Buffer;
  userId: string;
  role: Role;
  userStatus: string;
  client: 'web' | 'native';
  via: 'password' | 'sign_in_as';
  keepSignedIn: boolean;
  createdReal: Instant;
  lastSeenReal: Instant;
  expiresReal: Instant;
}

export interface SessionStore {
  /** The session and its user's role and status, or null. */
  find(tokenHash: Buffer): Promise<SessionRecord | null>;
  create(rec: Omit<SessionRecord, 'role' | 'userStatus'>): Promise<void>;
  touch(tokenHash: Buffer, at: Instant): Promise<void>;
  remove(tokenHash: Buffer): Promise<void>;
}

/** The idle and total length limits of a session by role and keep-signed-in choice (SD-8). */
export function lifetimes(role: Role, keepSignedIn: boolean): { idle: Temporal.Duration; length: Temporal.Duration } {
  if (keepSignedIn) return { idle: Temporal.Duration.from({ hours: 30 * 24 }), length: Temporal.Duration.from({ hours: 90 * 24 }) };
  if (role === 'technician') return { idle: Temporal.Duration.from({ hours: 8 }), length: Temporal.Duration.from({ hours: 14 }) };
  return { idle: Temporal.Duration.from({ minutes: 30 }), length: Temporal.Duration.from({ hours: 12 }) };
}

export function newSessionToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export const hashToken = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/** A well-formed token: 32 bytes of base64url (43 characters). Anything else is never looked up. */
export const isTokenShape = (t: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(t);

/** Is the session alive at these real times? Idle and length are read separately, each by its own use tag. */
export function sessionAlive(s: SessionRecord, idleNow: Instant, lifetimeNow: Instant): boolean {
  if (Temporal.Instant.compare(lifetimeNow, s.expiresReal) >= 0) return false;
  const idleEnd = s.lastSeenReal.add(lifetimes(s.role, s.keepSignedIn).idle);
  return Temporal.Instant.compare(idleNow, idleEnd) < 0;
}

/** Start a session for a signed-in user (API-03 and Sign in as call this; P2-AUTH). Returns the token to hand out once. */
export async function startSession(
  store: SessionStore,
  clock: Pick<Clock, 'realNow'>,
  user: { userId: string; role: Role },
  opts: { client: 'web' | 'native'; via: 'password' | 'sign_in_as'; keepSignedIn: boolean },
): Promise<string> {
  const { token, hash } = newSessionToken();
  const now = clock.realNow('session_lifetime');
  const expiresReal = now.add(lifetimes(user.role, opts.keepSignedIn).length);
  await store.create({ tokenHash: hash, userId: user.userId, ...opts, createdReal: now, lastSeenReal: clock.realNow('session_idle'), expiresReal });
  return token;
}

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    if (!out.has(k)) out.set(k, part.slice(eq + 1).trim());
  }
  return out;
}

export interface Presented {
  token: string;
  via: 'cookie' | 'bearer';
}

/** The session token a request presents: a bearer token (native app) wins over the cookie (web). */
export function presentedToken(headers: Headers): Presented | null {
  const auth = headers.get('authorization');
  const bearer = auth ? /^Bearer ([A-Za-z0-9_-]+)$/.exec(auth)?.[1] : undefined;
  if (bearer) return { token: bearer, via: 'bearer' };
  const cookie = parseCookies(headers.get('cookie')).get(SESSION_COOKIE);
  return cookie ? { token: cookie, via: 'cookie' } : null;
}

const TOUCH_EVERY_S = 60;

/**
 * Resolve the caller of a request (SD-8). A dead session is removed; a turned-off or invited user, a token of the wrong
 * client (a cookie for a native session or a bearer for a web one) and a malformed token all resolve to anonymous.
 * `signInAsHonored` is false while the access code is on and the request has no valid `bw_access` cookie: a
 * `sign_in_as` session then does not count (SD-8, OI-17).
 */
export async function resolveCaller(
  store: SessionStore,
  clock: Pick<Clock, 'realNow'>,
  presented: Presented | null,
  signInAsHonored: boolean,
): Promise<Caller> {
  if (!presented || !isTokenShape(presented.token)) return { kind: 'anonymous' };
  const hash = hashToken(presented.token);
  const s = await store.find(hash);
  if (!s) return { kind: 'anonymous' };
  const idleNow = clock.realNow('session_idle');
  if (!sessionAlive(s, idleNow, clock.realNow('session_lifetime'))) {
    await store.remove(hash);
    return { kind: 'anonymous' };
  }
  if (s.userStatus !== 'active') return { kind: 'anonymous' };
  if ((presented.via === 'bearer') !== (s.client === 'native')) return { kind: 'anonymous' };
  if (s.via === 'sign_in_as' && !signInAsHonored) return { kind: 'anonymous' };
  if (idleNow.since(s.lastSeenReal).total('seconds') >= TOUCH_EVERY_S) await store.touch(hash, idleNow);
  return { kind: 'staff', userId: s.userId, role: s.role, client: s.client, via: s.via };
}

/** The Set-Cookie value for a web session: a browser session cookie, or 90 days with Keep me signed in. */
export function sessionCookie(token: string, keepSignedIn: boolean, secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (keepSignedIn) parts.push(`Max-Age=${90 * 24 * 3600}`);
  return parts.join('; ');
}

/** The Set-Cookie value that ends the web session cookie (API-06 on every answer, F-230). */
export function clearedSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Cookies are Secure on an https origin (SD-8); the access cookie is Secure only over https, FR-AUTH-6 (access-code.ts). */
export const secureCookies = (appOrigin: string): boolean => appOrigin.startsWith('https:');

const ROLES_SET: ReadonlySet<string> = new Set(['office', 'manager', 'technician']);

/** The production store: system.session joined with world."user" (section 3). */
export class SqlSessionStore implements SessionStore {
  readonly #db: Queryable;
  constructor(db: Queryable) {
    this.#db = db;
  }

  async find(tokenHash: Buffer): Promise<SessionRecord | null> {
    const r = await this.#db.query<Record<string, unknown>>(
      `SELECT s.token_hash, s.user_id, u.role, u.status, s.client, s.via, s.keep_signed_in, s.created_real, s.last_seen_real, s.expires_real
         FROM system.session s JOIN world."user" u ON u.id = s.user_id
        WHERE s.token_hash = $1`,
      [tokenHash],
    );
    const row = r.rows[0];
    if (!row) return null;
    const role = String(row.role);
    const client = String(row.client);
    const via = String(row.via);
    if (!ROLES_SET.has(role) || (client !== 'web' && client !== 'native') || (via !== 'password' && via !== 'sign_in_as')) return null;
    const at = (v: unknown) => Temporal.Instant.fromEpochMilliseconds((v as Date).getTime());
    return {
      tokenHash, userId: String(row.user_id), role: role as Role, userStatus: String(row.status), client, via,
      keepSignedIn: row.keep_signed_in === true, createdReal: at(row.created_real), lastSeenReal: at(row.last_seen_real), expiresReal: at(row.expires_real),
    };
  }

  async create(rec: Omit<SessionRecord, 'role' | 'userStatus'>): Promise<void> {
    await this.#db.query(
      `INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [rec.tokenHash, rec.userId, rec.client, rec.via, rec.keepSignedIn, rec.createdReal.toString(), rec.lastSeenReal.toString(), rec.expiresReal.toString()],
    );
  }

  async touch(tokenHash: Buffer, at: Instant): Promise<void> {
    await this.#db.query(
      'UPDATE system.session SET last_seen_real = greatest(last_seen_real, $2::timestamptz) WHERE token_hash = $1 AND expires_real > $2::timestamptz',
      [tokenHash, at.toString()],
    );
  }

  async remove(tokenHash: Buffer): Promise<void> {
    await this.#db.query('DELETE FROM system.session WHERE token_hash = $1', [tokenHash]);
  }
}

/** A store in memory, for unit tests and the role-by-route test's principals; same contract as SqlSessionStore. */
export class MemorySessionStore implements SessionStore {
  readonly sessions = new Map<string, Omit<SessionRecord, 'role' | 'userStatus'>>();
  readonly users = new Map<string, { role: Role; status: string }>();

  async find(tokenHash: Buffer): Promise<SessionRecord | null> {
    const s = this.sessions.get(tokenHash.toString('hex'));
    const u = s && this.users.get(s.userId);
    return s && u ? { ...s, role: u.role, userStatus: u.status } : null;
  }
  async create(rec: Omit<SessionRecord, 'role' | 'userStatus'>): Promise<void> {
    this.sessions.set(rec.tokenHash.toString('hex'), { ...rec });
  }
  async touch(tokenHash: Buffer, at: Instant): Promise<void> {
    const s = this.sessions.get(tokenHash.toString('hex'));
    if (s && Temporal.Instant.compare(at, s.expiresReal) < 0 && Temporal.Instant.compare(at, s.lastSeenReal) > 0) s.lastSeenReal = at;
  }
  async remove(tokenHash: Buffer): Promise<void> {
    this.sessions.delete(tokenHash.toString('hex'));
  }
}
