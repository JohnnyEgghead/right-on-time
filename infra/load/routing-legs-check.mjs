// SPDX-License-Identifier: AGPL-3.0-or-later
// P6-ROUTING-MEMORY (OQ-42; F-1327): the set check of a route burst against the leg list it was judged against. Reads the leg list (the
// committed .build/evidence/W36-ROUTING-LEGS/legs.json.gz, or a plain legs.json) and each burst file (infra/load/route-burst.mjs output,
// plain or gzipped), and prints 1 JSON object: the list's SHA-256 (of its JSON bytes, as route-burst.mjs hashes /burst/legs.json) and its
// gzip file's, its key count, and per burst: the routed legs' keys (branch, fromRef, toRef) equal the list's keys (same set, no repeat),
// and the SHA-256 the burst file carries (bursts made before F-1327 carry none: null). Exits 1 when any burst's set differs, or a burst
// that carries a SHA-256 names another list.
//   node infra/load/routing-legs-check.mjs <legs list> <burst file> [<burst file> ...] > <check.json>
// Kept as evidence, nothing calls it: its output is cited in the measured record that set the routing service's memory limit, as proof that each route burst asked for the same legs.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const [listFile, ...bursts] = process.argv.slice(2);
if (!listFile || bursts.length === 0) throw new Error('usage: routing-legs-check.mjs <legs list> <burst file>...');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const bytesOf = (f) => {
  const raw = readFileSync(f);
  return { raw, json: f.endsWith('.gz') ? gunzipSync(raw) : raw };
};
const key = (l) => `${l.branch}|${l.fromRef}|${l.toRef}`;

const list = bytesOf(listFile);
const listSha256 = sha(list.json);
const keys = JSON.parse(list.json.toString('utf8')).map(key);
const listKeys = new Set(keys);
let ok = keys.length === listKeys.size;

const checks = bursts.map((f) => {
  const b = JSON.parse(bytesOf(f).json.toString('utf8'));
  const routed = b.results.filter((r) => r.ok).map(key);
  const routedKeys = new Set(routed);
  const missing = [...listKeys].filter((k) => !routedKeys.has(k));
  const extra = [...routedKeys].filter((k) => !listKeys.has(k));
  const setEqual = routed.length === routedKeys.size && missing.length === 0 && extra.length === 0;
  const carried = b.legsSha256 ?? null;
  const shaMatches = carried === null ? null : carried === listSha256;
  if (!setEqual || shaMatches === false) ok = false;
  return { file: f, legs: b.legs, routed: routed.length, setEqual, missing: missing.slice(0, 5), extra: extra.slice(0, 5), legsSha256: carried, shaMatches };
});

console.log(JSON.stringify({
  task: 'P6-ROUTING-MEMORY', finding: 'F-1327', list: listFile, listSha256, listFileSha256: list.raw === list.json ? null : sha(list.raw),
  listKeys: listKeys.size, listKeysUnique: keys.length === listKeys.size, ok, bursts: checks,
}, null, 1));
process.exit(ok ? 0 : 1);
