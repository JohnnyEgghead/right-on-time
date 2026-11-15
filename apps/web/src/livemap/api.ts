// SPDX-License-Identifier: AGPL-3.0-or-later
// The live map's 1 call (SPECIFICATIONS section 4.1: page code calls only @bw/api): API-116 through its contract row. A Problem answer comes
// back as { ok: false } with its status and members (the 410's reason, visit facts and office phone). Every read is sent with
// `cache: 'no-store'`, so a phone never answers the page from what it kept (FR-TEXT-4).
import { ApiError, createClient, liveMapData, type ApiClient } from '@bw/api';
import type { ReadOutcome } from './model.ts';

export interface LiveMapApi {
  read(token: string): Promise<ReadOutcome>;
}

export function liveMapApi(client: ApiClient = createClient({ baseUrl: '', fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }) })): LiveMapApi {
  return {
    async read(token) {
      try {
        const r = await client.call(liveMapData, { liveMapToken: token });
        return { ok: true, data: r.data, now: r.envelope?.meta.demoNow ?? '' };
      } catch (e) {
        if (e instanceof ApiError) {
          const { code, status, ...rest } = e.problem as unknown as { code: string; status: number } & Record<string, unknown>;
          return { ok: false, code, status: e.status ?? status, detail: rest };
        }
        return { ok: false, code: 'offline', status: 0, detail: {} };
      }
    },
  };
}
