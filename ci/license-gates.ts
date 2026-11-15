// SPDX-License-Identifier: AGPL-3.0-or-later
// license-gates (G-LICENSE; SPECIFICATIONS SD-39; FR-DIST-6, HC-07): `license-inventory` and `ios-bundle-copyleft`.
//   node ci/license-gates.ts [inventory|ios|all] [--fixture <dir>]
// Exit 0: pass. Exit 1: a license failure (each printed). Exit 2: cannot judge (pnpm or an input failed).
// Inputs come from pnpm (`pnpm -r licenses list --json` for the full tree, `pnpm --filter <project> licenses list --json --prod`
// per server root). The iPhone app's shipped set is what Metro bundles: `expo export --platform ios --source-maps` into a temp
// dir, then name@version from the node_modules paths in the source map's sources (Expo build tooling never enters it).
// With --fixture <dir> inputs come from <dir>/all.json, shipped.json (server closure), ios.json (native production closure)
// and bundle-sources.json (the source map's sources list; absent = empty) instead (the planted known-bads under
// ci/gates/license-gates/cases); the .json files except bundle-sources have the shape pnpm prints.
// Env (for tests): CI_ROOT (repo root; policy, record and workspace packages are read from it).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { isMain } from './is-main.ts';
import { isShallow, mergedTasks, resolveMainRef } from './gates-lib.ts';

export interface Pkg { name: string; version: string; license: string }
interface Policy {
  allow: string[];
  restricted: {
    'OFL-1.1': { namePatterns: string[] }; 'ODbL-1.0': { names: string[] }; 'CC-BY-4.0'?: { names: string[]; credit?: string };
    /** Owner ruling 0963dc1d (F-1263): sharp's libvips, server closure only (never the iPhone bundle). */
    'LGPL-3.0-or-later'?: { namePatterns: string[]; serverOnly: true };
  };
  shippedRoots: string[];
  bundleApp: { project: string; dir: string };
  iosRoots: string[];
  workspaceDirs: string[];
  /** F-85: the fewest packages the iPhone Metro bundle may resolve to; fewer means the shipped set shrank. */
  bundleFloor?: number;
  /** F-112: the least number of native modules the iOS autolinker must resolve (a read that returns none is not a clean answer). */
  autolinkedFloor?: number;
}
export interface Verified {
  component: string;
  kind: 'npm' | 'container' | 'spm' | 'vendored';
  package: string;
  spdx: string;
  evidence: string;
  /** F-88: the plan task whose merge retires a PENDING npm entry; the gate fails when it has merged and the entry is still PENDING. */
  owner?: string;
  /** F-1163: why an npm entry does not ship (an SD fallback its owning task did not take). The entry prints RETIRED, and the gate fails if the package lands in the lockfile while the record says it does not ship. */
  retired?: string;
  /** F-88: a checkable source for an entry outside the npm tree: a license text kept in ci/license/ and its SHA-256. */
  licenseFile?: string;
  licenseSha256?: string;
  licenseTerms?: string;
}

/** Flatten pnpm's `{ "<license>": [{ name, versions: [..] }] }` into one row per name and version. */
export function flatten(raw: unknown): Pkg[] {
  const out: Pkg[] = [];
  for (const [license, entries] of Object.entries((raw ?? {}) as Record<string, { name: string; versions: string[] }[]>)) {
    for (const e of entries) for (const version of e.versions) out.push({ name: e.name, version, license });
  }
  return out;
}

// --- SPDX expressions: OR = the licensee may pick any alternative, AND = all apply, WITH adds an exception to an id.
type Node = { op: 'id'; id: string } | { op: 'and' | 'or'; l: Node; r: Node };
function parse(expr: string): Node | null {
  const toks = expr.replace(/([()])/g, ' $1 ').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  const primary = (): Node | null => {
    const t = toks[i++];
    if (t === undefined) return null;
    if (t === '(') {
      const n = or();
      if (toks[i++] !== ')') return null;
      return n;
    }
    if (t === ')' || /^(AND|OR|WITH)$/i.test(t)) return null;
    let id = t;
    if (toks[i]?.toUpperCase() === 'WITH') { i += 2; id = `${t} WITH ${toks[i - 1] ?? ''}`; }
    return { op: 'id', id };
  };
  const and = (): Node | null => {
    let l = primary();
    while (l && toks[i]?.toUpperCase() === 'AND') { i++; const r = primary(); l = r ? { op: 'and', l, r } : null; }
    return l;
  };
  const or = (): Node | null => {
    let l = and();
    while (l && toks[i]?.toUpperCase() === 'OR') { i++; const r = and(); l = r ? { op: 'or', l, r } : null; }
    return l;
  };
  const n = or();
  return n && i === toks.length ? n : null;
}
/** True when the expression is satisfiable using only ids accepted by `ok`. Unparseable is false. */
export function satisfies(expr: string, ok: (id: string) => boolean): boolean {
  const n = parse(expr);
  const ev = (x: Node): boolean => (x.op === 'id' ? ok(x.id.replace(/\+$/, '')) : x.op === 'and' ? ev(x.l) && ev(x.r) : ev(x.l) || ev(x.r));
  return n ? ev(n) : false;
}
export const isCopyleft = (id: string): boolean => /^(A|L)?GPL(-|$)/i.test(id);

