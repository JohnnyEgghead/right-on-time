// SPDX-License-Identifier: AGPL-3.0-or-later
// public-files-check (P8-PUBLIC-FILES; SPECIFICATIONS section 6.13: FR-DIST-2, FR-DIST-4, FR-DIST-5, FR-DIST-7):
//   node ci/public-files.ts [spdx|readme|copying|files|private-refs|ipv4|owner-ids|fonts|css|workflows|changelog|engines|domain|spike|all] [--root <dir>] [--floor <n>] [--owner-env <file>]... [--export]
//   (--floor: the source file floor of spdx, default MIN_SOURCE_FILES; --owner-env: the owner files owner-ids reads, default defaultOwnerFiles;
//   --export: the tree is an export, so a private path in it fails as export-private instead of being left out; F-1682)
//   spdx      spdx-header-check: every source file of the public tree has the SPDX line AGPL-3.0-or-later, and LICENSE is the AGPL-3.0 text
//   readme    readme-items: the README has each item of FR-DIST-7 and the reset protection setting beside demo mode (OI-29)
//   copying   copying-ios-present: COPYING.iOS exists and holds the section 7 App Store permission
//   files     LICENSE-DATA.md (ODbL and the OpenStreetMap credit), .env.example (a SAMPLE_PASSWORD_SEED of 16+ characters) and
//             THIRD-PARTY-NOTICES.md (F-248: every credit ci/license/policy.json records, word for word)
//   private-refs  no exported file names a private path (F-1571); ipv4  no exported file holds a real IPv4 address (F-1609)
//   owner-ids no exported file holds the owner's Apple team id or App Store Connect key id, read from the owner's private file (F-1621)
//   fonts     fonts-licensed: every shipped font folder holds a license file (K-12)
//   css       css-covered: every .css file has an SPDX line or a REUSE.toml annotation that covers it (K-13, F-2025)
//   workflows persist-credentials: every checkout in the private tree's .github/workflows/ sets persist-credentials: false (K-15)
//   changelog the export holds CHANGELOG.md (K-21)
//   engines   engines.node in package.json is the major of .node-version (J-31)
//   domain    no shipped file names brightwaterair.com (J-32)
//   spike     the export holds no infra/spike/, and scripts/private-paths.txt lists it (J-35)
//   all       every check above (the default)
// Exit 0: every check passed. Exit 1: a check failed (the problems are named on stderr). Exit 2: usage error.
// The public tree is the files git knows (tracked, or new and not ignored) minus scripts/private-paths.txt, the list scripts/publish.sh uses.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';
import { isMain } from './is-main.ts';

export interface Problem {
  check: string;
  message: string;
}

/** The suffixes of a source file, and the line comment each one uses. Style, markup, data and config files are not source files here. */
const COMMENT: Record<string, string> = {
  '.ts': '//', '.tsx': '//', '.mts': '//', '.cts': '//', '.mjs': '//', '.cjs': '//', '.js': '//', '.jsx': '//', '.swift': '//',
  '.sh': '#', '.py': '#', '.rb': '#',
  '.sql': '--',
};

/**
 * Source files that carry no header, with the reason. Each is covered by REUSE.toml, which the check requires to name it.
 * packages/db/migrations/: the migration runner stores the SHA-256 of each file and refuses a changed one (packages/db/src/migrate.ts), so a header would break every database already migrated.
 */
export const EXEMPT: readonly { prefix: string; reason: string }[] = [
  { prefix: 'packages/db/migrations/', reason: 'checksum-pinned migrations (migrate.ts); covered by REUSE.toml' },
];

/** F-1576: the fewest source files the header check must find (1573 on the F-1576 census). A dropped suffix or a wider exempt prefix that shrinks the population below this fails. */
export const MIN_SOURCE_FILES = 1500;

export const SPDX_LINE = /SPDX-License-Identifier:\s*AGPL-3\.0-or-later\s*$/;

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

interface Rules {
  dirs: string[];
  files: string[];
  anyDepth: string[];
  globs: RegExp[];
}

