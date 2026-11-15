// SPDX-License-Identifier: AGPL-3.0-or-later
// secret-scan (P7-SCANS; NFR-14; SPECIFICATIONS section 11.5): gitleaks 8.30.1 over the publish set that
// scripts/publish.sh --dry-run lists (the tree at a ref minus the private paths list, planning files removed, SD-40).
//   node ci/secret-scan/scan.ts run [--ref <tag|commit>] [--plant]   exit 0 only with 0 hits (and, with --plant, only if the planted secret was found)
//   node ci/secret-scan/scan.ts allowance                            the F-341 probes, on synthetic trees: exit 0 only if every one holds
//   node ci/secret-scan/scan.ts dir <path>                           an export already on disk (scripts/publish.sh prepare): exit 0 only with
//                                                                    0 hits, and only if a lock-file plant on a synthetic tree is found
// Also run by P8-PUBLISH's re-scan of the final publish set (ci/secret-scan/README.md): `run --ref <the release ref>`.
//
// F-1528: with the default rules on, gitleaks also skips files by its built-in path allowlist (lock files, gitleaks.toml, images,
// fonts), silently. scanTree finds those files with 1 trace run, and scans the text ones (no NUL byte in the first 8 KB) a second time
// as copies under neutral names, so a key pasted into pnpm-lock.yaml is a hit. A hit there names the real path.
//
// gitleaks dir takes ONE path per call (extra paths are silently ignored), so the scan is 1 call over the export root, with the export
// root as the working directory and `.` as the path: a hit's file is then the repo-relative path the allowlists' path patterns match.
// A hit is printed as file, line and rule only, never the matched text. Planted values are made at run time (never written in a file here),
// so this file itself carries no secret-shaped string.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isMain } from '../is-main.ts';
import { ensure } from '../gitleaks/install.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
export const CONFIG = path.join(import.meta.dirname, 'gitleaks.toml');
const LEAKS_EXIT = 7; // gitleaks's --exit-code when it finds a leak; any other nonzero is a failure to scan

export interface Hit {
  file: string;
  line: number;
  rule: string;
}

/** 1 gitleaks call over `dir` (cwd = dir, path `.`). Throws when gitleaks itself fails; returns the hits otherwise. */
export function scanDir(bin: string, dir: string, config = CONFIG): Hit[] {
  const report = path.join(mkdtempSync(path.join(tmpdir(), 'bw-secret-report-')), 'report.json');
  try {
    const r = spawnSync(bin, ['dir', '.', '--no-banner', '-f', 'json', '-r', report, '-c', config, '--exit-code', String(LEAKS_EXIT), '-l', 'error'], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0 && r.status !== LEAKS_EXIT) throw new Error(`gitleaks failed (exit ${r.status}): ${(r.stderr || '').trim().slice(0, 300)}`);
    const hits = JSON.parse(readFileSync(report, 'utf8') || '[]') as { File: string; StartLine: number; RuleID: string }[];
    if (r.status === LEAKS_EXIT && hits.length === 0) throw new Error('gitleaks exited with its leak code but wrote no hit');
    return hits.map((h) => ({ file: h.File, line: h.StartLine, rule: h.RuleID }));
  } finally {
    rmSync(path.dirname(report), { recursive: true, force: true });
  }
}

/** The paths a gitleaks trace run says it skipped by the global allowlist (F-1528). Repo-relative, as the trace prints them. */
export function parseSkipped(trace: string): string[] {
  const out: string[] = [];
  for (const line of trace.split('\n')) {
    const m = /skipping file: global allowlist path=(.*)$/.exec(line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd());
    if (m && m[1]) out.push(m[1]);
  }
  return out;
}

