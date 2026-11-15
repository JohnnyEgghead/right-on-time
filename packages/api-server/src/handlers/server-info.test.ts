// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-IOS-3
// API-105 through the real kernel entry (router.handle), the real policy table and the real handlers: the native app's server check
// answers a fresh install that has no session and no access code (SCR-TEC-12, CTL-TEC-12-02; SPECIFICATIONS 6.12).
import { PRODUCT_NAME, PRODUCT_VERSION, serverInfo } from '@bw/api';
import { describe, expect, it } from 'vitest';
import { handlers } from './index.ts';
import { policyTable } from '../policy.ts';
import { kit } from '../testing.ts';

describe('API-105 server check', () => {
  // why: FR-IOS-3 the app stores an address only after it answers as Right On Time; a fresh install has no session and no code
  it('names the product and its version with no session, even when the access code is on', async () => {
    const k = kit(policyTable, { ...handlers }, { ACCESS_CODE_ON: true });
    const r = await k.call('GET', '/api/v1/server-info');
    expect(r.status).toBe(200);
    const body = JSON.parse(await r.text()) as { data: unknown };
    expect(serverInfo.response.parse(body.data)).toEqual({ product: PRODUCT_NAME, version: PRODUCT_VERSION });
    expect(PRODUCT_NAME).toBe('Right On Time');
  });

  // why: FR-IOS-3 the check is the 1 call of SCR-TEC-12, a read: it refuses a write method
  it('serves a GET only: a write to the path is no route', async () => {
    const k = kit(policyTable, { ...handlers }, { ACCESS_CODE_ON: true });
    expect((await k.call('POST', '/api/v1/server-info')).status).toBe(404);
  });
});