/** scripts/private-paths.txt, read the way scripts/publish.sh reads it. */
export function readPrivateRules(root: string): Rules {
  const rules: Rules = { dirs: [], files: [], anyDepth: [], globs: [] };
  for (const line of readFileSync(path.join(root, 'scripts', 'private-paths.txt'), 'utf8').split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('**/')) rules.anyDepth.push(line.slice(3));
    // F-1683: as publish.sh's guard, a glob names a file or a folder: the path itself or anything under it (a trailing / names folders only).
    else if (line.includes('*')) {
      const re = line.replace(/\/$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
      rules.globs.push(new RegExp(line.endsWith('/') ? `^${re}/` : `^${re}(/|$)`));
    }
    else if (line.endsWith('/')) rules.dirs.push(line);
    else rules.files.push(line);
  }
  return rules;
}

export function isPrivate(rel: string, rules: Rules): boolean {
  return (
    rules.dirs.some((d) => rel.startsWith(d)) ||
    rules.files.includes(rel) ||
    rules.globs.some((g) => g.test(rel)) ||
    rules.anyDepth.some((n) => rel.split('/').includes(n))
  );
}

function listTreeFiles(root: string): string[] {
  return git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z')
    .split('\0')
    .filter((f) => f !== '' && existsSync(path.join(root, f)))
    .sort();
}

/** Every file of the public tree: tracked or new-and-not-ignored, minus the private paths. */
export function listPublicFiles(root: string): string[] {
  const rules = readPrivateRules(root);
  return listTreeFiles(root).filter((f) => !isPrivate(f, rules));
}

/**
 * F-1682 (--export): the tree checked is an export, a public commit (scripts/publish.sh prepare checks its candidate this way), not
 * this checkout: a private path in it is an error, never quietly left out of the other checks as listPublicFiles leaves it.
 */
export function checkExportPrivate(root: string): Problem[] {
  const rules = readPrivateRules(root);
  return listTreeFiles(root)
    .filter((f) => isPrivate(f, rules))
    .map((f) => ({ check: 'export-private', message: `${f} is a private path (scripts/private-paths.txt), and this export holds it` }));
}

