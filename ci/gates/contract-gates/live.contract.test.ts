// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: SD-4, SD-5 (contract-tests: every contract row against the Compose stack; the check fails a broken answer)
// contract-tests: every contract row's examples, run against the Compose stack named by BW_CONTRACT_BASE_URL.
// Today the stack serves only GET /healthz (API-171); the handler kernel (P2-KERNEL) adds the rest, and each row's
// examples then run here with no change to this file.
import { describe, expect, it } from 'vitest';
import { allContracts, checkAnswer, createClient, servedPath } from '../../../packages/api/src/index.ts';

const base = process.env.BW_CONTRACT_BASE_URL;
if (!base) throw new Error('BW_CONTRACT_BASE_URL is not set: contract-tests need a running Compose stack (run ci/gates/contract-gates.sh)');
const client = createClient({ baseUrl: base });

describe('contract-tests against the Compose stack', () => {
  for (const row of allContracts) {
    for (const ex of row.examples) {
      it(`${row.id} ${row.name}: ${ex.name}`, async () => {
        // why: SD-4 every contract row runs against the Compose stack at its default settings
        const answer = await client.raw(row, ex.input ?? {}, ex.headers ?? {});
        expect(answer.status, `${row.method} ${servedPath(row)}`).toBe(ex.expectStatus);
        expect(checkAnswer(row, answer)).toEqual([]);
      });
    }
  }

  it('fails the same check when the stack answer loses a field (the harness is not vacuous)', async () => {
    // why: SD-5 an answer that does not match its contract fails its contract test, on every run
    for (const row of allContracts) {
      const ex = row.examples[0];
      if (!ex) continue;
      const answer = await client.raw(row, ex.input ?? {}, ex.headers ?? {});
      if (typeof answer.body !== 'object' || answer.body === null) continue;
      const broken = Object.fromEntries(Object.entries(answer.body).slice(1));
      expect(checkAnswer(row, { status: answer.status, body: broken }).length, row.id).toBeGreaterThan(0);
    }
  });

  it('has at least 1 row to run', () => {
    // why: SD-4 a gate with nothing to run must not pass quietly
    expect(allContracts.length).toBeGreaterThan(0);
  });
});
