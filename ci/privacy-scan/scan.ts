// SPDX-License-Identifier: AGPL-3.0-or-later
// The privacy scan (P7-SCANS; SPECIFICATIONS section 11.4, invariant 6, NFR-05; gate G-CI6, inv6-no-pii-in-links-logs).
//   node ci/privacy-scan/scan.ts scan --dir <collected dir> [--require a,b,c]
// ci/e2e-stack.sh collects the input after the full P7-E2E run (BW_E2E_PRIVACY_SCAN=1), before it tears the stack down:
//   <dir>/logs/<name>.log   the log of every container the run made (every service, the migrate and setup runs), 1 file each
//   <dir>/customers.tsv     every customer in the database: mobile, home phone, street name, house number (tab separated)
//   <dir>/links.tsv         every issued link: kind (token | target | text), value (tab separated)
// It searches every log line and every issued link for every customer phone (digits only, with and without the area code, however
// punctuated) and every address (house number followed by street name, case, spacing, punctuation and URL escapes ignored), and exits 0
// only with 0 hits. A hit is printed as file, line, kind and the customer's row number: never the matched value, so this output holds
// no customer data. Each run also proves its own scanner on a planted line (the run's positive control, SPECIFICATIONS 11.4: "a planted
// test log line with a known customer phone must be found"): 1 line holding a customer's phone, and 1 holding an address, appended to
// a copy of a log, must each be found at that line and nowhere else.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isMain } from '../is-main.ts';

export interface Customer {
  mobile: string;
  homePhone: string;
  street: string;
  house: string;
}
export interface Hit {
  file: string;
  line: number;
  kind: 'phone' | 'address';
  customer: number; // the customer's row number in customers.tsv (1-based), never a value
}

/** The link prefixes of SPECIFICATIONS section 11.4 ("every token segment of ... is replaced by :token"); a token is rendered under each. */
export const LINK_PREFIXES = ['/m/', '/r/', '/inbox/', '/email/', '/set-password/', '/book/done/', '/api/v1/emails/', '/api/v1/password-tokens/'];

const digitsOf = (s: string): string => s.replace(/\D/g, '');
/** A phone's matchable forms: the 10 digits, and the 7 digits without the area code. A value with under 7 digits has none. */
export function phoneForms(raw: string): { full: string | null; local: string | null } {
  let d = digitsOf(raw);
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length < 7) return { full: null, local: null };
  return { full: d.length >= 10 ? d.slice(-10) : null, local: d.slice(-7) };
}

