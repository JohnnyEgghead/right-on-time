// SPDX-License-Identifier: AGPL-3.0-or-later
// P6-ROUTING-MEMORY (OQ-42; F-1326): the CPU columns of the temporary server's vmstat files (infra/load/temp-server.sh collect writes
// server-vmstat.log: `vmstat -t 5`), averaged per file. Columns are read by the header's names (us sy id wa st), never by position, so
// idle and steal cannot swap. Every data line counts, the first (vmstat's average since boot) included, as review 556 read them.
//   node infra/load/routing-memory-vmstat.mjs <server-vmstat.log> [...] > <vmstat.json>
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('usage: routing-memory-vmstat.mjs <server-vmstat.log>...');
const round = (n) => Math.round(n * 10) / 10;
const perFile = files.map((file) => {
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/));
  const header = lines.find((w) => w.includes('us') && w.includes('id') && w.includes('st'));
  if (!header) throw new Error(`${file}: no vmstat header`);
  const col = Object.fromEntries(['us', 'sy', 'id', 'wa', 'st'].map((c) => [c, header.indexOf(c)]));
  const rows = lines.filter((w) => /^[0-9]+$/.test(w[0] ?? '') && w.length >= header.length);
  const avg = (c) => round(rows.reduce((a, w) => a + Number(w[col[c]]), 0) / rows.length);
  const max = (c) => Math.max(...rows.map((w) => Number(w[col[c]])));
  return { file, samples: rows.length, avg: { us: avg('us'), sy: avg('sy'), id: avg('id'), wa: avg('wa'), st: avg('st') }, max: { st: max('st'), wa: max('wa') }, min: { id: Math.min(...rows.map((w) => Number(w[col.id]))) } };
});
const spread = (pick) => ({ min: Math.min(...perFile.map(pick)), max: Math.max(...perFile.map(pick)) });
console.log(JSON.stringify({ task: 'P6-ROUTING-MEMORY', finding: 'F-1326', idleAvg: spread((f) => f.avg.id), stealAvg: spread((f) => f.avg.st), perFile }, null, 1));
