// SPDX-License-Identifier: AGPL-3.0-or-later
// The native app's catalog subset (F-1199; FR-IOS-4, SPECIFICATIONS 6.12 "No demo wording"): the native build ships only the catalog
// keys native code can show, never the whole shared catalog (whose office and demo-world words the app never draws).
//   node ci/native/catalog-subset.ts --check   exit 0 when apps/tech-native/src/ui/catalog-native.json is exactly the derivation, 1 otherwise
//   node ci/native/catalog-subset.ts --write   rewrite that file from the derivation (run it after native code adds or drops a key)
// The derivation is mechanical, over the native app's import graph (apps/tech-native/index.ts and every file it reaches, through relative
// and @bw/* workspace imports; type-only imports carry no words and are not followed):
//   1. every string literal in the graph that is a catalog key;
//   2. every catalog key under the static head of a template literal (`customers.status.${s}` takes every customers.status.* key);
//   3. the keys of DATA_KEYS: a key that arrives as data (an API field such as serviceLabelKey) has no literal in the code, so its
//      family is declared here, by the field that carries it.
// It fails (so --check and its test fail) when native code can name a key outside the subset by a route the derivation cannot see:
//   - a cast to MessageKey (or to never or any as a call's first argument, to keyof typeof anything, or to a type alias of those in the
//     same file) of anything but a literal, unless the cast reads a field DATA_KEYS lists (F-1212);
//   - a formatMessage({ id }) whose id is no literal, outside FORMAT_ID_FILES: react-intl types id as a string, so the id reaches the
//     catalog unseen (F-1212);
//   - a value import of the full catalog (@bw/i18n/src/catalog.ts) anywhere in the graph, which would ship every key again.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { isMain } from '../is-main.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const ENTRY = 'apps/tech-native/index.ts';
export const OUT = 'apps/tech-native/src/ui/catalog-native.json';
const FULL_CATALOG = 'packages/i18n/src/catalog.ts';

/**
 * Keys that arrive as data. Each field (or local name) names the catalog family its values come from (packages/api contracts: the
 * server sends a catalog key, the app draws its words). A cast of one of these names is the only non-literal route to a key the check
 * accepts; a new one is added here with its family, in the same change as the code that casts it.
 */
export const DATA_KEYS: Record<string, string> = {
  serviceLabelKey: 'service.', // a job's service (booking and day contracts)
  serviceKey: 'service.', // the same field, passed on (mapme/model.ts distText)
  reasonKey: 'text_reason.', // outbox_text.reason_key (packages/i18n/src/text-rows.ts reasonText)
  skillKey: 'tech.me.skill.', // the technician's skill, built from the day's technician.skill (mapme/MeTab.tsx)
};

/** The files that pass a non-literal id to formatMessage, and why each is safe: intl.tsx is the t() wrapper (its key is typed MessageKey); Forgot.tsx reads the key of RESULT, a table of MessageKey literals (forgot-model.ts). */
export const FORMAT_ID_FILES: readonly string[] = ['apps/tech-native/src/ui/intl.tsx', 'apps/tech-native/src/screens/Forgot.tsx'];

export interface Finding { file: string; line: number; what: string }
export interface Derivation { keys: string[]; files: string[]; findings: Finding[] }

type Cat = Record<string, string>;

function readJson(file: string): Cat {
  return JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')) as Cat;
}

function isFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile();
}

/** A specifier's file, for relative and @bw/* workspace imports; null for a package outside the workspace or a non-code file. */
export function resolveSpec(fromFile: string, spec: string, root: string = ROOT): string | null {
  let base: string;
  if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith('@bw/')) {
    const [, name, ...rest] = spec.split('/');
    const pkg = path.join(root, 'packages', name as string);
    if (rest.length === 0) {
      const main = (JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8')) as { main?: string }).main ?? 'src/index.ts';
      base = path.join(pkg, main);
    } else base = path.join(pkg, ...rest);
  } else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (isFile(c) && /\.(ts|tsx)$/.test(c)) return c;
  }
  return null;
}

function typeOnlyImport(n: ts.ImportDeclaration): boolean {
  const c = n.importClause;
  if (!c) return false; // a side-effect import runs code
  if (c.isTypeOnly) return true;
  if (c.name) return false;
  const b = c.namedBindings;
  if (!b) return false;
  if (ts.isNamespaceImport(b)) return false;
  return b.elements.length > 0 && b.elements.every((e) => e.isTypeOnly);
}

function isKeyCastType(t: ts.TypeNode, aliases: ReadonlySet<string> = new Set()): 'key' | 'loose' | null {
  if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && (t.typeName.text === 'MessageKey' || aliases.has(t.typeName.text))) return 'key';
  if (ts.isTypeOperatorNode(t) && t.operator === ts.SyntaxKind.KeyOfKeyword) return 'key';
  if (t.kind === ts.SyntaxKind.NeverKeyword || t.kind === ts.SyntaxKind.AnyKeyword) return 'loose';
  return null;
}

/** The field a cast reads (`j.serviceLabelKey` and `serviceKey` give the last name), or null. */
function fieldOf(e: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) return fieldOf(e.expression);
  return null;
}