/** Lower case, URL escapes decoded, every run of non-letters-and-digits made 1 space: "123%20Oak-Ridge, Dr." and "123 oak ridge dr" agree. */
export function norm(s: string): string {
  let t = s;
  try {
    t = decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    t = s.replace(/%20/gi, ' ').replace(/\+/g, ' ');
  }
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export interface Matcher {
  customers: number;
  /** The customer row numbers whose phone or address is in the line (phones first), as {kind, customer}. */
  find(line: string): { kind: 'phone' | 'address'; customer: number }[];
}

export function buildMatcher(customers: Customer[]): Matcher {
  const full = new Map<string, number>();
  const local = new Map<string, number>();
  const streets = new Map<string, Map<string, number>>(); // normalized street name -> house number -> customer row
  customers.forEach((c, i) => {
    const row = i + 1;
    for (const p of [c.mobile, c.homePhone]) {
      const f = phoneForms(p);
      if (f.full && !full.has(f.full)) full.set(f.full, row);
      if (f.local && !local.has(f.local)) local.set(f.local, row);
    }
    const s = norm(c.street);
    if (s && c.house) {
      const m = streets.get(s) ?? new Map<string, number>();
      if (!m.has(c.house)) m.set(c.house, row);
      streets.set(s, m);
    }
  });
  return {
    customers: customers.length,
    find(line: string) {
      const out: { kind: 'phone' | 'address'; customer: number }[] = [];
      // Phones: the digit groups of the line, joined across 1 to 3 separator characters (space, hyphen, dot, parentheses, plus), in windows of 1 to 4 groups.
      const decoded = unescapeUrl(line);
      for (const text of decoded === line ? [line] : [line, decoded]) phonesIn(text, out);
      return dedupe(out.concat(addressesIn(line)));
    },
  };
  function phonesIn(line: string, out: { kind: 'phone' | 'address'; customer: number }[]): void {
    const groups: { d: string; start: number; end: number }[] = [];
    for (const m of line.matchAll(/\d+/g)) groups.push({ d: m[0], start: m.index!, end: m.index! + m[0].length });
    for (let i = 0; i < groups.length; i++) {
      let joined = '';
      for (let j = i; j < Math.min(groups.length, i + 4); j++) {
        if (j > i && !/^[\s().+\-]{1,3}$/.test(line.slice(groups[j - 1]!.end, groups[j]!.start))) break;
        joined += groups[j]!.d;
        if (joined.length === 7 && local.has(joined)) out.push({ kind: 'phone', customer: local.get(joined)! });
        // 10 or more digits: the 10-digit number anywhere inside (a country code, or digits run on), compared whole so a 7-digit slice of a long number is not a hit
        for (let k = 0; joined.length >= 10 && k + 10 <= joined.length; k++) {
          const sub = joined.slice(k, k + 10);
          if (full.has(sub)) out.push({ kind: 'phone', customer: full.get(sub)! });
        }
      }
    }
  }
  // Addresses: the house number, then the street name, in the normalized line.
  function addressesIn(line: string): { kind: 'phone' | 'address'; customer: number }[] {
    const out: { kind: 'phone' | 'address'; customer: number }[] = [];
    if (!/\d/.test(line) || !streets.size) return out;
    const n = ' ' + norm(line) + ' ';
    for (const [street, houses] of streets) {
      let at = n.indexOf(' ' + street + ' ');
      while (at !== -1) {
        const before = n.slice(0, at).match(/ (\d{1,6})$/);
        if (before && houses.has(before[1]!)) out.push({ kind: 'address', customer: houses.get(before[1]!)! });
        at = n.indexOf(' ' + street + ' ', at + 1);
      }
    }
    return out;
  }
}

function unescapeUrl(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\+/g, ' ');
  }
}
function dedupe<T extends { kind: string; customer: number }>(a: T[]): T[] {
  const seen = new Set<string>();
  return a.filter((x) => (seen.has(`${x.kind}:${x.customer}`) ? false : (seen.add(`${x.kind}:${x.customer}`), true)));
}

const parseTsv = (text: string): string[][] => text.split('\n').filter((l) => l.length).map((l) => l.split('\t'));

function readCustomers(file: string): Customer[] {
  return parseTsv(readFileSync(file, 'utf8')).map(([mobile = '', homePhone = '', street = '', house = '']) => ({ mobile, homePhone, street, house }));
}