function firstBytes(file: string, n: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const got = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The comment leader of a source file, or null when the file is not source (an extensionless file counts when it starts with a shebang). */
export function commentFor(root: string, rel: string): string | null {
  const ext = path.extname(rel);
  if (ext in COMMENT) return COMMENT[ext]!;
  if (ext === '' && statSync(path.join(root, rel)).isFile() && firstBytes(path.join(root, rel), 2) === '#!') return '#';
  return null;
}

export function sourceFiles(root: string): string[] {
  return listPublicFiles(root).filter((f) => commentFor(root, f) !== null && !EXEMPT.some((e) => f.startsWith(e.prefix)));
}

/** spdx-header-check. The header sits in the first 3 lines (after a shebang line when there is one). */
export function checkSpdx(root: string, floor: number = MIN_SOURCE_FILES): Problem[] {
  const problems: Problem[] = [];
  const bad = (message: string) => problems.push({ check: 'spdx-header-check', message });
  const licensePath = path.join(root, 'LICENSE');
  if (!existsSync(licensePath)) bad('LICENSE is missing (FR-DIST-2: the license file is the AGPL-3.0 text)');
  else {
    const text = readFileSync(licensePath, 'utf8');
    if (!/GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/.test(text)) bad('LICENSE is not the GNU AGPL version 3 text');
  }
  const reuse = path.join(root, 'REUSE.toml');
  const reuseText = existsSync(reuse) ? readFileSync(reuse, 'utf8') : '';
  for (const e of EXEMPT) {
    if (!reuseText.includes(e.prefix)) bad(`REUSE.toml does not name ${e.prefix} (exempt from headers: ${e.reason})`);
  }
  if (reuseText !== '' && !/SPDX-License-Identifier\s*=\s*"AGPL-3\.0-or-later"/.test(reuseText)) bad('REUSE.toml does not carry AGPL-3.0-or-later');
  const sources = sourceFiles(root);
  if (sources.length < floor) bad(`the header check found ${sources.length} source files, fewer than the pinned floor of ${floor} (a dropped suffix or a wider exempt prefix; F-1576)`);
  for (const rel of sources) {
    const lines = readFileSync(path.join(root, rel), 'utf8').split('\n', 4).slice(0, 3);
    if (!lines[0]!.startsWith('#!') && lines.slice(1).some((l) => l.startsWith('#!'))) {
      bad(`${rel}: the shebang is not on line 1 (a line above it stops the script from running; F-1574)`);
      continue;
    }
    if (!lines.some((l) => l.includes('SPDX-License-Identifier') && SPDX_LINE.test(l))) {
      const found = lines.find((l) => l.includes('SPDX-License-Identifier'));
      bad(found ? `${rel}: the SPDX line is not exactly AGPL-3.0-or-later (${found.trim()})` : `${rel}: no SPDX-License-Identifier: AGPL-3.0-or-later line in the first 3 lines`);
    }
  }
  return problems;
}

/** The table cells of a README row, lowercased with the code ticks and bold marks removed (F-1575: values are tested whole, never as substrings of the setting name). */
function cellValues(line: string): string[] {
  return line.split('|').slice(1, -1).map((c) => c.trim().replace(/[`*]/g, '').toLowerCase());
}

/** The items the README must carry (FR-DIST-7), and the reset protection setting beside demo mode (OI-29). */
export function checkReadme(root: string): Problem[] {
  const problems: Problem[] = [];
  const bad = (message: string) => problems.push({ check: 'readme-items', message });
  const file = path.join(root, 'README.md');
  if (!existsSync(file)) return [{ check: 'readme-items', message: 'README.md is missing' }];
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const has = (re: RegExp) => re.test(text);
  const nodeVersion = existsSync(path.join(root, '.node-version')) ? readFileSync(path.join(root, '.node-version'), 'utf8').trim() : '';
  const pnpmVersion = /"packageManager":\s*"pnpm@([^"]+)"/.exec(existsSync(path.join(root, 'package.json')) ? readFileSync(path.join(root, 'package.json'), 'utf8') : '')?.[1] ?? '';

  if (!(has(/docker compose/i) && has(/infra\/compose\.yaml/))) bad('item 1: running a copy with the Compose file (docker compose and infra/compose.yaml)');
  if (!(has(/Docker Desktop/) && has(/250 employees/) && has(/Podman/) && has(/Colima/))) bad('item 2: the Docker Desktop license caveat with the free Podman and Colima options');
  if (!(nodeVersion !== '' && text.includes(nodeVersion) && pnpmVersion !== '' && text.includes(`pnpm ${pnpmVersion}`) && has(/PostgreSQL 18/))) {
    bad(`item 3: a developer path naming Node ${nodeVersion || '(.node-version)'}, pnpm ${pnpmVersion || '(packageManager)'} and PostgreSQL 18`);
  }
  if (!lines.some((l) => /fictional/i.test(l) && /address/i.test(l))) bad('item 4: that sample addresses are fictional');
  if (!lines.some((l) => /phone/i.test(l) && /repeat/i.test(l))) bad('item 5: why sample phone numbers repeat');
  // OI-29: the reset protection setting is named beside demo mode (within 3 lines of it).
  const demo = lines.flatMap((l, i) => (/DEMO_MODE/.test(l) ? [i] : []));
  const reset = lines.flatMap((l, i) => (/RESET_PROTECTION/.test(l) ? [i] : []));
  if (demo.length === 0) bad('OI-29: the demo mode setting (DEMO_MODE) is not in the README');
  else if (reset.length === 0) bad('OI-29: the reset protection setting (RESET_PROTECTION) is not in the README');
  else if (!demo.some((d) => reset.some((r) => Math.abs(d - r) <= 3))) bad('OI-29: RESET_PROTECTION is not beside DEMO_MODE (within 3 lines)');
  if (reset.length > 0 && !lines.some((l) => /RESET_PROTECTION/.test(l) && cellValues(l).includes('off') && cellValues(l).includes('on'))) bad('OI-29: the README does not say the own-copy default (off) and the hosted value (on) of RESET_PROTECTION');
  return problems;
}

/** The COPYING.iOS file must be present: it carries the App Store permission (copying-ios-present, FR-DIST-4). */
export function checkCopying(root: string): Problem[] {
  const file = path.join(root, 'COPYING.iOS');
  const bad = (message: string): Problem[] => [{ check: 'copying-ios-present', message }];
  if (!existsSync(file)) return bad('COPYING.iOS is missing (FR-DIST-4: the section 7 App Store permission)');
  const text = readFileSync(file, 'utf8');
  if (!/section 7/i.test(text) || !/App Store/.test(text) || !/AFFERO|AGPL/i.test(text)) return bad('COPYING.iOS does not name the AGPL section 7 additional permission for the App Store');
  return [];
}

/** LICENSE-DATA.md (FR-DIST-5) and .env.example (F-321). */
export function checkFiles(root: string): Problem[] {
  const problems: Problem[] = [];
  const bad = (check: string, message: string) => problems.push({ check, message });
  const data = path.join(root, 'LICENSE-DATA.md');
  if (!existsSync(data)) bad('license-data-present', 'LICENSE-DATA.md is missing (FR-DIST-5)');
  else {
    const text = readFileSync(data, 'utf8');
    if (!/ODbL/.test(text) || !/Open Database License/.test(text)) bad('license-data-present', 'LICENSE-DATA.md does not name the ODbL');
    if (!/OpenStreetMap/.test(text) || !/©\s*OpenStreetMap contributors/.test(text)) bad('license-data-present', 'LICENSE-DATA.md does not carry the OpenStreetMap credit');
  }
  const env = path.join(root, '.env.example');
  if (!existsSync(env)) bad('env-example', '.env.example is missing (F-321)');
  else {
    const m = /^SAMPLE_PASSWORD_SEED=(.*)$/m.exec(readFileSync(env, 'utf8'));
    if (!m) bad('env-example', '.env.example has no SAMPLE_PASSWORD_SEED line');
    else if ((m[1] ?? '').trim().length < 16) bad('env-example', 'SAMPLE_PASSWORD_SEED in .env.example is shorter than 16 characters');
  }
  // F-248: a license that asks for a credit (CC-BY-4.0 for caniuse-lite) is met only when the shipped notices file carries it.
  const notices = path.join(root, 'THIRD-PARTY-NOTICES.md');
  const credits = policyCredits(root);
  if (credits === null) bad('third-party-notices', 'ci/license/policy.json is missing or not JSON (the credits are read from it)');
  else if (!existsSync(notices)) bad('third-party-notices', 'THIRD-PARTY-NOTICES.md is missing (F-248: the shipped credits)');
  else {
    const text = readFileSync(notices, 'utf8');
    for (const c of credits) if (!text.includes(c)) bad('third-party-notices', `THIRD-PARTY-NOTICES.md does not carry the credit "${c.slice(0, 60)}..." word for word (ci/license/policy.json)`);
  }
  return problems;
}

/** F-248: every "credit" string in ci/license/policy.json (at any depth); null when the file is missing or not JSON. */
export function policyCredits(root: string): string[] | null {
  let policy: unknown;
  try {
    policy = JSON.parse(readFileSync(path.join(root, 'ci', 'license', 'policy.json'), 'utf8'));
  } catch {
    return null;
  }
  const out: string[] = [];
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o !== null && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if (k === 'credit' && typeof v === 'string') out.push(v);
        else walk(v);
      }
    }
  };
  walk(policy);
  return out;
}

/** F-1571 (owner answer 44079436, "Keep them private"): paths the export leaves out that no exported file may name. */
export const PRIVATE_REFS: readonly string[] = ['ci/vendor/', 'infra/owner.env', 'infra/owner.local.env'];

/**
 * F-1571: the exported files that may name a PRIVATE_REFS path, each because it skips the call when the path is absent
 * (or, for the last 5, is the rule, the check or a test that plants the path). Any other exported file that names one fails private-refs.
 */
export const PRIVATE_REF_OK: readonly string[] = [
  'ci/test-reason.sh', 'ci/wave-run.sh',
  // F-1605: the drills read the owner file only when it is there (infra/drill/owner-env.sh), else the environment or a public default.
  'infra/drill/owner-env.sh', 'infra/drill/outage-drill.sh',
  // F-1609: the ignore rule for the private server-address file.
  '.gitignore',
  'ci/wave-run.test.ts', 'ci/run-gates.ts', 'ci/run-gates.test.ts', 'ci/README.md',
  'scripts/private-paths.txt', 'ci/public-files.ts', 'ci/public-files.test.ts', 'ci/smoke/smoke.test.ts',
  // F-1622: the publish test plants a stand-in owner file in its own test repo to prove the exported ref's list leaves it out.
  'ci/publish.test.ts',
  // F-1621: the release's owner-id reader (the app config and release/asc.mjs) reads the owner file only when it is there, else the environment.
  'apps/tech-native/release/owner-env.cjs',
];

/** private-refs: no exported file names a private path (PRIVATE_REFS) unless it is in PRIVATE_REF_OK. */
export function checkPrivateRefs(root: string): Problem[] {
  const problems: Problem[] = [];
  const rules = readPrivateRules(root);
  for (const ref of PRIVATE_REFS) {
    if (!isPrivate(ref, rules)) problems.push({ check: 'private-refs', message: `${ref} is not in scripts/private-paths.txt (owner answer 44079436: keep it private)` });
  }
  for (const rel of listPublicFiles(root)) {
    if (PRIVATE_REF_OK.includes(rel)) continue;
    // A link or a folder in the listing (an untracked node_modules link, a submodule) holds no text of its own to check.
    if (!lstatSync(path.join(root, rel)).isFile()) continue;
    const body = readFileSync(path.join(root, rel), 'utf8');
    for (const ref of PRIVATE_REFS) {
      if (body.includes(ref)) problems.push({ check: 'private-refs', message: `${rel}: names the private path ${ref} (the export leaves it out, so the reference dangles; F-1571)` });
    }
  }
  return problems;
}

/**
 * F-1609: an IPv4 literal in an exported file. The owner's rule: a server address never goes in a committed file (the public
 * domain is fine). A dotted quad passes when it is loopback, 0.0.0.0, broadcast, link-local, a private range (10/8, 172.16/12,
 * 192.168/16), an RFC 5737 documentation range, a well-known public resolver the egress probes use, or version-shaped
 * (stuck to a word, a dot or "Name/" before it, or more digits after it, as in Chrome/120.0.0.0). Everything else is a real address and fails the export.
 */
// F-1626: a letter-slash prefix is version-shaped only after a product token (Chrome/120.0.0.0): a word that starts after a space, a quote or the line start.
// The last word of a host or a path (ipinfo.io/<address>, api/<address>) is preceded by a dot or a slash, so it no longer passes.
const IPV4 = /(?<![\w.]|(?<![\w./-])[A-Za-z][A-Za-z0-9_-]*\/)(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d|\w)/g;
/** F-1626: the dashed form a cloud host name carries (ec2-a-b-c-d.region.compute.amazonaws.com, ip-a-b-c-d.ec2.internal). */
const IPV4_DASHED = /(?<![\w-])(?:ec2|ip)-(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})(?![\w-])/g;
const IPV4_RESOLVERS: readonly string[] = ['1.1.1.1', '8.8.8.8', '8.8.4.4'];
export function isAllowedIpv4(ip: string): boolean {
  const p = ip.split('.').map(Number) as [number, number, number, number];
  if (p.some((n) => n > 255)) return true; // not an address
  const [a, b, c] = p;
  return (
    a === 127 || a === 10 || ip === '0.0.0.0' || ip === '255.255.255.255' ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) ||
    (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) ||
    IPV4_RESOLVERS.includes(ip)
  );
}
/** The 1-based line numbers of the real IPv4 literals in a text. Never the address itself: the messages must not print it. */
export function publicIpv4Lines(text: string): number[] {
  const lines: number[] = [];
  text.split('\n').forEach((line, i) => {
    const dashed = [...line.matchAll(IPV4_DASHED)].map((m) => m.slice(1, 5).join('.'));
    if ([...(line.match(IPV4) ?? []), ...dashed].some((ip) => !isAllowedIpv4(ip))) lines.push(i + 1);
  });
  return lines;
}

/** ipv4: no exported text file holds an IPv4 literal outside the allowlist (F-1609). */
export function checkIpv4(root: string): Problem[] {
  const problems: Problem[] = [];
  for (const rel of listPublicFiles(root)) {
    if (!lstatSync(path.join(root, rel)).isFile()) continue;
    const buf = readFileSync(path.join(root, rel));
    if (buf.subarray(0, 8192).includes(0)) continue; // binary
    const lines = publicIpv4Lines(buf.toString('utf8'));
    if (lines.length > 0) problems.push({ check: 'ipv4', message: `${rel}: line ${lines.slice(0, 5).join(', ')}: an IPv4 address (not printed); a server address comes from the environment or the owner's private file, never a committed file (F-1609)` });
  }
  return problems;
}

/**
 * F-1621 (owner answer dedc3b70, "Keep them private"): the owner's Apple ids, which no exported file may hold. The values are never in
 * this code: they are read at check time from the owner's private files, under these keys, and never printed.
 */
export const OWNER_IDS: readonly { key: string; what: string }[] = [
  { key: 'BW_APPLE_TEAM_ID', what: 'the Apple team id' },
  { key: 'BW_ASC_KEY_ID', what: 'the App Store Connect API key id' },
];
const OWNER_FILES: readonly string[] = ['infra/owner.env', 'infra/owner.local.env'];
const APPLE_ID = /^[A-Z0-9]{10}$/;

/**
 * The owner files the owner-ids check reads by default: the checked tree's, then this checkout's own. scripts/publish.sh checks the
 * candidate commit, which is the export and so has no owner file, with the private checkout's ci/public-files.ts: the second pair is
 * the one that holds the ids there. --owner-env <file> (repeatable) names the files instead.
 */
export function defaultOwnerFiles(root: string): string[] {
  const self = path.resolve(import.meta.dirname, '..');
  return [...new Set([root, self].flatMap((r) => OWNER_FILES.map((f) => path.join(r, f))))];
}

/** The owner ids the files hold: for each key, every distinct value (infra/drill/owner-env.sh's line rules: KEY=VALUE, # comments, no quotes). */
export function readOwnerIds(files: readonly string[]): { read: string[]; ids: Map<string, Set<string>> } {
  const read: string[] = [];
  const ids = new Map<string, Set<string>>(OWNER_IDS.map((o) => [o.key, new Set<string>()]));
  for (const f of files) {
    if (!existsSync(f) || !statSync(f).isFile()) continue;
    read.push(f);
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      ids.get(line.slice(0, eq))?.add(line.slice(eq + 1));
    }
  }
  return { read, ids };
}

/**
 * owner-ids: no exported file holds the owner's Apple team id or App Store Connect key id (F-1621). Every exported file is searched byte
 * for byte, whatever its type (json, plist, js, ts, sh, md, binary). With no owner file at all (a public copy) there is nothing to look
 * for and the check passes; an owner file that lacks an id, or holds a malformed one, fails, so the check can never pass by finding nothing.
 */
export function checkOwnerIds(root: string, ownerFiles: readonly string[] = defaultOwnerFiles(root)): Problem[] {
  const problems: Problem[] = [];
  const { read, ids } = readOwnerIds(ownerFiles);
  if (read.length === 0) return problems;
  const wanted: { key: string; what: string; value: Buffer }[] = [];
  for (const o of OWNER_IDS) {
    const values = [...ids.get(o.key)!];
    if (values.length === 0) problems.push({ check: 'owner-ids', message: `no owner file holds ${o.key} (${o.what}), so the check cannot look for it (F-1621); the files read: ${read.length}` });
    for (const v of values) {
      if (!APPLE_ID.test(v)) problems.push({ check: 'owner-ids', message: `${o.key} in the owner file is not 10 capitals or digits (not printed); the check cannot look for it (F-1621)` });
      else wanted.push({ key: o.key, what: o.what, value: Buffer.from(v) });
    }
  }
  for (const rel of listPublicFiles(root)) {
    if (!lstatSync(path.join(root, rel)).isFile()) continue;
    const buf = readFileSync(path.join(root, rel));
    for (const w of wanted) {
      let n = 0;
      for (let i = buf.indexOf(w.value); i >= 0; i = buf.indexOf(w.value, i + 1)) n++;
      if (n > 0) problems.push({ check: 'owner-ids', message: `${rel}: holds ${w.what} (${w.key} from the owner's private file; not printed) ${n} time(s); it comes from the owner file at run time, never a committed file (F-1621)` });
    }
  }
  return problems;
}

const FONT_EXT = /\.(woff2?|ttf|otf)$/i;
const FONT_LICENSE = /^(OFL|LICENSE|LICENCE|COPYING)/i;

/** fonts-licensed (K-12): each folder of the public tree that holds a font file also holds a license file (OFL-1.1.txt, LICENSE, ...). */
export function checkFonts(root: string): Problem[] {
  const files = listPublicFiles(root);
  const folders = new Set(files.filter((f) => FONT_EXT.test(f)).map((f) => path.posix.dirname(f)));
  return [...folders]
    .filter((d) => !files.some((f) => path.posix.dirname(f) === d && FONT_LICENSE.test(path.posix.basename(f))))
    .map((d) => ({ check: 'fonts-licensed', message: `${d}/ holds a font and no license file (OFL-1.1.txt, LICENSE or COPYING beside it; K-12)` }));
}

/** A REUSE.toml path pattern as a regular expression: ** crosses folders, * does not (REUSE specification 3.2). */
function reuseGlob(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (pattern.startsWith('**/', i)) { re += '(?:.*/)?'; i += 2; }
    else if (pattern.startsWith('**', i)) { re += '.*'; i += 1; }
    else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The path patterns of the REUSE.toml annotations that carry AGPL-3.0-or-later. */
export function reuseCovers(root: string): RegExp[] {
  const file = path.join(root, 'REUSE.toml');
  if (!existsSync(file)) return [];
  const out: RegExp[] = [];
  for (const block of readFileSync(file, 'utf8').split(/^\[\[annotations\]\]/m).slice(1)) {
    if (!/^SPDX-License-Identifier\s*=\s*"AGPL-3\.0-or-later"/m.test(block)) continue;
    const list = /^path\s*=\s*\[([^\]]*)\]/m.exec(block)?.[1] ?? '';
    for (const m of list.matchAll(/"([^"]+)"/g)) out.push(reuseGlob(m[1]!));
  }
  return out;
}

/** css-covered (K-13, F-2025): a stylesheet carries the SPDX line in its first 3 lines, or a REUSE.toml annotation with AGPL-3.0-or-later covers its path. */
export function checkCss(root: string): Problem[] {
  const covers = reuseCovers(root);
  const problems: Problem[] = [];
  for (const rel of listPublicFiles(root).filter((f) => f.endsWith('.css'))) {
    const head = readFileSync(path.join(root, rel), 'utf8').split('\n', 4).slice(0, 3);
    if (head.some((l) => /SPDX-License-Identifier:\s*AGPL-3\.0-or-later/.test(l)) || covers.some((c) => c.test(rel))) continue;
    problems.push({ check: 'css-covered', message: `${rel}: no SPDX-License-Identifier line in the first 3 lines and no REUSE.toml annotation covers it (K-13)` });
  }
  return problems;
}

/**
 * persist-credentials (K-15): the workflows are a private path, so they are read from the checked tree and from this checkout (as
 * owner-ids does: publish checks an export, which has none). A checkout step without persist-credentials: false in its own block fails.
 */
export function checkWorkflows(root: string): Problem[] {
  const problems: Problem[] = [];
  const self = path.resolve(import.meta.dirname, '..');
  for (const base of new Set([root, self])) {
    const dir = path.join(base, '.github', 'workflows');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
      const lines = readFileSync(path.join(dir, name), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/^\s*(?:- )?uses:\s*actions\/checkout@/.test(line)) return;
        const indent = line.indexOf('uses:');
        let ok = false;
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j]!;
          if (l.trim() === '') continue;
          const at = l.length - l.trimStart().length;
          if (at < indent || (at <= indent && l.trimStart().startsWith('- '))) break;
          if (/^\s*persist-credentials:\s*['"]?false['"]?\s*(#.*)?$/.test(l)) ok = true;
        }
        if (!ok) problems.push({ check: 'persist-credentials', message: `${path.relative(base, path.join(dir, name))}:${i + 1}: a checkout step without persist-credentials: false (K-15)` });
      });
    }
  }
  return problems;
}

