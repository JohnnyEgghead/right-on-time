// SPDX-License-Identifier: AGPL-3.0-or-later
// publish-assets (P8-PUBLISH; FR-DIST-1, design rule D7): the release data files of a public tag, as its 2 manifests name them.
// scripts/publish.sh runs it; it never reads the network.
//   node scripts/publish-assets.ts rewrite <export dir> <slug> <tag>
//        both manifests in an export (the map files and the street list) name <slug> and <tag> for every asset
//   node scripts/publish-assets.ts check <slug> <tag> <maps manifest> <street manifest> <data dir>
//        every asset names <slug> and <tag>, and its local file (<data>/maps/<name>, <data>/<name> for the street list) has the
//        manifest's size and SHA-256; prints each file's path, 1 per line. Exit 1 on any difference, before anything is uploaded.
//   node scripts/publish-assets.ts compare <maps manifest> <street manifest> <releases json> <tag>
//        the release of <tag> in a GitHub releases listing (gh api --paginate --slurp repos/<slug>/releases: its pages, F-1683; a
//        single page is read too) against the manifests: prints
//        "ok|missing|differs|extra <name>" and "release none|draft|published"; exit 0 only when every asset is ok (uploaded, same size,
//        digest sha256:<manifest sha>) and nothing extra is attached.
//   node scripts/publish-assets.ts carry <base ls-tree> <list>
//        the entries of the public main (a `git ls-tree -r -z` listing) whose path the export does not hold, as NUL-ended index lines
//        for `git update-index -z --index-info`: a file only the public repo has (PUBLIC_ONLY, its CONTRIBUTING.md) is kept, never
//        deleted by a release; F-1682: any other public main path the export lacks is not carried
//   node scripts/publish-assets.ts dropped <base ls-tree> <list>
//        the public main's paths the release drops (not in the export, not PUBLIC_ONLY), 1 per line, sorted
//   node scripts/publish-assets.ts same-tree <private ls-tree> <public ls-tree> <list> [<base ls-tree>]
//        the public tree holds exactly the paths of <list> (the export) plus the carried ones, every export path but the 2 manifests is
//        the private tree's blob, mode and all, and every carried path is the public main's own entry
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMain } from '../ci/is-main.ts';

export const MANIFESTS = { maps: 'packages/maps/MANIFEST.json', street: 'packages/db/src/data-manifest.json' } as const;

export interface Asset {
  asset: string;
  repo: string;
  tag: string;
  bytes: number;
  sha256: string;
  /** Where the file sits under the data dir: maps/<name> for the map files, <name> for the street list. */
  rel: string;
}

interface Manifest {
  assets: { asset: string; repo: string; tag: string; bytes: number; sha256: string }[];
}

const parse = (text: string, what: string): Manifest => {
  const m = JSON.parse(text) as Manifest;
  if (!Array.isArray(m.assets) || m.assets.length === 0) throw new Error(`${what} has no assets`);
  return m;
};

/** Every release asset of the 2 manifests, map files first. A name used twice is refused (1 release holds 1 asset per name). */
export function assetsOf(mapsText: string, streetText: string): Asset[] {
  const out: Asset[] = [];
  for (const [text, what, dir] of [[mapsText, MANIFESTS.maps, 'maps/'], [streetText, MANIFESTS.street, '']] as const) {
    for (const a of parse(text, what).assets) out.push({ asset: a.asset, repo: a.repo, tag: a.tag, bytes: a.bytes, sha256: a.sha256, rel: dir + a.asset });
  }
  const seen = new Set<string>();
  for (const a of out) {
    if (seen.has(a.asset)) throw new Error(`asset name ${a.asset} is named twice`);
    seen.add(a.asset);
  }
  return out;
}

/** The manifest text with every asset's repo and tag set; the rest kept, in the committed layout (2 spaces, a final newline). */
export function rewriteManifest(text: string, slug: string, tag: string): string {
  const m = parse(text, 'manifest') as Manifest & Record<string, unknown>;
  for (const a of m.assets) {
    a.repo = slug;
    a.tag = tag;
  }
  return JSON.stringify(m, null, 2) + '\n';
}

export const TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
export const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const sha256File = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });

