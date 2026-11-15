// SPDX-License-Identifier: AGPL-3.0-or-later
// The access cookie's Secure attribute follows the scheme the request arrived over (F-304, SPECIFICATIONS 6.8 FR-AUTH-6).
import { describe, expect, it } from 'vitest';
import { FixedClock } from '@bw/time';
import { issueAccessCookie, requestIsHttps } from './access-code.ts';

const clock = new FixedClock({ demo: '2026-09-15T14:28:00Z', real: '2026-11-01T12:00:00Z', worldEpoch: 3 });
const key = 'k'.repeat(43);
const attrs = (c: string) => c.split('; ').slice(1);

describe('the bw_access cookie and the request scheme', () => {
  // why: F-304 over https the cookie is Secure, over plain http it is not (a Secure cookie over http locks WebKit out of an own copy)
  it('sets Secure on an https request and leaves it off on an http request', () => {
    expect(attrs(issueAccessCookie(key, clock, true))).toEqual(['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=2592000']);
    expect(attrs(issueAccessCookie(key, clock, false))).toEqual(['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=2592000']);
  });

  // why: F-304 https is read from a direct https URL or from the proxy's X-Forwarded-Proto, and a plain http request without it is http
  it('decides https from the URL or the forwarded protocol', () => {
    const h = (v?: string) => new Headers(v === undefined ? {} : { 'x-forwarded-proto': v });
    expect(requestIsHttps('https://site.example/api', h())).toBe(true);
    expect(requestIsHttps('http://web:3000/api', h('https'))).toBe(true);
    expect(requestIsHttps('http://web:3000/api', h('HTTPS, http'))).toBe(true);
    expect(requestIsHttps('http://web:3000/api', h('http'))).toBe(false);
    expect(requestIsHttps('http://web:3000/api', h())).toBe(false);
  });
});