export function loadPolicy(root: string): Policy {
  return JSON.parse(readFileSync(path.join(root, 'ci', 'license', 'policy.json'), 'utf8')) as Policy;
}

/**
 * Why a shipped package fails the SD-39 allow-list, or null when it passes. `inIphoneApp`: the package ships in the iPhone app (its
 * Metro bundle or native modules), where a server-only exception (libvips, owner ruling 0963dc1d) never applies.
 */
export function shippedProblem(p: Pkg, policy: Policy, inIphoneApp = false): string | null {
  const lic = p.license.trim();
  if (!lic || /^(unknown|unlicensed|none)$/i.test(lic) || /^see license/i.test(lic)) {
    return `has no declared license (pnpm reports "${p.license}")`;
  }
  const fontRes = policy.restricted['OFL-1.1'].namePatterns.map((s) => new RegExp(s));
  const ok = (id: string): boolean =>
    policy.allow.includes(id) ||
    (id === 'OFL-1.1' && fontRes.some((r) => r.test(p.name))) ||
    (id === 'ODbL-1.0' && policy.restricted['ODbL-1.0'].names.includes(p.name)) ||
    (id === 'CC-BY-4.0' && (policy.restricted['CC-BY-4.0']?.names ?? []).includes(p.name)) ||
    (id === 'LGPL-3.0-or-later' && !inIphoneApp && (policy.restricted['LGPL-3.0-or-later']?.namePatterns ?? []).some((s) => new RegExp(s).test(p.name)));
  return satisfies(lic, ok) ? null : `license ${lic} is not on the SD-39 allow-list`;
}

/** name@version of every pnpm package in a Metro source map's `sources`. Unresolvable node_modules paths come back in `unresolved`. */
export function bundlePackages(sources: string[]): { pkgs: { name: string; version: string }[]; unresolved: string[] } {
  const re = /node_modules\/\.pnpm\/((?:@[^+/]+\+)?[^@/]+)@([^_/]+)/;
  const found = new Map<string, { name: string; version: string }>();
  const unresolved: string[] = [];
  for (const src of sources) {
    if (!src.includes('node_modules')) continue;
    const m = re.exec(src);
    if (!m) { unresolved.push(src); continue; }
    const name = (m[1] as string).replace('+', '/');
    found.set(`${name}@${m[2]}`, { name, version: m[2] as string });
  }
  return { pkgs: [...found.values()], unresolved };
}