/** The problems with the local data for these assets (empty = every file is there with the manifest's size and SHA-256). */
export async function checkData(assets: Asset[], slug: string, tag: string, data: string): Promise<string[]> {
  const bad: string[] = [];
  for (const a of assets) {
    if (a.repo !== slug || a.tag !== tag) bad.push(`${a.asset}: the manifest names ${a.repo} ${a.tag}, not ${slug} ${tag}`);
    const f = path.join(data, a.rel);
    if (!existsSync(f)) {
      bad.push(`${a.asset}: no file ${f}`);
      continue;
    }
    const size = statSync(f).size;
    if (size !== a.bytes) {
      bad.push(`${a.asset}: ${size} bytes, the manifest says ${a.bytes}`);
      continue;
    }
    const got = await sha256File(f);
    if (got !== a.sha256) bad.push(`${a.asset}: SHA-256 ${got}, the manifest says ${a.sha256}`);
  }
  return bad;
}

interface GhRelease {
  tag_name: string;
  draft: boolean;
  assets: { name: string; size: number; state: string; digest?: string | null }[];
}

export interface Comparison {
  release: 'none' | 'draft' | 'published';
  lines: string[];
  missing: string[];
  differs: string[];
  extra: string[];
  ok: boolean;
}

/** F-1683: a releases listing, as 1 page (an array of releases) or as the pages of gh api --paginate --slurp (an array of those). */
export function releasesOf(text: string): GhRelease[] {
  const v = JSON.parse(text) as unknown;
  if (!Array.isArray(v)) throw new Error('the releases listing is not a JSON array');
  return (v as (GhRelease | GhRelease[])[]).flat();
}

/** The release of `tag` in a releases listing against the manifests' assets. */
export function compareRelease(assets: Asset[], releases: GhRelease[], tag: string): Comparison {
  const rel = releases.find((r) => r.tag_name === tag);
  const c: Comparison = { release: rel ? (rel.draft ? 'draft' : 'published') : 'none', lines: [], missing: [], differs: [], extra: [], ok: false };
  const have = new Map((rel?.assets ?? []).map((x) => [x.name, x]));
  for (const a of assets) {
    const x = have.get(a.asset);
    if (!x) {
      c.missing.push(a.asset);
      c.lines.push(`missing ${a.asset}`);
    } else if (x.state !== 'uploaded' || x.size !== a.bytes || x.digest !== `sha256:${a.sha256}`) {
      c.differs.push(a.asset);
      c.lines.push(`differs ${a.asset} (state ${x.state}, ${x.size} bytes, digest ${x.digest ?? 'none'})`);
    } else c.lines.push(`ok ${a.asset}`);
  }
  const names = new Set(assets.map((a) => a.asset));
  for (const n of have.keys()) {
    if (!names.has(n)) {
      c.extra.push(n);
      c.lines.push(`extra ${n}`);
    }
  }
  c.lines.push(`release ${c.release}`);
  c.ok = c.release !== 'none' && c.missing.length === 0 && c.differs.length === 0 && c.extra.length === 0;
  return c;
}

/** `git ls-tree -r -z` output as path -> "mode sha". */
export function lsTree(z: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of z.split('\0')) {
    if (!e) continue;
    const tab = e.indexOf('\t');
    const [mode, , sha] = e.slice(0, tab).split(' ');
    m.set(e.slice(tab + 1), `${mode} ${sha}`);
  }
  return m;
}

/**
 * F-1682: the files only the public repo has, by name (SPECIFICATIONS section 6.13 FR-DIST-9: the owner's CONTRIBUTING.md). A release
 * keeps these from the public main when the export lacks them; every other path of the public main that the export lacks is dropped.
 */
export const PUBLIC_ONLY: readonly string[] = ['CONTRIBUTING.md'];

/** The public main's PUBLIC_ONLY entries whose path the export does not hold (kept in the release commit, never deleted by it). */
export function carried(base: Map<string, string>, list: string[]): Map<string, string> {
  const want = new Set(list);
  return new Map([...base].filter(([p]) => !want.has(p) && PUBLIC_ONLY.includes(p)));
}

/** F-1682: the public main's paths the release drops: not in the export and not carried (deleted, renamed or made private since). */
export function dropped(base: Map<string, string>, list: string[]): string[] {
  const want = new Set(list);
  return [...base.keys()].filter((p) => !want.has(p) && !PUBLIC_ONLY.includes(p)).sort();
}

