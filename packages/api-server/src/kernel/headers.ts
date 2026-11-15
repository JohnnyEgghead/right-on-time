// SPDX-License-Identifier: AGPL-3.0-or-later
// Security headers (SPECIFICATIONS section 11.5): every page answers with the CSP, nosniff and no-referrer; HSTS on the
// hosted origin is nginx's (infra/nginx/security-headers.conf), which terminates TLS. The CSP is also the run-time half
// of self-containment (NFR-12): no outside host can be fetched, framed or scripted.

export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});

/** Set the 11.5 headers on a Headers object (overwriting any a page or handler set). */
export function applySecurityHeaders(h: Headers): Headers {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  return h;
}