/** F-85: a bundle source outside node_modules is first-party only under apps/ or packages/, or a Metro polyfill. */
export function foreignSources(sources: string[]): string[] {
  return sources.filter((s) => !s.includes('node_modules') && !/^\/?(apps|packages)\//.test(s) && !/(^|\0)polyfill:/.test(s));
}

/**
 * The bundle's packages with the license the resolved tree records for them. A package the tree does not know fails.
 * `native` is the modules the iOS autolinker links in (F-84): their native code ships although the JS bundle never imports them.
 */
export function bundleShipped(sources: string[], all: Pkg[], native: { name: string; version: string }[] = []): { shipped: Pkg[]; failures: string[] } {
  const { pkgs, unresolved } = bundlePackages(sources);
  const failures = unresolved.map((u) => `license-inventory: FAIL bundle source ${u} is in node_modules but not a pnpm package path, so its license cannot be resolved`);
  failures.push(...foreignSources(sources).map((u) => `license-inventory: FAIL bundle source ${u} is outside node_modules but not under apps/ or packages/, so it is not provably first-party`));
  const shipped: Pkg[] = [];
  const seen = new Set<string>();
  for (const b of [...pkgs, ...native]) {
    const k = `${b.name}@${b.version}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const hit = all.find((p) => p.name === b.name && p.version === b.version);
    if (hit) shipped.push(hit);
    else failures.push(`license-inventory: FAIL bundled ${b.name}@${b.version} is not in the resolved tree, so its license cannot be resolved`);
  }
  return { shipped, failures };
}

/** name@version of every module `expo-modules-autolinking resolve --platform apple --json` links into the iOS app. */
export function autolinkedPackages(resolved: unknown): { name: string; version: string }[] {
  const mods = (resolved as { modules?: { packageName?: string; packageVersion?: string }[] } | null)?.modules;
  if (!Array.isArray(mods)) throw new Error('expo-modules-autolinking output has no modules list');
  return mods.flatMap((m) => (m.packageName && m.packageVersion ? [{ name: m.packageName, version: m.packageVersion }] : []));
}

/** F-112: a module the autolinker lists with no name or version is dropped by autolinkedPackages, so it is named here (the app's own modules, apps/tech-native/modules, carry no version and are first-party); and the count has its own floor. */
export function autolinkedProblems(resolved: unknown, floor: number | undefined, firstParty: ReadonlySet<string> = new Set()): string[] {
  const mods = (resolved as { modules?: { packageName?: string; packageVersion?: string }[] } | null)?.modules;
  if (!Array.isArray(mods)) return ['license-inventory: FAIL expo-modules-autolinking output has no modules list'];
  const out = mods.filter((m) => (!m.packageName || !m.packageVersion) && !(m.packageName && firstParty.has(m.packageName))).map((m) => `license-inventory: FAIL an autolinked native module has no ${m.packageName ? 'version' : 'name'} (${m.packageName ?? JSON.stringify(m).slice(0, 80)}), so its license cannot be resolved`);
  if (floor !== undefined && mods.length < floor) out.push(`license-inventory: FAIL the autolinker resolved ${mods.length} native modules, below the floor of ${floor}; the shipped set shrank`);
  return out;
}

export function inventory(all: Pkg[], shipped: Pkg[], policy: Policy, verified: Verified[], merged: ReadonlySet<string> = new Set(), iphone: ReadonlySet<string> = new Set()): { failures: string[]; lines: string[] } {
  const failures: string[] = [];
  const lines: string[] = [];
  const key = (p: Pkg): string => `${p.name}@${p.version}`;
  const shippedKeys = new Set(shipped.map(key));
  const shippedUniq = [...new Map(shipped.map((p) => [key(p), p])).values()];
  const never = all.filter((p) => !shippedKeys.has(key(p)));
  for (const p of shippedUniq) {
    const inApp = iphone.has(key(p));
    const why = shippedProblem(p, policy, inApp);
    if (why) failures.push(`license-inventory: FAIL shipped ${key(p)} ${why}${inApp ? ' (in the iPhone app)' : ''}`);
  }
  // A never-shipped tool may carry any license (OA-81), but it must declare one.
  for (const p of never) {
    if (!p.license.trim() || /^(unknown|unlicensed|none)$/i.test(p.license.trim())) {
      failures.push(`license-inventory: FAIL never-shipped ${key(p)} has no declared license (pnpm reports "${p.license}")`);
    }
  }
  lines.push(`license-inventory: ${shippedUniq.length} shipped packages checked against the SD-39 allow-list, ${never.length} never-shipped packages recorded`);
  // F-89: SD-39 records each never-shipped tool's license; a count is not a record, so list name, version and license.
  for (const p of [...never].sort((a, b) => key(a).localeCompare(key(b)))) lines.push(`never-shipped ${key(p)}: ${p.license.trim() || '(none)'}`);
  const copyleftNever = never.filter((p) => !satisfies(p.license, (id) => !isCopyleft(id)) && parse(p.license) !== null);
  lines.push(`license-inventory: never-shipped tools carrying copyleft (allowed, OA-81): ${copyleftNever.length}`);
  // The build-verified licenses of SPECIFICATIONS section 14.
  for (const v of verified) {
    const found = all.filter((p) => p.name === v.package);
    if (v.kind === 'vendored') {
      // F-530: files kept in this repo; the kept license text is hashed by licenseFileProblems.
      lines.push(`build-verified ${v.component}: ${v.spdx} VENDORED (kept license text hashed; evidence: ${v.evidence})`);
      continue;
    }
    if (v.retired !== undefined) {
      // F-1163: a retired entry records a package that does not ship; the record is false the day the package lands.
      if (v.kind !== 'npm' || !v.retired.trim()) {
        failures.push(`license-inventory: FAIL build-verified ${v.component} is retired without a reason, or is not an npm entry; only an npm entry can be retired, and it must say why it does not ship`);
      } else if (found.length > 0) {
        failures.push(`license-inventory: FAIL build-verified ${v.component} is retired (${v.retired}) but ${found.map(key).join(', ')} is in the lockfile; un-retire the entry so its license is checked`);
      } else {
        lines.push(`build-verified ${v.component}: ${v.spdx} RETIRED (not shipped: ${v.retired}; evidence: ${v.evidence})`);
      }
      continue;
    }
    if (v.kind !== 'npm' || found.length === 0) {
      const where = v.kind === 'container' ? 'container, outside the npm tree' : v.kind === 'spm' ? 'Swift Package Manager, outside the npm tree' : 'not in the lockfile yet';
      const owning = v.owner && v.kind === 'npm' ? `; owning task ${v.owner}` : '';
      lines.push(`build-verified ${v.component}: ${v.spdx} PENDING (${where}${owning}; evidence: ${v.evidence})`);
      // F-88: a PENDING npm entry cannot outlive its owning task.
      if (v.kind === 'npm' && v.owner && merged.has(v.owner)) {
        failures.push(`license-inventory: FAIL build-verified ${v.component} is still PENDING but its owning task ${v.owner} has merged; add the package to the lockfile or retire the entry`);
      }
      continue;
    }
    for (const f of found) {
      if (f.license === v.spdx) lines.push(`build-verified ${v.component}: ${v.spdx} VERIFIED against ${key(f)}`);
      else failures.push(`license-inventory: FAIL build-verified ${v.component} ${key(f)} is ${f.license}, the record says ${v.spdx}`);
    }
  }
  return { failures, lines };
}

/** HC-07: third-party GPL, LGPL or AGPL in the iOS bundle list. A dual license passes only if a non-copyleft alternative exists. */
export function iosCopyleft(ios: Pkg[], acks: { name: string; license: string }[] = []): { failures: string[]; lines: string[] } {
  const failures: string[] = [];
  for (const p of ios) {
    if (!satisfies(p.license, (id) => !isCopyleft(id)) && parse(p.license)) {
      failures.push(`ios-bundle-copyleft: FAIL ${p.name}@${p.version} is ${p.license}, third-party copyleft is not allowed in the iOS bundle (HC-07)`);
    }
  }
  for (const a of acks) {
    if (isCopyleft(a.license) || ackCopyleft(a.license)) failures.push(`ios-bundle-copyleft: FAIL CocoaPods acknowledgment ${a.name} is ${a.license} (HC-07)`);
  }
  return { failures, lines: [`ios-bundle-copyleft: ${ios.length} iOS bundle packages and ${acks.length} CocoaPods acknowledgments checked for GPL, LGPL and AGPL`] };
}

/** A pod of Podfile.lock and where it comes from: npm (a path or podspec under node_modules), the project's own (a path inside the repo outside node_modules), or other (a CocoaPods spec repo or git source). */
export interface PodRow { name: string; origin: 'npm' | 'first-party' | 'other' }

/**
 * F-1221: the pods of a Podfile.lock (PODS names without their subspec, EXTERNAL SOURCES for the origin). `inRepo` says whether a source path
 * (relative to the ios/ folder) resolves inside the repo.
 */
export function parsePodfileLock(text: string, inRepo: (p: string) => boolean): PodRow[] {
  const podsSection = /^PODS:\n([\s\S]*?)\n\n/m.exec(text)?.[1] ?? '';
  const names = new Set<string>();
  for (const line of podsSection.split('\n')) {
    const m = /^ {2}- "?([^ ("]+)/.exec(line);
    if (m?.[1]) names.add(m[1].split('/')[0]!);
  }
  const external = /^EXTERNAL SOURCES:\n([\s\S]*?)\n\n/m.exec(text)?.[1] ?? '';
  const source = new Map<string, string>();
  let current = '';
  for (const line of external.split('\n')) {
    const head = /^ {2}"?([^:"]+)"?:$/.exec(line);
    if (head?.[1]) current = head[1];
    const src = /^ {4}:(path|podspec|git): "?(.*?)"?$/.exec(line);
    if (src?.[2] && current) source.set(current, src[2]);
  }
  return [...names].sort().map((name): PodRow => {
    const src = source.get(name);
    if (src === undefined || /^[a-z]+:\/\//.test(src)) return { name, origin: 'other' };
    if (src.includes('node_modules')) return { name, origin: 'npm' };
    return { name, origin: inRepo(src) ? 'first-party' : 'other' };
  });
}

/** F-1221 (a): the Swift packages an Xcode project declares (remote or local package references), by identity: what the app links, before any resolve. */
export function declaredSwiftPackages(pbxproj: string): string[] {
  const out = new Set<string>();
  for (const m of pbxproj.matchAll(/repositoryURL = "?([^";\s]+)"?;/g)) {
    const id = m[1]!.replace(/\/+$/, '').replace(/\.git$/, '').split('/').pop();
    if (id) out.add(id.toLowerCase());
  }
  for (const m of pbxproj.matchAll(/XCLocalSwiftPackageReference[\s\S]*?relativePath = "?([^";\s]+)"?;/g)) {
    const id = m[1]!.replace(/\/+$/, '').split('/').pop();
    if (id) out.add(id.toLowerCase());
  }
  return [...out].sort();
}

/** F-86: the spellings a pod's acknowledgment can use that are not SPDX ids: GPLv3, GNU GPL, LGPLv2.1, GNU Affero General Public License. */
export const ackCopyleft = (text: string): boolean => /(^|[^A-Za-z])(A|L)?GPL/i.test(text) || /\bGNU\b.*\bPublic License\b/i.test(text);

/**
 * F-86: the check the generated iOS project gets, in the job that runs prebuild and pod install (xcuitest/prebuild.sh). apps/tech-native/ios/
 * is gitignored, so the plain `ios` mode sees 0 acknowledgments in every other run. Here an input that is absent is a failure, not a count of 0:
 * no Pods acknowledgments plist, or a Swift package (Package.resolved) with no entry in ci/license/build-verified.json.
 */
export function podsProblems(
  acks: { name: string; license: string }[], swiftPins: string[], verifiedPackages: string[], pods: PodRow[] | null = null,
): { failures: string[]; lines: string[] } {
  // F-1221 (c): the project's own pods (HC-07 is about third-party code) are exempt by where they live: a LICENSE beside their podspec
  // puts an entry in the acknowledgments, and it is not third-party copyleft.
  const own = new Set((pods ?? []).filter((p) => p.origin === 'first-party').map((p) => p.name));
  const r = iosCopyleft([], acks.filter((a) => !own.has(a.name)));
  const failures = [...r.failures];
  // F-1221 (b): the population is Podfile.lock, not the acknowledgments (CocoaPods lists only pods whose license text it finds): a pod that
  // does not come from npm (the npm inventory covers those) and is not the project's own needs a license text or a build-verified entry.
  const lowered = new Set(verifiedPackages.map((v) => v.toLowerCase()));
  const listed = new Set(acks.map((a) => a.name));
  for (const p of pods ?? []) {
    if (p.origin === 'other' && !listed.has(p.name) && !lowered.has(p.name.toLowerCase())) {
      failures.push(`ios-bundle-copyleft: FAIL pod ${p.name} (Podfile.lock) is not from npm and not the project's own, and has neither a license text in the acknowledgments nor a build-verified entry, so its license is not checked (F-1221)`);
    }
  }
  if (acks.length === 0) failures.push('ios-bundle-copyleft: FAIL 0 CocoaPods acknowledgments found under apps/tech-native/ios/Pods; run xcuitest/prebuild.sh (expo prebuild and pod install) first (F-86)');
  const known = new Set(verifiedPackages);
  for (const pin of swiftPins) {
    if (!known.has(pin)) failures.push(`ios-bundle-copyleft: FAIL Swift package ${pin} (Package.resolved) has no entry in ci/license/build-verified.json, so its license is not checked (F-86)`);
  }
  return { failures, lines: [...r.lines, `ios-bundle-copyleft: ${swiftPins.length} Swift packages in the Xcode projects and Package.resolved, each named in build-verified.json`] };
}

