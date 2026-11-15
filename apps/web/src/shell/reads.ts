// SPDX-License-Identifier: AGPL-3.0-or-later
// The shell's reads (SPECIFICATIONS section 4.1: page code calls only @bw/api). Each read names its contract by ID and
// calls it through the typed client. A contract row that has not landed in @bw/api yet is "unavailable", never a
// stand-in answer: the component then shows its own failure state (UI-SPECIFICATION section 3). The rows the shell
// waits on, at P2-SHELL: API-02 (app info), API-07 (who am I), API-08 (save my settings), API-10 (the clock),
// API-43 (office alerts), API-130 (search), API-06 (sign out). When a row lands, its read works with no change here.
import { allContracts, ApiError, createClient, type ApiClient, type ContractRow } from '@bw/api';

export type ShellContractId = 'API-01' | 'API-02' | 'API-03' | 'API-04' | 'API-05' | 'API-06' | 'API-15' | 'API-07' | 'API-08' | 'API-10' | 'API-43' | 'API-130' | 'API-174' | 'API-176';

export type ReadResult<T> =
  | { ok: true; data: T }
  /** unavailable: no contract row in @bw/api yet. failed: the call answered a Problem or did not answer. */
  | { ok: false; reason: 'unavailable' | 'failed'; code?: string; status?: number };

export function findRow(id: ShellContractId, rows: readonly ContractRow[] = allContracts): ContractRow | undefined {
  return rows.find((r) => r.id === id);
}

export interface Reader {
  read<T>(id: ShellContractId, input?: Record<string, unknown>): Promise<ReadResult<T>>;
}

export function createReader(opts: { client?: ApiClient; baseUrl?: string; rows?: readonly ContractRow[] } = {}): Reader {
  const client = opts.client ?? createClient({ baseUrl: opts.baseUrl ?? '' });
  return {
    async read<T>(id: ShellContractId, input: Record<string, unknown> = {}): Promise<ReadResult<T>> {
      const row = findRow(id, opts.rows);
      if (!row) return { ok: false, reason: 'unavailable' };
      try {
        const answer = await client.call(row, input);
        return { ok: true, data: answer.data as T };
      } catch (e) {
        if (e instanceof ApiError) return { ok: false, reason: 'failed', code: e.problem.code, status: e.status };
        return { ok: false, reason: 'failed' };
      }
    },
  };
}
