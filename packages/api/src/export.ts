// SPDX-License-Identifier: AGPL-3.0-or-later
// JSON Schema export of every contract row (Zod's z.toJSONSchema), the input of contract-diff.
import { z } from 'zod';
import { servedPath, type ContractRow } from './contract.ts';

export interface ExportedRow {
  method: string;
  path: string;
  envelope: boolean;
  request: unknown;
  response: unknown;
  errors: string[];
  labels: string[];
  /** The success statuses (F-127); a baseline written before this field reads as [200], the default. */
  successStatus?: number[];
}
export type ExportedContracts = Record<string, ExportedRow>;

export function rowJsonSchema(schema: z.ZodType, io: 'input' | 'output'): unknown {
  const out = z.toJSONSchema(schema, { io, unrepresentable: 'any', target: 'draft-2020-12' }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sortKeys(x)]));
  }
  return v;
}

/** Row id to exported schemas, keys sorted so the committed baseline is stable. */
export function exportContracts(rows: readonly ContractRow[]): ExportedContracts {
  const out: ExportedContracts = {};
  for (const row of rows) {
    if (Object.hasOwn(out, row.id)) throw new Error(`duplicate contract id ${row.id}`);
    out[row.id] = {
      method: row.method,
      path: servedPath(row),
      envelope: row.envelope !== false,
      request: rowJsonSchema(row.request, 'input'),
      response: rowJsonSchema(row.response, 'output'),
      successStatus: [...(row.successStatus ?? [200])].sort((a, b) => a - b),
      errors: [...row.errors].sort(),
      labels: [...row.labels].sort(),
    };
  }
  return sortKeys(out) as ExportedContracts;
}