/** changelog (K-21): the export holds CHANGELOG.md. */
export function checkChangelog(root: string): Problem[] {
  return listPublicFiles(root).includes('CHANGELOG.md') ? [] : [{ check: 'changelog', message: 'CHANGELOG.md is missing from the public tree (K-21)' }];
}

/** engines (J-31): package.json engines.node is the pinned major of .node-version, as >=MAJOR. */
export function checkEngines(root: string): Problem[] {
  const bad = (message: string): Problem[] => [{ check: 'engines', message }];
  let pinned: string;
  let engines: unknown;
  try {
    pinned = readFileSync(path.join(root, '.node-version'), 'utf8').trim();
    engines = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { engines?: { node?: unknown } }).engines?.node;
  } catch (e) {
    return bad(`.node-version or package.json cannot be read: ${(e as Error).message}`);
  }
  const major = /^v?(\d+)\./.exec(pinned)?.[1];
  if (!major) return bad(`.node-version is not a version (${pinned})`);
  return engines === `>=${major}` ? [] : bad(`package.json engines.node is ${JSON.stringify(engines)}, not ">=${major}" (the major of .node-version ${pinned}; J-31)`);
}

/** domain (J-32): no shipped text file names the owner's company domain. */
export const COMPANY_DOMAIN = 'brightwaterair.com';
export function checkDomain(root: string): Problem[] {
  const problems: Problem[] = [];
  for (const rel of listPublicFiles(root)) {
    if (!lstatSync(path.join(root, rel)).isFile()) continue;
    if (rel === 'ci/public-files.ts' || rel === 'ci/public-files.test.ts') continue; // the rule and the check that plants it
    const buf = readFileSync(path.join(root, rel));
    if (!buf.subarray(0, 8192).includes(0) && buf.includes(COMPANY_DOMAIN)) problems.push({ check: 'domain', message: `${rel}: names ${COMPANY_DOMAIN} (a sample address uses example.com; J-32)` });
  }
  return problems;
}

