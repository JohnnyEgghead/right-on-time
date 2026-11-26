// SPDX-License-Identifier: AGPL-3.0-or-later
// The text gateway seam (SPECIFICATIONS section 4.4, SD-48) and its only implementation, the text simulator
// (FR-TEXT-16, SD-44, D8; a real provider is out of scope, OOS-01). Every text leaves through the try handler's call of
// TextGateway.send; nothing else writes an `out` inbox row.
import type { Queryable } from '@bw/db';
import type { Instant } from '@bw/time';

export interface TextGateway {
  send(msg: { textId: string; customerId: string; body: string; encoding: 'gsm7' | 'ucs2' }):
    Promise<{ result: 'delivered' } | { result: 'failed'; reason: string }>;
}

/** The values of text_simulator.mode, the modes a manager sets on the System health page: up, every send fails, sends to 1 customer fail, the next N sends fail (FR-TEXT-16). */
export const SIMULATOR_MODES = ['up', 'all_fail', 'fail_customer', 'fail_next_n'] as const;
export type SimulatorMode = (typeof SIMULATOR_MODES)[number];

/** The failure reasons the simulator gives, 1 per failing mode (text_attempt.reason). */
export const SIMULATOR_REASON = {
  all_fail: 'simulator_all_fail',
  fail_customer: 'simulator_fail_customer',
  fail_next_n: 'simulator_fail_next_n',
} as const;

export interface SimulatorRow {
  mode: SimulatorMode;
  customer_id: string | null;
  n_left: number | null;
}

/** What the simulator does with 1 send under `row` (null: no row yet, which is the seed's `up`). */
export function simulatorVerdict(row: SimulatorRow | null, customerId: string): { fail: false } | { fail: true; reason: string } {
  if (!row || row.mode === 'up') return { fail: false };
  if (row.mode === 'all_fail') return { fail: true, reason: SIMULATOR_REASON.all_fail };
  if (row.mode === 'fail_customer') return row.customer_id === customerId ? { fail: true, reason: SIMULATOR_REASON.fail_customer } : { fail: false };
  return (row.n_left ?? 0) > 0 ? { fail: true, reason: SIMULATOR_REASON.fail_next_n } : { fail: false };
}

/**
 * The simulator gateway for 1 send in the try's transaction `tx` at demo time `at`. It reads the 1 simulator row under
 * a row lock (so 2 concurrent sends in "Fail the next N" count down N exactly), applies the mode, counts a failure of
 * "Fail the next N" down (at 0 the mode is back to up), and on delivery writes the `out` inbox row in the same
 * transaction (section 4.4): the send and its inbox row commit or roll back together.
 */
export class SimulatorGateway implements TextGateway {
  readonly #tx: Queryable;
  readonly #at: Instant;

  constructor(tx: Queryable, at: Instant) {
    this.#tx = tx;
    this.#at = at;
  }

  async send(msg: { textId: string; customerId: string; body: string; encoding: 'gsm7' | 'ucs2' }): Promise<{ result: 'delivered' } | { result: 'failed'; reason: string }> {
    const { rows } = await this.#tx.query<SimulatorRow>(`SELECT mode, customer_id, n_left FROM world.text_simulator FOR UPDATE`);
    const verdict = simulatorVerdict(rows[0] ?? null, msg.customerId);
    if (verdict.fail) {
      if (rows[0]?.mode === 'fail_next_n') {
        await this.#tx.query(
          `UPDATE world.text_simulator
              SET n_left = CASE WHEN n_left > 1 THEN n_left - 1 ELSE NULL END,
                  mode = CASE WHEN n_left > 1 THEN mode ELSE 'up' END`,
        );
      }
      return { result: 'failed', reason: verdict.reason };
    }
    await this.#tx.query(
      `INSERT INTO world.inbox_message (customer_id, direction, text_id, body, at) VALUES ($1, 'out', $2, $3, $4)`,
      [msg.customerId, msg.textId, msg.body, this.#at.toString()],
    );
    return { result: 'delivered' };
  }
}

/** A gateway for 1 send: built per try, inside that try's transaction. */
export type GatewayFactory = (tx: Queryable, at: Instant) => TextGateway;

/**
 * The worker composes its gateway at start-up (section 4.4). No setting selects anything but the simulator (OOS-01),
 * so there is nothing to read; a real provider would add its setting here.
 */
export function textGatewayFrom(): GatewayFactory {
  return (tx, at) => new SimulatorGateway(tx, at);
}