/** True when the first 8 KB of the file hold no NUL byte: the files the second pass reads (fonts and images are left out). */
export function isText(file: string): boolean {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return !buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

/** The files of `dir` that gitleaks's built-in path allowlist skips with this config (1 trace run). */
export function skippedByDefault(bin: string, dir: string, config = CONFIG): string[] {
  const r = spawnSync(bin, ['dir', '.', '--no-banner', '--no-color', '-c', config, '--exit-code', '0', '-l', 'trace'],{ cwd: dir, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gitleaks trace run failed (exit ${r.status}): ${(r.stderr || '').trim().slice(-300)}`);
  return parseSkipped(`${r.stdout}\n${r.stderr}`);
}

export interface TreeScan {
  hits: Hit[];
  skipped: string[];
  rescanned: string[];
}

/** The full scan of `dir` (F-1528): scanDir, then the skipped text files again as neutral copies, their hits named by the real path. */
export function scanTree(bin: string, dir: string, config = CONFIG): TreeScan {
  const hits = scanDir(bin, dir, config);
  const skipped = skippedByDefault(bin, dir, config);
  const rescanned = skipped.filter((f) => isText(path.join(dir, f)));
  if (rescanned.length === 0) return { hits, skipped, rescanned };
  const side = mkdtempSync(path.join(tmpdir(), 'bw-secret-f1528-'));
  try {
    rescanned.forEach((f, i) => copyFileSync(path.join(dir, f), path.join(side, `f1528-${i}.txt`)));
    for (const h of scanDir(bin, side, config)) {
      const m = /^f1528-(\d+)\.txt$/.exec(h.file);
      hits.push({ ...h, file: m ? rescanned[Number(m[1])]! : h.file });
    }
    return { hits, skipped, rescanned };
  } finally {
    rmSync(side, { recursive: true, force: true });
  }
}

const upper32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** A fresh planted AWS-shaped access key id (a made-up value, never a real credential; the shape the aws-access-token rule fires on). */
export function plantedSecret(): string {
  for (;;) {
    const tail = Array.from(randomBytes(16), (b) => upper32[b % 32]).join('');
    if (new Set(tail).size >= 9) return 'AKIA' + tail; // gitleaks's entropy floor for the rule
  }
}
/** A fresh high-entropy value shaped like a sample seed (base64url, 32 characters): what generic-api-key fires on after SAMPLE_PASSWORD_SEED=. */
export const sampleSeedShape = (): string => randomBytes(24).toString('base64url');

function exportSet(ref: string): { out: string; list: string; count: number } {
  const out = mkdtempSync(path.join(tmpdir(), 'bw-secret-set-'));
  const list = `${out}.list`;
  const r = spawnSync('bash', [path.join(root, 'scripts', 'publish.sh'), '--dry-run', '--ref', ref, '--out', out, '--list', list], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`publish.sh --dry-run failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return { out, list, count: readFileSync(list, 'utf8').split('\n').filter(Boolean).length };
}

const show = (hits: Hit[]): string => hits.map((h) => `  ${h.file}:${h.line} rule ${h.rule}`).join('\n');

async function run(ref: string, plant: boolean): Promise<number> {
  const bin = await ensure();
  const set = exportSet(ref);
  try {
    console.log(`secret-scan: gitleaks ${spawnSync(bin, ['version'], { encoding: 'utf8' }).stdout.trim()}, publish set of ${ref}: ${set.count} files (planning files removed)`);
    const { hits, skipped, rescanned } = scanTree(bin, set.out);
    console.log(`secret-scan: ${hits.length} hit(s) in the publish set (${skipped.length} file(s) skipped by the built-in allowlist, ${rescanned.length} text one(s) scanned again: ${rescanned.join(', ') || 'none'})`);
    if (hits.length) console.log(show(hits));
    let rc = hits.length === 0 ? 0 : 1;
    if (plant) {
      // The must-fail probes: the same export plus 1 planted file, and (F-1528) the same kind of key appended to the export's own
      // pnpm-lock.yaml, which the built-in allowlist skips. Each must be found, and found alone.
      mkdirSync(path.join(set.out, 'planted'), { recursive: true });
      writeFileSync(path.join(set.out, 'planted', 'secret-scan-plant.txt'), `aws_access_key_id = ${plantedSecret()}\n`);
      appendFileSync(path.join(set.out, 'pnpm-lock.yaml'), `# aws_access_key_id = ${plantedSecret()}\n`);
      const after = scanTree(bin, set.out).hits;
      for (const file of ['planted/secret-scan-plant.txt', 'pnpm-lock.yaml']) {
        const found = after.filter((h) => h.file === file && h.rule === 'aws-access-token');
        console.log(`secret-scan: planted test secret in ${file}: ${found.length ? 'FOUND (' + show(found).trim() + ')' : 'NOT FOUND'}`);
        if (found.length !== 1) rc = 1;
      }
      console.log(`secret-scan: ${after.length - hits.length - 2} unexpected other hit(s) after planting`);
      if (after.length !== hits.length + 2) rc = 1;
    }
    console.log(rc === 0 ? 'secret-scan: ok' : 'secret-scan: FAIL');
    return rc;
  } finally {
    rmSync(set.out, { recursive: true, force: true });
    rmSync(set.list, { force: true });
  }
}

/** `dir <path>`: an export already on disk (scripts/publish.sh prepare), then the lock-file plant on a synthetic tree. */
async function scanExport(dir: string): Promise<number> {
  const bin = await ensure();
  const { hits, skipped, rescanned } = scanTree(bin, dir);
  console.log(`secret-scan: ${hits.length} hit(s) in ${path.basename(dir)} (${skipped.length} file(s) skipped by the built-in allowlist, ${rescanned.length} text one(s) scanned again)`);
  if (hits.length) console.log(show(hits));
  const probe = mkdtempSync(path.join(tmpdir(), 'bw-secret-lockplant-'));
  let found = 0;
  try {
    writeFileSync(path.join(probe, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n# aws_access_key_id = ${plantedSecret()}\n`);
    found = scanTree(bin, probe).hits.filter((h) => h.file === 'pnpm-lock.yaml' && h.rule === 'aws-access-token').length;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  console.log(`secret-scan: lock-file plant on a synthetic tree: ${found === 1 ? 'FOUND' : 'NOT FOUND'}`);
  const rc = hits.length === 0 && found === 1 ? 0 : 1;
  console.log(rc === 0 ? 'secret-scan: ok' : 'secret-scan: FAIL');
  return rc;
}

/** The F-341 probes on synthetic trees. Returns the lines that failed (empty = all hold). */
export async function allowanceProbes(): Promise<{ lines: string[]; failed: string[] }> {
  const bin = await ensure();
  const lines: string[] = [];
  const failed: string[] = [];
  const probe = (name: string, files: Record<string, string>, want: (h: Hit[]) => boolean, expect: string, scan = (d: string): Hit[] => scanDir(bin, d)): void => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-secret-allow-'));
    try {
      for (const [f, body] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        writeFileSync(path.join(dir, f), body);
      }
      const hits = scan(dir);
      const ok = want(hits);
      lines.push(`allowance probe ${ok ? 'ok  ' : 'FAIL'} ${name}: ${hits.length} hit(s), expected ${expect}`);
      if (!ok) failed.push(name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const seedLine = `SAMPLE_PASSWORD_SEED=${sampleSeedShape()}\n`;
  const uuid = '0e8b5b5c-6c7d-4f1a-9b2c-3d4e5f607182';
  probe('seed-shaped value without the allowance path fires the rule (control)', { 'app.env': seedLine }, (h) => h.some((x) => x.rule === 'generic-api-key'), 'generic-api-key');
  probe('.env.example at the root: the published seed is allowed', { '.env.example': seedLine }, (h) => h.length === 0, '0');
  probe('same value in .env.sample: still a hit (allowance is by path)', { '.env.sample': seedLine }, (h) => h.length === 1 && h[0]!.rule === 'generic-api-key', '1 generic-api-key');
  probe('same value in a nested .env.example: still a hit (root file only)', { 'infra/.env.example': seedLine }, (h) => h.length === 1, '1');
  probe('a different rule inside .env.example: still a hit (allowance is by rule)', { '.env.example': seedLine + `AWS_KEY=${plantedSecret()}\n` }, (h) => h.length === 1 && h[0]!.rule === 'aws-access-token', '1 aws-access-token');
  probe('idempotency UUID in a test file: allowed', { 'x/a.test.ts': `const o = { key: '${uuid}' };\n` }, (h) => h.length === 0, '0');
  probe('a non-UUID high-entropy value in a test file: still a hit', { 'x/a.test.ts': `const o = { key: '${sampleSeedShape()}' };\n` }, (h) => h.some((x) => x.rule === 'generic-api-key'), 'generic-api-key');
  // F-1528: the built-in allowlist skips lock files by path; the first pass alone misses a key there (control), the full scan finds it.
  const lock = { 'pnpm-lock.yaml': `lockfileVersion: '9.0'\n# aws_access_key_id = ${plantedSecret()}\n` };
  probe('a key in pnpm-lock.yaml, first pass alone: skipped by the built-in allowlist (control)', lock, (h) => h.length === 0, '0');
  probe('a key in pnpm-lock.yaml, full scan: found under its real path', lock, (h) => h.length === 1 && h[0]!.file === 'pnpm-lock.yaml' && h[0]!.rule === 'aws-access-token', '1 aws-access-token in pnpm-lock.yaml', (d) => scanTree(bin, d).hits);
  return { lines, failed };
}

if (isMain(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'run') {
      const i = rest.indexOf('--ref');
      process.exit(await run(i >= 0 ? (rest[i + 1] ?? 'HEAD') : 'HEAD', rest.includes('--plant')));
    } else if (cmd === 'allowance') {
      const { lines, failed } = await allowanceProbes();
      console.log(lines.join('\n'));
      console.log(failed.length ? `secret-scan allowance: FAIL (${failed.length})` : 'secret-scan allowance: ok');
      process.exit(failed.length ? 1 : 0);
    } else if (cmd === 'dir' && rest[0]) {
      process.exit(await scanExport(path.resolve(rest[0])));
    } else {
      console.error('usage: node ci/secret-scan/scan.ts run [--ref <ref>] [--plant] | allowance | dir <path>');
      process.exit(2);
    }
  } catch (e) {
    console.error(`secret-scan: FAIL ${(e as Error).message}`);
    process.exit(1);
  }
}