/** Pod names and licenses from a CocoaPods Pods-*-acknowledgements.plist (the entries with a License key). */
export function parseAcknowledgements(plist: string): { name: string; license: string }[] {
  const out: { name: string; license: string }[] = [];
  for (const m of plist.matchAll(/<dict>([\s\S]*?)<\/dict>/g)) {
    const body = m[1] ?? '';
    const lic = /<key>License<\/key>\s*<string>([^<]*)<\/string>/.exec(body)?.[1];
    const title = /<key>Title<\/key>\s*<string>([^<]*)<\/string>/.exec(body)?.[1];
    if (lic && title) out.push({ name: title, license: lic.trim() });
  }
  return out;
}

// --- real-tree inputs
function workspace(root: string, policy: Policy): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const d of policy.workspaceDirs) {
    const dir = path.join(root, d);
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name, 'package.json');
      if (!e.isDirectory() || !existsSync(f)) continue;
      const j = JSON.parse(readFileSync(f, 'utf8')) as { name: string; dependencies?: Record<string, string> };
      m.set(j.name, Object.keys(j.dependencies ?? {}));
    }
  }
  return m;
}
/** The roots plus every workspace package reachable through `dependencies` (dev dependencies never ship). */
/**
 * The installed optional dependencies of shipped packages, transitively, from the lockfile's snapshots (P6-PHOTO-THUMBS): pnpm's
 * `licenses list --prod` leaves every optionalDependencies edge out, but a shipped package's platform binary ships with it (sharp's
 * @img/sharp-<platform> and its libvips, which owner ruling 0963dc1d allows on the server only). Only packages this install holds
 * (`all`) are added, with the license the tree records.
 */