/** The issued links: every token under every section 11.4 prefix, every alert link target, and every URL or path link found in a text body. */
export function readLinks(file: string): string[] {
  const out: string[] = [];
  for (const [kind, value = ''] of parseTsv(readFileSync(file, 'utf8'))) {
    if (!value) continue;
    if (kind === 'token') for (const p of LINK_PREFIXES) out.push(p + value);
    else if (kind === 'target') out.push(value);
    else if (kind === 'text') {
      for (const m of value.matchAll(/(?:https?:\/\/[^\s"'<>]+|\/(?:m|r|inbox|email|set-password|book\/done|api\/v1\/emails|api\/v1\/password-tokens)\/[^\s"'<>]+)/g)) out.push(m[0]);
    }
  }
  return out;
}

export interface Population {
  logFiles: { name: string; lines: number }[];
  links: number;
  customers: number;
}

export function scanDir(dir: string, matcher: Matcher): { hits: Hit[]; population: Population } {
  const hits: Hit[] = [];
  const logsDir = path.join(dir, 'logs');
  const logFiles: { name: string; lines: number }[] = [];
  for (const f of existsSync(logsDir) ? readdirSync(logsDir).sort() : []) {
    const lines = readFileSync(path.join(logsDir, f), 'utf8').split('\n');
    logFiles.push({ name: f, lines: lines.filter(Boolean).length });
    lines.forEach((l, i) => {
      for (const m of matcher.find(l)) hits.push({ file: `logs/${f}`, line: i + 1, ...m });
    });
  }
  const links = readLinks(path.join(dir, 'links.tsv'));
  links.forEach((l, i) => {
    for (const m of matcher.find(l)) hits.push({ file: 'links.tsv', line: i + 1, ...m });
  });
  return { hits, population: { logFiles, links: links.length, customers: matcher.customers } };
}

const DEFAULT_REQUIRE = ['proxy', 'web', 'worker', 'pbs', 'db', 'routing', 'setup'];

/** The scan proper plus the positive control. Returns the exit code and the lines to print. */
export function run(dir: string, require: string[] = DEFAULT_REQUIRE): { rc: number; out: string[] } {
  const out: string[] = [];
  let rc = 0;
  const customers = readCustomers(path.join(dir, 'customers.tsv')).filter((c) => phoneForms(c.mobile).local || phoneForms(c.homePhone).local || (c.street && c.house));
  const matcher = buildMatcher(customers);
  const { hits, population } = scanDir(dir, matcher);
  out.push(`privacy-scan: population: ${population.customers} customers, ${population.logFiles.length} log files (${population.logFiles.map((f) => `${f.name} ${f.lines}`).join(', ')}), ${population.links} issued links`);
  // An empty population is a false pass: the database must hold customers, every named log must exist and hold lines, and links must exist.
  if (population.customers < 1) { out.push('privacy-scan: FAIL no customer in the database input'); rc = 1; }
  for (const r of require) {
    const f = population.logFiles.find((x) => x.name === `${r}.log`);
    if (!f || f.lines < 1) { out.push(`privacy-scan: FAIL log ${r}.log is missing or empty`); rc = 1; }
  }
  if (population.links < 1) { out.push('privacy-scan: FAIL no issued link in the input'); rc = 1; }
  out.push(`privacy-scan: ${hits.length} hit(s) in the logs and links`);
  for (const h of hits) out.push(`  ${h.file}:${h.line} ${h.kind} (customer row ${h.customer})`);
  if (hits.length) rc = 1;

  // The positive control: a copy of the input, 1 planted phone line and 1 planted address line appended to the web log, each must be found at its line.
  const withPhone = customers.findIndex((c) => phoneForms(c.mobile).full);
  const withAddr = customers.findIndex((c) => c.street && c.house);
  if (withPhone < 0 || withAddr < 0) { out.push('privacy-scan: FAIL no customer to plant (no phone or no address)'); return { rc: 1, out }; }
  const copy = mkdtempSync(path.join(tmpdir(), 'bw-privacy-plant-'));
  try {
    cpSync(dir, copy, { recursive: true });
    mkdirSync(path.join(copy, 'logs'), { recursive: true });
    const log = path.join(copy, 'logs', 'web.log');
    let body = existsSync(log) ? readFileSync(log, 'utf8') : '';
    if (body && !body.endsWith('\n')) body += '\n';
    const n0 = body ? body.split('\n').length - 1 : 0;
    const d = digitsOf(customers[withPhone]!.mobile).slice(-10);
    const a = customers[withAddr]!;
    const planted = [
      `{"level":"info","msg":"planted test log line phone ${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}"}`,
      `{"level":"info","msg":"planted test log line phone without area code ${d.slice(3, 6)}${d.slice(6)}"}`,
      `{"level":"info","msg":"planted test log line address ${a.house} ${a.street}"}`,
    ];
    writeFileSync(log, body + planted.join('\n') + '\n');
    const after = scanDir(copy, matcher).hits.filter((h) => h.file === 'logs/web.log' && h.line > n0);
    const at = (i: number, kind: string): boolean => after.some((h) => h.line === n0 + i && h.kind === kind);
    const f = [at(1, 'phone'), at(2, 'phone'), at(3, 'address')];
    out.push(`privacy-scan: planted log lines at web.log:${n0 + 1}-${n0 + 3}: phone with area code ${f[0] ? 'FOUND' : 'NOT FOUND'}, phone without area code ${f[1] ? 'FOUND' : 'NOT FOUND'}, address ${f[2] ? 'FOUND' : 'NOT FOUND'}`);
    if (!f.every(Boolean)) rc = 1;
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
  out.push(rc === 0 ? 'privacy-scan: ok' : 'privacy-scan: FAIL');
  return { rc, out };
}

if (isMain(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const val = (f: string): string | undefined => (rest.indexOf(f) >= 0 ? rest[rest.indexOf(f) + 1] : undefined);
  if (cmd !== 'scan' || !val('--dir')) {
    console.error('usage: node ci/privacy-scan/scan.ts scan --dir <collected dir> [--require a,b,c]');
    process.exit(2);
  }
  try {
    const req = val('--require');
    const r = run(path.resolve(val('--dir')!), req === undefined ? DEFAULT_REQUIRE : req.split(',').filter(Boolean));
    console.log(r.out.join('\n'));
    process.exit(r.rc);
  } catch (e) {
    console.error(`privacy-scan: FAIL ${(e as Error).message}`);
    process.exit(1);
  }
}
