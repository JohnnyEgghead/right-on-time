// SPDX-License-Identifier: AGPL-3.0-or-later
// API-105, the native app's server check (P6-NATIVE-SHELL; UI-SPECIFICATION 12.2 API-105, SCR-TEC-12 CTL-TEC-12-02; SPECIFICATIONS
// 6.12 FR-IOS-3): it names the product and its version, so the app stores an address only after it answers as Right On Time. It reads
// nothing and writes nothing: no session, no access code (BEFORE_ACCESS_CODE), and a re-run answers the same.
import { PRODUCT_NAME, PRODUCT_VERSION, type serverInfo } from '@bw/api';
import type { z } from 'zod';
import type { Handler } from '../types.ts';

export const serverInfoHandler: Handler<z.output<(typeof serverInfo)['response']>> = async () => ({
  ok: true,
  status: 200,
  data: { product: PRODUCT_NAME, version: PRODUCT_VERSION },
});
