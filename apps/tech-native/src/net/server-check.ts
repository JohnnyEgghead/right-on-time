// SPDX-License-Identifier: AGPL-3.0-or-later
// CTL-TEC-12-02 Check connection (FR-IOS-3; SCR-TEC-12 states Reachable, Unreachable and Not this product): API-105 on the typed
// address. An answer that parses as API-105's envelope from a Right On Time server is Reachable; any other answer is another kind of
// server; no answer (a network error, or none within the wait) is Unreachable.
import { createClient, envelopeSchema, serverInfo } from '@bw/api';

export type ServerCheck = { kind: 'reachable'; version: string } | { kind: 'unreachable' } | { kind: 'not_this_product' };

/** How long Check connection waits for an answer before it says the address does not answer. */
const CHECK_WAIT_MS = 10_000;

export async function checkServer(origin: string, doFetch: typeof fetch = fetch, waitMs = CHECK_WAIT_MS): Promise<ServerCheck> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), waitMs);
  try {
    const client = createClient({ baseUrl: origin, fetch: (url, init) => doFetch(url, { ...init, signal: ctl.signal }) });
    let answer: { status: number; body: unknown };
    try {
      answer = await client.raw(serverInfo, {});
    } catch {
      return { kind: 'unreachable' };
    }
    if (answer.status !== 200) return { kind: 'not_this_product' };
    const env = envelopeSchema(serverInfo.response).safeParse(answer.body);
    return env.success ? { kind: 'reachable', version: env.data.data.version } : { kind: 'not_this_product' };
  } finally {
    clearTimeout(timer);
  }
}
