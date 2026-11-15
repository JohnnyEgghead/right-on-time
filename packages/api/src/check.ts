// SPDX-License-Identifier: AGPL-3.0-or-later
// The contract-test check: does one answer match its row (envelope, labels, Problem shape, schema)?
// Returns a list of problems; empty means the answer conforms. Used by contract-tests against the stack
// and by the committed negative cases (an answer missing its envelope labels must fail).
import { allowedErrors, hasEnvelope, requiredLabels, type ContractRow } from './contract.ts';
import { envelopeSchema, problemConsistent, problemSchema } from './envelope.ts';
import { rowJsonSchema } from './export.ts';

export interface RawAnswer {
  status: number;
  body: unknown;
  /** The file name a file row's answer names in its content-disposition header (F-599); absent on any other answer. */
  fileName?: string;
}

const issues = (e: { issues: readonly { path: PropertyKey[]; message: string }[] }): string =>
  e.issues.map((i) => `${i.path.map(String).join('.') || '$'}: ${i.message}`).join('; ');

export function checkAnswer(row: ContractRow, answer: RawAnswer): string[] {
  const { status, body } = answer;
  const problems: string[] = [];
  if (status >= 400) {
    const p = problemSchema.safeParse(body);
    if (!p.success) return [`error answer is not a Problem: ${issues(p.error)}`];
    const bad = problemConsistent(p.data);
    if (bad) problems.push(bad);
    if (p.data.status !== status) problems.push(`Problem status ${p.data.status} differs from HTTP status ${status}`);
    if (!allowedErrors(row).has(p.data.code)) problems.push(`code ${p.data.code} is not one ${row.id} may answer`);
    // F-261: a code whose row names members carries them, in the row's shape.
    const detail = row.errorDetails?.[p.data.code];
    if (detail) {
      const d = detail.safeParse(body);
      if (!d.success) problems.push(`${p.data.code} does not carry its members: ${issues(d.error)}`);
    }
    return problems;
  }
  const ok = row.successStatus ?? [200];
  if (!ok.includes(status)) problems.push(`status ${status} is not one of ${ok.join(', ')}`);
  if (status === 204) {
    if (body !== undefined && body !== null && body !== '') problems.push('204 carries a body');
    return problems;
  }
  if (!hasEnvelope(row)) {
    const r = row.response.safeParse(body);
    if (!r.success) problems.push(`body does not match the response schema: ${issues(r.error)}`);
    return problems;
  }
  const env = envelopeSchema(row.response).safeParse(body);
  if (!env.success) return [...problems, `answer is not a valid envelope: ${issues(env.error)}`];
  const { meta } = env.data;
  if (meta.contract !== row.id) problems.push(`meta.contract ${meta.contract} is not ${row.id}`);
  for (const label of requiredLabels(row, rowJsonSchema(row.response, 'output'))) {
    if (!meta.labels.includes(label)) problems.push(`missing envelope label ${label}`);
  }
  return problems;
}