/** The problems of a public tree against the private one, the export list and the carried entries (empty = it is exactly that). */
export function sameTree(priv: Map<string, string>, pub: Map<string, string>, list: string[], carry: Map<string, string> = new Map()): string[] {
  const bad: string[] = [];
  const want = new Set(list);
  for (const p of want) if (!pub.has(p)) bad.push(`the public tree lacks ${p}`);
  for (const [p, e] of carry) if (pub.get(p) !== e) bad.push(`${p} is ${pub.get(p) ?? 'absent'} in the public tree, ${e} on the public main (carried)`);
  for (const p of pub.keys()) if (!want.has(p) && !carry.has(p)) bad.push(`the public tree holds ${p}, which the export does not`);
  const manifests = new Set<string>(Object.values(MANIFESTS));
  for (const [p, e] of pub) {
    if (manifests.has(p) || !want.has(p)) continue;
    if (priv.get(p) !== e) bad.push(`${p} is ${e} in the public tree, ${priv.get(p) ?? 'absent'} in the private one`);
  }
  return bad;
}

if (isMain(import.meta.url)) {
  const [cmd, ...a] = process.argv.slice(2);
  try {
    if (cmd === 'rewrite' && a.length === 3) {
      const [dir, slug, tag] = a as [string, string, string];
      if (!SLUG_RE.test(slug) || !TAG_RE.test(tag)) throw new Error(`bad slug or tag: ${slug} ${tag}`);
      let n = 0;
      for (const rel of Object.values(MANIFESTS)) {
        const f = path.join(dir, rel);
        if (!existsSync(f)) throw new Error(`the export has no ${rel}`);
        const text = rewriteManifest(readFileSync(f, 'utf8'), slug, tag);
        writeFileSync(f, text);
        n += (JSON.parse(text) as Manifest).assets.length;
      }
      console.log(`publish: the 2 data manifests name ${slug} release ${tag} for all ${n} assets`);
    } else if (cmd === 'check' && a.length === 5) {
      const [slug, tag, maps, street, data] = a as [string, string, string, string, string];
      const assets = assetsOf(readFileSync(maps, 'utf8'), readFileSync(street, 'utf8'));
      const bad = await checkData(assets, slug, tag, data);
      if (bad.length) {
        for (const b of bad) console.error(`publish: FAIL release data ${b}`);
        process.exit(1);
      }
      for (const x of assets) console.log(path.join(data, x.rel));
    } else if (cmd === 'compare' && a.length === 4) {
      const [maps, street, rels, tag] = a as [string, string, string, string];
      const c = compareRelease(assetsOf(readFileSync(maps, 'utf8'), readFileSync(street, 'utf8')), releasesOf(readFileSync(rels, 'utf8')), tag);
      console.log(c.lines.join('\n'));
      process.exit(c.ok ? 0 : 1);
    } else if (cmd === 'carry' && a.length === 2) {
      const [base, list] = a as [string, string];
      for (const [p, e] of carried(lsTree(readFileSync(base, 'utf8')), readFileSync(list, 'utf8').split('\n').filter(Boolean))) {
        const [mode, sha] = e.split(' ');
        process.stdout.write(`${mode} ${sha}\t${p}\0`);
      }
    } else if (cmd === 'dropped' && a.length === 2) {
      const [base, list] = a as [string, string];
      for (const p of dropped(lsTree(readFileSync(base, 'utf8')), readFileSync(list, 'utf8').split('\n').filter(Boolean))) console.log(p);
    } else if (cmd === 'same-tree' && (a.length === 3 || a.length === 4)) {
      const [priv, pub, list, base] = a as [string, string, string, string | undefined];
      const exported = readFileSync(list, 'utf8').split('\n').filter(Boolean);
      const carry = base ? carried(lsTree(readFileSync(base, 'utf8')), exported) : new Map<string, string>();
      const bad = sameTree(lsTree(readFileSync(priv, 'utf8')), lsTree(readFileSync(pub, 'utf8')), exported, carry);
      for (const b of bad.slice(0, 20)) console.error(`publish: FAIL ${b}`);
      if (bad.length) process.exit(1);
    } else {
      console.error('usage: node scripts/publish-assets.ts rewrite <dir> <slug> <tag> | check <slug> <tag> <maps> <street> <data> | compare <maps> <street> <releases json> <tag> | carry <base> <list> | dropped <base> <list> | same-tree <private> <public> <list> [<base>]');
      process.exit(2);
    }
  } catch (e) {
    console.error(`publish: FAIL ${(e as Error).message}`);
    process.exit(1);
  }
}
