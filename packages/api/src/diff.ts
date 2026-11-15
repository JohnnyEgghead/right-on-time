// SPDX-License-Identifier: AGPL-3.0-or-later
// contract-diff (SPECIFICATIONS 7.1): compare the exported JSON Schema with the last release's. Within v1 changes are
// additive only, so a removed or changed field fails; a new row, a new response field or a new optional request field passes.
import type { ExportedContracts } from './export.ts';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const IGNORED = new Set(['description', 'title', 'examples', 'default', '$comment', 'id']);

export interface Breakage {
  contract: string;
  at: string;
  problem: string;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffNode(base: unknown, cur: unknown, at: string, side: 'request' | 'response', out: (at: string, problem: string) => void): void {
  if (!isObj(base) || !isObj(cur)) {
    if (!same(base, cur)) out(at, 'changed');
    return;
  }
  const baseProps = isObj(base.properties) ? base.properties : {};
  const curProps = isObj(cur.properties) ? cur.properties : {};
  for (const name of Object.keys(baseProps)) {
    if (!Object.hasOwn(curProps, name)) out(`${at}.${name}`, 'removed field');
    else diffNode(baseProps[name], curProps[name], `${at}.${name}`, side, out);
  }
  const baseReq = new Set(Array.isArray(base.required) ? (base.required as string[]) : []);
  const curReq = new Set(Array.isArray(cur.required) ? (cur.required as string[]) : []);
  for (const name of curReq) {
    if (baseReq.has(name)) continue;
    // A request field that became required breaks callers; so does an existing response field that became optional's inverse (kept simple: only requests).
    if (side === 'request') out(`${at}.${name}`, 'field became required');
  }
  if (side === 'response') {
    for (const name of baseReq) if (!curReq.has(name) && Object.hasOwn(curProps, name)) out(`${at}.${name}`, 'required field became optional');
  }
  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    const b = base[key];
    const c = cur[key];
    if (Array.isArray(b)) {
      if (!Array.isArray(c) || c.length < b.length) out(`${at}.${key}`, 'removed alternative');
      else b.forEach((x, i) => diffNode(x, c[i], `${at}.${key}[${i}]`, side, out));
    }
  }
  if (base.items !== undefined) {
    if (cur.items === undefined) out(`${at}.items`, 'removed items schema');
    else diffNode(base.items, cur.items, `${at}.items`, side, out);
  }
  if (isObj(base.additionalProperties) && cur.additionalProperties !== undefined) diffNode(base.additionalProperties, cur.additionalProperties, `${at}.*`, side, out);
  if (Array.isArray(base.enum)) {
    const curEnum = Array.isArray(cur.enum) ? cur.enum : [];
    for (const v of base.enum) if (!curEnum.some((x) => same(x, v))) out(at, `enum value ${JSON.stringify(v)} removed`);
  }
  const structural = new Set(['properties', 'required', 'anyOf', 'oneOf', 'allOf', 'prefixItems', 'items', 'additionalProperties', 'enum']);
  for (const key of Object.keys(base)) {
    if (structural.has(key) || IGNORED.has(key)) continue;
    if (!same(base[key], cur[key])) out(at, `keyword ${key} changed from ${JSON.stringify(base[key])} to ${JSON.stringify(cur[key])}`);
  }
  if (side === 'request') {
    // F-127: a constraint only the current request schema has (maxLength, pattern, format, minimum, const, an enum, a strict
    // object) rejects input the baseline accepted, so it breaks callers the way a removed field does.
    for (const key of Object.keys(cur)) {
      if (structural.has(key) || IGNORED.has(key) || Object.hasOwn(base, key)) continue;
      out(at, `keyword ${key} added: ${JSON.stringify(cur[key])}`);
    }
    if (base.enum === undefined && cur.enum !== undefined) out(at, 'keyword enum added');
    if (base.additionalProperties === undefined && cur.additionalProperties === false) out(at, 'keyword additionalProperties false added');
  }
}

export function diffContracts(baseline: ExportedContracts, current: ExportedContracts): Breakage[] {
  const found: Breakage[] = [];
  for (const [id, b] of Object.entries(baseline)) {
    const c = current[id];
    const add = (at: string, problem: string) => found.push({ contract: id, at, problem });
    if (!c) {
      add('$', 'contract removed');
      continue;
    }
    if (b.method !== c.method) add('method', `changed from ${b.method} to ${c.method}`);
    if (b.path !== c.path) add('path', `changed from ${b.path} to ${c.path}`);
    if (b.envelope !== c.envelope) add('envelope', 'changed');
    const baseStatus = JSON.stringify(b.successStatus ?? [200]);
    if (baseStatus !== JSON.stringify(c.successStatus ?? [200])) add('successStatus', `changed from ${baseStatus} to ${JSON.stringify(c.successStatus ?? [200])}`);
    for (const e of b.errors) if (!c.errors.includes(e)) add('errors', `code ${e} removed`);
    for (const l of b.labels) if (!c.labels.includes(l)) add('labels', `label ${l} removed`);
    diffNode(b.request, c.request, 'request', 'request', add);
    diffNode(b.response, c.response, 'response', 'response', add);
  }
  return found;
}

export function formatBreakage(list: readonly Breakage[]): string {
  return list.map((x) => `${x.contract} ${x.at}: ${x.problem}`).join('\n');
}