/** spike (J-35): infra/spike/ is a private path, and an export (--export) holds none of it. */
export function checkSpike(root: string, exported = false): Problem[] {
  const problems: Problem[] = [];
  if (!isPrivate('infra/spike/s1/x', readPrivateRules(root))) problems.push({ check: 'spike', message: 'infra/spike/ is not in scripts/private-paths.txt (J-35)' });
  if (exported) for (const f of listTreeFiles(root).filter((x) => x.startsWith('infra/spike/'))) problems.push({ check: 'spike', message: `${f}: the export holds infra/spike/ (J-35)` });
  return problems;
}

interface Options {
  exported: boolean;
  floor: number;
  /** owner-ids: the owner files to read; null for defaultOwnerFiles. */
  ownerEnv: string[] | null;
}
const CHECKS: Record<string, (root: string, o: Options) => Problem[]> = {
  fonts: checkFonts, css: checkCss, workflows: checkWorkflows, changelog: checkChangelog, engines: checkEngines, domain: checkDomain, spike: (r, o) => checkSpike(r, o.exported),
  spdx: (r, o) => checkSpdx(r, o.floor), readme: checkReadme, copying: checkCopying, files: checkFiles, 'private-refs': checkPrivateRefs, ipv4: checkIpv4,
  'owner-ids': (r, o) => checkOwnerIds(r, o.ownerEnv ?? defaultOwnerFiles(r)),
};

