// SPDX-License-Identifier: AGPL-3.0-or-later
// The real components G-CI7 reads verdicts from: the mounted router over a table and its handlers, the page gate, and
// principals whose sessions the real session layer creates and resolves (only the session store is in memory).
import { kit, type Kit } from '../../../packages/api-server/src/testing.ts';
import { ORIGIN } from '../../../packages/api-server/src/testing.ts';
import { presentedToken, resolveCaller } from '../../../packages/api-server/src/kernel/sessions.ts';
import { accessCookieValid } from '../../../packages/api-server/src/kernel/access-code.ts';
import type { Handler, PolicyEntry } from '../../../packages/api-server/src/types.ts';
import { fill, GATES, PRINCIPALS, type ApiCall, type Principal } from './lib.ts';

type Who = (typeof PRINCIPALS)[number];

export interface Harness {
  call: ApiCall;
  principal: (who: Who) => Principal;
}

let address = 0;

/** 1 kit per gate state (the access-code switch is a start-up setting), each with 1 session per principal. */
export async function harness(table: readonly PolicyEntry[], handlers: Record<string, Handler<unknown>>): Promise<Harness> {
  const kits = new Map<string, { k: Kit; cookies: Map<string, string> }>();
  for (const g of GATES) {
    const k = kit(table, handlers, { ACCESS_CODE_ON: g.codeOn }, { inbox: async () => true, live_map: async () => true, reschedule: async () => true, booking: async () => true, email: async () => true, password: async () => true, one_time: async () => true });
    const cookies = new Map<string, string>();
    for (const who of PRINCIPALS) {
      const parts: string[] = [];
      if (who.role && who.via) parts.push((await k.signIn(who.role, { via: who.via })).cookie);
      if (g.codeEntered) parts.push(k.accessCookie());
      cookies.set(who.name, parts.join('; '));
    }
    kits.set(g.name, { k, cookies });
  }
  const at = (g: { codeOn: boolean; codeEntered: boolean }) => kits.get(GATES.find((x) => x.codeOn === g.codeOn && x.codeEntered === g.codeEntered)!.name)!;
  return {
    async call(entry, who, g) {
      const { k, cookies } = at(g);
      const write = entry.method !== 'GET';
      const headers: Record<string, string> = { 'x-forwarded-for': `192.0.2.${++address % 250}` };
      const cookie = cookies.get(who.name)!;
      if (cookie) headers.cookie = cookie;
      if (write) headers.origin = ORIGIN;
      // A row on a shared route (API-80, API-84) is reached through its selector, so its verdict is its own entry's.
      const sel = entry.row.selector;
      const body = JSON.stringify(sel ? { [sel.field]: sel.value } : {});
      const res = await k.router.handle(new Request(`http://web:3000${fill(entry.path)}`, {
        method: entry.method, headers: { ...headers, ...(write ? { 'content-type': 'application/json' } : {}) }, ...(write ? { body } : {}),
      }));
      if (res.status !== 401 && res.status !== 403) return 'allow';
      const code = (JSON.parse(await res.text()) as { code?: string }).code ?? '?';
      // A refusal by the row's own handler (demo_mode_off, code_invalid, credentials_invalid) passed authorization.
      return code === 'access_code_required' || code === 'unauthenticated' || code === 'forbidden' ? code : 'allow';
    },
    principal(who) {
      return {
        async caller(g) {
          const { k, cookies } = at(g);
          const headers = new Headers({ cookie: cookies.get(who.name)! });
          const entered = accessCookieValid(/bw_access=([^;]+)/.exec(cookies.get(who.name)!)?.[1], k.deps.accessKey, k.clock);
          return resolveCaller(k.sessions, k.clock, presentedToken(headers), !g.codeOn || entered);
        },
      };
    },
  };
}
