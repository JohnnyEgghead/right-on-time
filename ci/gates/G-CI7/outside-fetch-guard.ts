// SPDX-License-Identifier: AGPL-3.0-or-later
// F-683: G-CI7's guard against the host-dependent DNS stall (F-643). A handler that reaches another service by host name would resolve
// that name, and the lookup stalls past the 60 s test limit on a host with no resolver for it. Every test of the gate's kernel steps runs
// with fetch refusing any URL whose host is not loopback, so a new outbound call fails at once, on every host, with the host named.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** The host of a fetch input that is not loopback, or null (a relative or non-http URL has none to resolve). */
export function outsideHost(input: unknown): string | null {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url?: string } | null)?.url;
  if (typeof raw !== 'string') return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return LOOPBACK.has(u.hostname) ? null : u.hostname;
}

type Fetch = typeof fetch;

/** `real` behind the guard: a fetch to a non-loopback host throws before any lookup. */
export function guardedFetch(real: Fetch): Fetch {
  return ((input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
    const host = outsideHost(input);
    if (host !== null) {
      return Promise.reject(new Error(`G-CI7: outbound fetch to ${host}, which is not a loopback host (F-683): a handler must not call a service by host name in a gate test`));
    }
    return real(input, init);
  }) as Fetch;
}