export function run(which: string, root: string, floor: number = MIN_SOURCE_FILES, ownerEnv: string[] | null = null, exported = false): Problem[] {
  const names = which === 'all' ? Object.keys(CHECKS) : [which];
  return [...(exported ? checkExportPrivate(root) : []), ...names.flatMap((n) => CHECKS[n]!(root, { floor, ownerEnv, exported }))];
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  let which = 'all';
  let root = path.resolve(import.meta.dirname, '..');
  let floor = MIN_SOURCE_FILES;
  let ownerEnv: string[] | null = null;
  let exported = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--export') exported = true;
    else if (a === '--root') root = path.resolve(args[++i] ?? '');
    else if (a === '--floor') floor = Number(args[++i]);
    else if (a === '--owner-env' && args[i + 1]) (ownerEnv ??= []).push(path.resolve(args[++i]!));
    else if (a === 'all' || a in CHECKS) which = a;
    else {
      console.error('usage: node ci/public-files.ts [spdx|readme|copying|files|private-refs|ipv4|owner-ids|fonts|css|workflows|changelog|engines|domain|spike|all] [--root <dir>] [--floor <n>] [--owner-env <file>]... [--export]');
      process.exit(2);
    }
  }
  const problems = run(which, root, floor, ownerEnv, exported);
  for (const p of problems) console.error(`public-files-check: FAIL ${p.check}: ${p.message}`);
  if (problems.length > 0) process.exit(1);
  const notes: string[] = [];
  if (which === 'all' || which === 'spdx') notes.push(`${sourceFiles(root).length} source files with the header`);
  if (which === 'all' || which === 'owner-ids') {
    const { read } = readOwnerIds(ownerEnv ?? defaultOwnerFiles(root));
    notes.push(read.length === 0 ? 'owner ids: no owner file, nothing to look for' : `owner ids: ${OWNER_IDS.length} looked for, from ${read.length} owner file(s), in none of the exported files`);
  }
  console.log(`public-files-check: PASS ${which} (${notes.length > 0 ? notes.join('; ') : 'ok'})`);
}