export function optionalShipped(shipped: Pkg[], all: Pkg[], snapshots: Snapshots): Pkg[] {
  const key = (name: string, version: string): string => `${name}@${version}`;
  const installed = new Map(all.map((p) => [key(p.name, p.version), p]));
  const bare = (v: string): string => v.replace(/\(.*$/, '');
  // F-1266 (b): a package this walk adds ships whole, so its own dependencies ship too; only the packages that were shipped already
  // contribute their optional edges alone (their regular edges are already in the closure the caller passed).
  const edgesOf = (name: string, version: string, added: boolean): [string, string][] => Object.entries(snapshots)
    .filter(([k]) => bare(k) === key(name, version))
    .flatMap(([, snap]) => Object.entries({ ...(added ? snap?.dependencies : {}), ...snap?.optionalDependencies }).map(([n, v]): [string, string] => [n, bare(v)]));
  const seen = new Set(shipped.map((p) => key(p.name, p.version)));
  const out: Pkg[] = [];
  const queue = shipped.map((p): [string, string, boolean] => [p.name, p.version, false]);
  for (let next = queue.shift(); next; next = queue.shift()) {
    for (const [n, v] of edgesOf(...next)) {
      const k = key(n, v);
      const pkg = installed.get(k);
      if (seen.has(k) || !pkg) continue;
      seen.add(k);
      out.push(pkg);
      queue.push([n, v, true]);
    }
  }
  return out;
}

type Snapshots = Record<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> } | null>;

