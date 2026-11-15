// SPDX-License-Identifier: AGPL-3.0-or-later
// The access-code gate's cookie (SPECIFICATIONS 6.8 FR-AUTH-6, SD-8, OI-17): `bw_access`, httpOnly, Secure on https (F-304),
// SameSite=Lax, valid 30 days by realNow('access_cookie'). Its value is `v1.<issued real ms>.<HMAC-SHA256>` under
// ACCESS_COOKIE_KEY, so the server keeps no cookie table; changing the key ends every cookie. API-01 (P2-AUTH) issues it
// after checking the code against system.access_code; the kernel only verifies it.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Clock } from '@bw/time';

export const ACCESS_COOKIE = 'bw_access';
export const ACCESS_COOKIE_DAYS = 30;
/** A cookie issued up to this far in the future (clock skew between web processes) still counts. */
const SKEW_MS = 5 * 60_000;

const mac = (key: string, payload: string) => createHmac('sha256', key).update(payload, 'utf8').digest('base64url');

/**
 * A key for a process whose access code is off: random per start. With the code on the key is required (config.ts), so a
 * restart or a deploy never ends every visitor's code (F-218; SPECIFICATIONS 11.1 "generated at first start" is met by
 * the owner setting it once).
 */
export const generatedAccessKey = (): string => randomBytes(32).toString('base64url');

/**
 * Whether a request reached the site over https (F-304). A direct https connection shows in the request URL. Behind the
 * proxy the web process sees plain http, and nginx names the browser's scheme in X-Forwarded-Proto: it writes that header on
 * every request (infra/nginx/routes-open.conf), keeping an https claim only from a private or loopback peer, which is how
 * the CI rig's https front (ci/auth-stack/tls-front.ts) reaches it. The web port is reachable only through nginx (compose
 * expose, never published), so the header is read here without a peer check; a client cannot reach this process to forge it.
 */
export function requestIsHttps(url: string, headers: Pick<Headers, 'get'>): boolean {
  if (url.startsWith('https:')) return true;
  return headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() === 'https';
}

/**
 * The Set-Cookie value of an entered code. Secure only when the request arrived over https (F-304): a browser such as
 * Playwright WebKit stores no Secure cookie over plain http, so an own copy on http://localhost would loop back to the gate.
 */
export function issueAccessCookie(key: string, clock: Pick<Clock, 'realNow'>, secure: boolean): string {
  const payload = `v1.${clock.realNow('access_cookie').epochMilliseconds}`;
  const parts = [`${ACCESS_COOKIE}=${payload}.${mac(key, payload)}`, 'Path=/', 'HttpOnly'];
  if (secure) parts.push('Secure');
  parts.push('SameSite=Lax', `Max-Age=${ACCESS_COOKIE_DAYS * 86_400}`);
  return parts.join('; ');
}

export function accessCookieValid(value: string | undefined, key: string, clock: Pick<Clock, 'realNow'>): boolean {
  if (!value) return false;
  const m = /^v1\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return false;
  const want = Buffer.from(mac(key, `v1.${m[1]}`));
  const got = Buffer.from(m[2]!);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  const issued = Number(m[1]);
  const now = clock.realNow('access_cookie').epochMilliseconds;

  return issued <= now + SKEW_MS && now - issued < ACCESS_COOKIE_DAYS * 86_400_000;
}
