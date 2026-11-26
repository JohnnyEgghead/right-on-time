// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract rows of the demo area. A new row is added here with defineContract (from ../contract.ts) and its examples;
// its handler and policy entry are in packages/api-server.
// API-10 is the read of the demo clock (CMP-01, CMP-02). The presets read (API-11) and the moves (API-12 jump, API-13 pause or resume, API-14 reset) are in ./clock.ts.
// API-09, the event stream, joins the table here (F-344).
import { z } from 'zod';
import { defineContract, type ContractRow } from '../contract.ts';
import { clockContracts } from './clock.ts';

/** An RFC 9557 time (UI-SPECIFICATION 12.1 item 5); Temporal parsing is @bw/time's concern. */
const wireTime = z.string().min(1);

export const readClock = defineContract({
  id: 'API-10',
  name: 'Read the clock',
  method: 'GET',
  path: '/clock',
  request: z.object({}),
  response: z.object({
    demoNow: wireTime,
    realNow: wireTime,
    rate: z.number().nonnegative(),
    paused: z.boolean(),
    worldEpoch: z.number().int(),
    lastMove: z.object({ by: z.string(), kind: z.enum(['jump', 'pause', 'resume', 'reset']), toDemo: wireTime }).nullable(),
    replay: z.object({ running: z.boolean(), done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
    resetAvailableInSeconds: z.number().int().nonnegative(),
  }),
  errors: [],
  labels: [],
  // The default stack holds no clock row until setup writes epoch 1 (P2-SEED): the read answers server_error until then.
  examples: [{ name: 'before setup: no clock row', expectStatus: 500 }],
});

/**
 * API-09, the event stream (SPECIFICATIONS 4.3, 7.3; UI-SPECIFICATION 12.2 and 12.3): server-sent events of section 12.3,
 * ids only, filtered by the caller's branch (?branch) and role. A stream row (contract.ts stream): no envelope, and the
 * kernel answers the handler's stream body as text/event-stream. Its access comes from the policy table (F-344): every
 * signed-in role, after the access code; the stream closes on unauthenticated.
 */
export const eventStreamRow = defineContract({
  id: 'API-09',
  name: 'Event stream',
  method: 'GET',
  path: '/events',
  request: z.object({ branch: z.string().min(1).optional() }),
  // The stream body itself (a ReadableStream of the SSE text), never JSON.
  response: z.custom<ReadableStream<Uint8Array>>((v) => v instanceof ReadableStream),
  successStatus: [200],
  errors: [],
  labels: [],
  envelope: false,
  stream: true,
  examples: [{ name: 'no session', expectStatus: 401 }],
});

// P3-REPLAY: the clock moves API-11 to API-14 live in ./clock.ts (that lane's file) and join the demo area here.
export const demoContracts: ContractRow[] = [eventStreamRow, readClock, ...clockContracts];