/** The snapshots of every document in a pnpm lockfile (pnpm 12 writes the package manager's own lock as a first document). */
export function lockfileSnapshots(text: string): Snapshots {
  return Object.assign({}, ...parseAllDocuments(text).map((d) => ((d.toJS() ?? {}) as { snapshots?: object }).snapshots ?? {}));
}

export function closure(roots: string[], ws: Map<string, string[]>): string[] {
  const seen = new Set<string>();
  const walk = (n: string): void => {
    if (seen.has(n) || !ws.has(n)) return;
    seen.add(n);
    for (const d of ws.get(n) ?? []) walk(d);
  };
  roots.forEach(walk);
  return [...seen];
}
/** F-85: a root name the workspace does not have would be skipped silently; it fails instead. */
export function missingRoots(roots: string[], ws: Map<string, string[]>): string[] {
  return roots.filter((r) => !ws.has(r)).map((r) => `license-inventory: FAIL root ${r} is not a workspace package, so its closure was not checked`);
}
/** F-85: the iPhone shipped set has a floor, so a bundle that shrinks to nothing fails instead of passing on fewer packages. */
export function floorProblems(count: number, floor: number | undefined): string[] {
  return floor !== undefined && count < floor
    ? [`license-inventory: FAIL the iPhone bundle resolved to ${count} packages, below the floor of ${floor}; the shipped set shrank`]
    : [];
}
/** F-88: an entry outside the npm tree is checkable when its license text is kept here and still hashes to the recorded SHA-256. */
export function licenseFileProblems(verified: Verified[], read: (file: string) => string | null): string[] {
  const out: string[] = [];
  for (const v of verified) {
    if (v.kind === 'npm') continue;
    if (!v.licenseFile) continue; // not every non-npm entry has a kept text yet (the map library's iOS side)
    const text = read(v.licenseFile);
    const sha = text === null ? null : createHash('sha256').update(text).digest('hex');
    if (text === null) out.push(`license-inventory: FAIL build-verified ${v.component}: license file ${v.licenseFile} is missing`);
    else if (sha !== v.licenseSha256) out.push(`license-inventory: FAIL build-verified ${v.component}: ${v.licenseFile} hashes to ${sha}, the record says ${v.licenseSha256}`);
    else if (v.licenseTerms && !text.includes(v.licenseTerms)) out.push(`license-inventory: FAIL build-verified ${v.component}: ${v.licenseFile} does not contain "${v.licenseTerms}"`);
  }
  return out;
}
function pnpmJson(root: string, args: string[]): unknown {
  const out = execFileSync('pnpm', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out);
}
function prodClosure(root: string, roots: string[], policy: Policy): Pkg[] {
  const ws = workspace(root, policy);
  return closure(roots, ws).flatMap((n) => flatten(pnpmJson(root, ['--filter', n, 'licenses', 'list', '--json', '--prod'])));
}
/** Export the iOS bundle offline with source maps into a temp dir and return the map's sources. Nothing is written to the tree. */
function exportBundleSources(root: string, policy: Policy): string[] {
  const out = mkdtempSync(path.join(os.tmpdir(), 'bw-license-bundle-'));
  try {
    execFileSync('pnpm', ['exec', 'expo', 'export', '--platform', 'ios', '--source-maps', '--output-dir', out], {
      cwd: path.join(root, policy.bundleApp.dir), encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1' }, maxBuffer: 64 * 1024 * 1024, timeout: 480_000,
    });
    const dir = path.join(out, '_expo', 'static', 'js', 'ios');
    const maps = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.map')) : [];
    if (maps.length === 0) throw new Error(`expo export produced no source map under ${dir}`);
    return maps.flatMap((f) => (JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as { sources: string[] }).sources);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
/** The iOS autolinker's module list (F-84). Needs only the installed tree. */
function exportAutolinked(root: string, policy: Policy): unknown {
  const out = execFileSync('pnpm', ['exec', 'expo-modules-autolinking', 'resolve', '--platform', 'apple', '--json'], {
    cwd: path.join(root, policy.bundleApp.dir), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
  });
  return JSON.parse(out) as unknown;
}
function findAcks(root: string): { name: string; license: string }[] {
  const dir = path.join(root, 'apps', 'tech-native', 'ios', 'Pods', 'Target Support Files');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((t) => {
    const f = path.join(dir, t, `${t}-acknowledgements.plist`);
    return existsSync(f) ? parseAcknowledgements(readFileSync(f, 'utf8')) : [];
  });
}

/** The identities of the Swift packages the generated project resolved (any Package.resolved under apps/tech-native/ios, pins of version 2 or 3). */
function findSwiftPins(root: string): string[] {
  const ios = path.join(root, 'apps', 'tech-native', 'ios');
  const out = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || !existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== 'Pods' && e.name !== 'build') walk(f, depth + 1);
      else if (e.name === 'Package.resolved') {
        for (const p of (JSON.parse(readFileSync(f, 'utf8')) as { pins?: { identity?: string }[] }).pins ?? []) if (p.identity) out.add(p.identity);
      }
    }
  };
  walk(ios, 0);
  return [...out].sort();
}