/** The derivation over the graph from `entry`, against the catalog key set `keys` (the en catalog's keys). */
export function derive(keys: readonly string[], root: string = ROOT, entry: string = ENTRY): Derivation {
  const keySet = new Set(keys);
  const used = new Set<string>();
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const queue = [path.join(root, entry)];
  const fullCatalog = path.join(root, FULL_CATALOG);
  const family = (head: string) => {
    for (const k of keys) if (k.startsWith(head)) used.add(k);
  };
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = path.relative(root, file);
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    // F-1212: a type alias in this file whose target is a key type (type K = MessageKey; type K = keyof typeof c) is a key type.
    const aliases = new Set<string>();
    for (const st of sf.statements) {
      if (ts.isTypeAliasDeclaration(st) && st.name.text !== 'MessageKey' && isKeyCastType(st.type, aliases) === 'key') aliases.add(st.name.text);
    }
    const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const follow = (spec: string, n: ts.Node) => {
      const to = resolveSpec(file, spec, root);
      if (!to) return;
      if (to === fullCatalog) {
        findings.push({ file: rel, line: at(n), what: `value import of the full catalog (${spec}): every key would ship` });
        return;
      }
      queue.push(to);
    };
    const visit = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
        if (!typeOnlyImport(n)) follow(n.moduleSpecifier.text, n);
        return;
      }
      if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        if (!n.isTypeOnly) follow(n.moduleSpecifier.text, n);
        return;
      }
      if (ts.isCallExpression(n) && n.arguments.length > 0 && ts.isStringLiteralLike(n.arguments[0] as ts.Expression)) {
        const callee = n.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
          follow((n.arguments[0] as ts.StringLiteralLike).text, n);
        }
      }
      if (ts.isCallExpression(n) && !FORMAT_ID_FILES.includes(rel.split(path.sep).join('/'))) {
        const callee = n.expression;
        const arg = n.arguments[0];
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'formatMessage' && arg !== undefined && ts.isObjectLiteralExpression(arg)) {
          for (const prop of arg.properties) {
            const named = (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) && prop.name.getText(sf) === 'id';
            const init = ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
            if (named && !(init !== undefined && (ts.isStringLiteralLike(init) || ts.isTemplateExpression(init) || ts.isAsExpression(init)))) {
              findings.push({ file: rel, line: at(n), what: 'a formatMessage id that is no literal: react-intl types id as a string, so the subset cannot see it' });
            }
          }
        }
      }
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        if (keySet.has(n.text)) used.add(n.text);
      } else if (ts.isTemplateExpression(n)) {
        const head = n.head.text;
        if (head !== '' && keys.some((k) => k.startsWith(head))) family(head);
      } else if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) {
        const kind = isKeyCastType(n.type, aliases);
        const inner = n.expression;
        const firstArg = ts.isCallExpression(n.parent) && n.parent.arguments[0] === n;
        if (kind === 'key' || (kind === 'loose' && firstArg)) {
          if (!(ts.isStringLiteralLike(inner) || ts.isTemplateExpression(inner))) {
            const f = fieldOf(inner);
            const fam = f !== null ? DATA_KEYS[f] : undefined;
            if (fam !== undefined) family(fam);
            else findings.push({ file: rel, line: at(n), what: `a key cast from ${inner.getText(sf)}: no literal and no DATA_KEYS field, so the subset cannot see it` });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { keys: [...used].sort(), files: [...seen].map((f) => path.relative(root, f)).sort(), findings };
}

/** The subset file's text: the derived keys with their en and es values, keys sorted. */
export function subsetText(keys: readonly string[], en: Cat, es: Cat): string {
  const pick = (c: Cat) => Object.fromEntries(keys.map((k) => [k, c[k] as string]));
  return `${JSON.stringify({ en: pick(en), es: pick(es) }, null, 2)}\n`;
}

function main(argv: string[]): number {
  const mode = argv[0];
  if (mode !== '--check' && mode !== '--write') {
    console.error('usage: node ci/native/catalog-subset.ts --check | --write');
    return 2;
  }
  const en = readJson('packages/i18n/catalog/en.json');
  const es = readJson('packages/i18n/catalog/es.json');
  const d = derive(Object.keys(en));
  for (const f of d.findings) console.log(`FAIL ${f.file}:${f.line} ${f.what}`);
  const want = subsetText(d.keys, en, es);
  const out = path.join(ROOT, OUT);
  if (mode === '--write') {
    if (d.findings.length > 0) return 1;
    writeFileSync(out, want);
    console.log(`catalog-subset: wrote ${OUT}, ${d.keys.length} keys from ${d.files.length} files`);
    return 0;
  }
  const have = existsSync(out) ? readFileSync(out, 'utf8') : '';
  const drift = have !== want;
  if (drift) console.log(`FAIL ${OUT} is not the derivation (run node ci/native/catalog-subset.ts --write)`);
  const ok = !drift && d.findings.length === 0;
  console.log(`catalog-subset: ${ok ? 'PASS' : 'FAIL'} ${d.keys.length} keys from ${d.files.length} files`);
  return ok ? 0 : 1;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