/** F-1221 (a): the Swift packages every Xcode project under apps/tech-native/ios declares (the app's and the Pods project, where a pod's package lands), and how many projects were read. */
function findSwiftDeclared(root: string): { packages: string[]; projects: number } {
  const ios = path.join(root, 'apps', 'tech-native', 'ios');
  const out = new Set<string>();
  let projects = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || !existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory() && e.name.endsWith('.xcodeproj')) {
        const pbx = path.join(f, 'project.pbxproj');
        if (existsSync(pbx)) {
          projects += 1;
          for (const id of declaredSwiftPackages(readFileSync(pbx, 'utf8'))) out.add(id);
        }
      } else if (e.isDirectory() && e.name !== 'build' && e.name !== 'map-assets') walk(f, depth + 1);
    }
  };
  walk(ios, 0);
  return { packages: [...out].sort(), projects };
}

function main(): void {
  const args = process.argv.slice(2);
  const mode = args.find((a) => ['inventory', 'ios', 'pods', 'all'].includes(a)) ?? 'all';
  const fx = args.includes('--fixture') ? args[args.indexOf('--fixture') + 1] : undefined;
  const root = realpathSync(process.env.CI_ROOT ? path.resolve(process.env.CI_ROOT) : path.resolve(import.meta.dirname, '..'));
  const policy = loadPolicy(root);
  const read = (f: string): unknown => JSON.parse(readFileSync(path.join(fx as string, f), 'utf8'));
  const failures: string[] = [];
  const lines: string[] = [];
  // A fixture may carry its own lockfile snapshots (snapshots.yaml); with none, the fixture has no optional edges.
  const snapshotsOf = (): Snapshots => {
    const f = fx ? path.join(fx, 'snapshots.yaml') : path.join(root, 'pnpm-lock.yaml');
    return !fx || existsSync(f) ? lockfileSnapshots(readFileSync(f, 'utf8')) : {};
  };
  if (mode === 'inventory' || mode === 'all') {
    const all = fx ? flatten(read('all.json')) : flatten(pnpmJson(root, ['-r', 'licenses', 'list', '--json']));
    const prod = fx ? flatten(read('shipped.json')) : prodClosure(root, policy.shippedRoots, policy);
    const lockSnapshots = snapshotsOf();
    const server = [...prod, ...optionalShipped(prod, all, lockSnapshots)];
    if (!fx) failures.push(...missingRoots(policy.shippedRoots, workspace(root, policy)));
    const nativeFile = fx ? path.join(fx, 'autolinked.json') : '';
    const resolved: unknown = fx ? (existsSync(nativeFile) ? JSON.parse(readFileSync(nativeFile, 'utf8')) : null) : exportAutolinked(root, policy);
    const native = resolved === null ? [] : autolinkedPackages(resolved);
    if (!fx) {
      const own = path.join(root, policy.bundleApp.dir, 'modules');
      failures.push(...autolinkedProblems(resolved, policy.autolinkedFloor, new Set(existsSync(own) ? readdirSync(own) : [])));
    }
    const srcFile = fx ? path.join(fx, 'bundle-sources.json') : '';
    const sources = fx ? (existsSync(srcFile) ? (JSON.parse(readFileSync(srcFile, 'utf8')) as string[]) : []) : exportBundleSources(root, policy);
    const bundle = bundleShipped(sources, all, native);
    const shipped = [...server, ...bundle.shipped];
    failures.push(...bundle.failures);
    const verified = (JSON.parse(readFileSync(path.join(root, 'ci', 'license', 'build-verified.json'), 'utf8')) as { entries: Verified[] }).entries;
    let merged: ReadonlySet<string> = new Set();
    if (fx) {
      const mf = path.join(fx, 'merged.json');
      if (existsSync(mf)) merged = new Set(JSON.parse(readFileSync(mf, 'utf8')) as string[]);
    } else if (verified.some((v) => v.owner)) {
      const ref = resolveMainRef(root);
      if (!ref || isShallow(root)) throw new Error('the owning tasks of PENDING entries cannot be read: no integration branch, or a shallow clone');
      merged = mergedTasks(root, ref);
    }
    const r = inventory(all, shipped, policy, verified, merged, new Set(bundle.shipped.map((p) => `${p.name}@${p.version}`)));
    failures.push(...r.failures);
    if (!fx) {
      failures.push(...licenseFileProblems(verified, (f) => (existsSync(path.join(root, 'ci', 'license', f)) ? readFileSync(path.join(root, 'ci', 'license', f), 'utf8') : null)));
      failures.push(...floorProblems(bundle.shipped.length, policy.bundleFloor));
    }
    lines.push(`license-inventory: ${server.length} packages in the server and web closure (roots ${policy.shippedRoots.join(', ')})`);
    lines.push(`license-inventory: ${bundle.shipped.length} packages in the iPhone app's Metro bundle and native modules (from ${sources.length} source-map sources and ${native.length} autolinked native modules)`, ...r.lines);
  }
  if (mode === 'ios' || mode === 'all') {
    // F-1266 (a): the iPhone closure is walked over optional edges as the server's is (pnpm licenses list --prod leaves them out).
    const iosProd = fx ? flatten(read('ios.json')) : prodClosure(root, policy.iosRoots, policy);
    const installedAll = fx ? (existsSync(path.join(fx, 'all.json')) ? flatten(read('all.json')) : []) : flatten(pnpmJson(root, ['-r', 'licenses', 'list', '--json']));
    const ios = [...iosProd, ...optionalShipped(iosProd, installedAll, snapshotsOf())];
    if (!fx) failures.push(...missingRoots(policy.iosRoots, workspace(root, policy)));
    const r = iosCopyleft(ios, fx ? [] : findAcks(root));
    failures.push(...r.failures);
    lines.push(...r.lines);
  }
  if (mode === 'pods') {
    const verified = (JSON.parse(readFileSync(path.join(root, 'ci', 'license', 'build-verified.json'), 'utf8')) as { entries: Verified[] }).entries;
    const iosDir = path.join(root, 'apps', 'tech-native', 'ios');
    const lockFile = path.join(iosDir, 'Podfile.lock');
    const declared = findSwiftDeclared(root);
    // The Swift packages are the ones the projects declare, which exist at prebuild time, plus any Package.resolved pins (F-1221 a).
    const swift = [...new Set([...declared.packages, ...findSwiftPins(root)])].sort();
    // The first-party test is file identity under the repo root, as render-session.sh's guard is (F-1352): realpath, not text.
    const inRepo = (p: string): boolean => {
      const abs = path.resolve(iosDir, p);
      const real = existsSync(abs) ? realpathSync(abs) : abs;
      return real === root || real.startsWith(`${root}${path.sep}`);
    };
    const pods = existsSync(lockFile) ? parsePodfileLock(readFileSync(lockFile, 'utf8'), inRepo) : null;
    const r = podsProblems(findAcks(root), swift, verified.map((v) => v.package), pods);
    if (declared.projects === 0) failures.push('ios-bundle-copyleft: FAIL no Xcode project (project.pbxproj) under apps/tech-native/ios, so the Swift packages the app links are not known; run xcuitest/prebuild.sh first (F-1221)');
    if (pods === null) failures.push('ios-bundle-copyleft: FAIL no Podfile.lock under apps/tech-native/ios, so the pods the app links are not known; run xcuitest/prebuild.sh first (F-1221)');
    failures.push(...r.failures);
    lines.push(...r.lines);
  }
  lines.forEach((l) => console.log(l));
  failures.forEach((f) => console.error(f));
  process.exit(failures.length > 0 ? 1 : 0);
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`license-gates: cannot judge: ${(e as Error).message}`);
    process.exit(2);
  }
}
