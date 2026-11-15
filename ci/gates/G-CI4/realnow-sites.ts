// SPDX-License-Identifier: AGPL-3.0-or-later
// The realNow call-site listing (P2-TIME; SPECIFICATIONS section 11.3: "CI lists every realNow call site with its use
// tag"). Every call of realNow outside the seam must name 1 use tag of section 11.3 as a string literal, so the
// listing can say why each real-time reading exists. It fails:
//   - a tag outside section 11.3 (an unlisted tag),
//   - a tag that is not a string literal (a variable, a template with expressions): the listing cannot name it,
//   - realNow used as a value or re-exported (passed along, it is called where no listing sees it),
//   - computed access (x['realNow']).
// Reading the API's realNow field by destructuring ({ realNow } = answer, { realNow: serverReal } = answer) is a field read,
// not a clock call (F-939), so it passes; a local name it binds is checked where it is called, like realNow itself. When the
// destructured value is typed Clock the name is the clock's method, so any use of it other than a call is "used as a value" (F-982).
// Recognized calls: realNow(...), an import alias of it (import { realNow as rn }), and any x.realNow(...) (a Clock).
// The seam (packages/time/src) is listed too (F-179): a call there that passes a literal tag is a site. Only a call whose
// argument is the enclosing function's own `use` parameter (a forwarder) and the seam's test files are skipped.
//   node ci/gates/G-CI4/realnow-sites.ts           the real tree: print the listing, exit 1 on any problem
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { REAL_TIME_USES } from '../../../packages/time/src/uses.ts';

export interface Site {
  file: string;
  line: number;
  column: number;
  tag: string;
}

export interface Scan {
  sites: Site[];
  problems: string[];
}

const USES: ReadonlySet<string> = new Set(REAL_TIME_USES);
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SEAM = 'packages/time/src/';

export function isSeamFile(file: string): boolean {
  return file.startsWith(SEAM);
}

/** The seam's own tests plant bad tags on purpose (clock.test.ts), so they are not scanned. */
export function isSeamTestFile(file: string): boolean {
  return isSeamFile(file) && /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function scriptKind(file: string): ts.ScriptKind {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const isDeclarationName = (id: ts.Identifier): boolean => {
  const p = id.parent;
  return (
    (ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isPropertyDeclaration(p)) &&
    p.name === id
  );
};

export function scanSource(text: string, file: string): Scan {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const sites: Site[] = [];
  const problems: string[] = [];
  const at = (n: ts.Node) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    return { line: line + 1, column: character + 1 };
  };
  const where = (n: ts.Node) => {
    const p = at(n);
    return `${file}:${p.line}:${p.column}`;
  };

  // Local names bound to realNow by an import, including renames.
  const names = new Set<string>(['realNow']);
  sf.forEachChild((n) => {
    if (!ts.isImportDeclaration(n) || !n.importClause?.namedBindings) return;
    const b = n.importClause.namedBindings;
    if (!ts.isNamedImports(b)) return;
    for (const el of b.elements) if ((el.propertyName ?? el.name).text === 'realNow') names.add(el.name.text);
  });

  // F-939: local names bound to a realNow field by object destructuring; a call of one is checked like a realNow call.
  const fieldNames = new Set<string>();
  const isFieldBinding = (p: ts.Node, n: ts.Node): p is ts.BindingElement =>
    ts.isBindingElement(p) && ts.isObjectBindingPattern(p.parent) && (p.propertyName === n || (p.propertyName === undefined && p.name === n));
  // F-982: a field name bound out of a value typed Clock is the clock's method itself, so passing it along (f(x), return x) escapes the
  // listing; a field of any other source (the API's answer, a string) is plain data. The type is read from the declaration's annotation.
  const clockFields = new Set<string>();
  const CLOCK_TYPE = /\bClock\b/;
  const declaredAsClock = (id: ts.Identifier): boolean => {
    for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
      const decls: ts.Node[] = [];
      if (ts.isFunctionLike(p)) decls.push(...p.parameters);
      if (ts.isBlock(p) || ts.isSourceFile(p)) for (const st of p.statements) if (ts.isVariableStatement(st)) decls.push(...st.declarationList.declarations);
      for (const d of decls) {
        if ((ts.isParameter(d) || ts.isVariableDeclaration(d)) && ts.isIdentifier(d.name) && d.name.text === id.text) return d.type !== undefined && CLOCK_TYPE.test(d.type.getText(sf));
      }
    }
    return false;
  };
  const patternIsClock = (pattern: ts.ObjectBindingPattern): boolean => {
    const d = pattern.parent;
    if (!ts.isParameter(d) && !ts.isVariableDeclaration(d)) return false;
    if (d.type !== undefined && CLOCK_TYPE.test(d.type.getText(sf))) return true;
    const init = ts.isVariableDeclaration(d) ? unwrapInit(d.initializer) : undefined;
    return init !== undefined && ts.isIdentifier(init) && declaredAsClock(init);
  };
  const unwrapInit = (e: ts.Expression | undefined): ts.Expression | undefined => {
    while (e && (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e))) e = e.expression;
    return e;
  };
  const collectFields = (n: ts.Node): void => {
    if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) && ts.isIdentifier(n.name)) {
      const key = n.propertyName ?? n.name;
      const keyName = ts.isIdentifier(key) ? key.text : ts.isComputedPropertyName(key) && ts.isStringLiteralLike(key.expression) ? key.expression.text : null;
      if (keyName === 'realNow' && n.name.text !== 'realNow') {
        fieldNames.add(n.name.text);
        if (patternIsClock(n.parent)) clockFields.add(n.name.text);
      }
    }
    ts.forEachChild(n, collectFields);
  };
  collectFields(sf);

  // A cast does not change the tag: realNow('wall_clock' as never) still names wall_clock.
  const unwrap = (e: ts.Expression | undefined): ts.Expression | undefined => {
    while (e && (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e))) {
      e = e.expression;
    }
    return e;
  };
  const isEnclosingParameter = (n: ts.Node, name: string): boolean => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isFunctionLike(p)) return p.parameters.some((x) => ts.isIdentifier(x.name) && x.name.text === name);
    }
    return false;
  };
  const checkCall = (call: ts.CallExpression) => {
    const arg = unwrap(call.arguments[0]);
    if (isSeamFile(file) && arg && ts.isIdentifier(arg) && isEnclosingParameter(call, arg.text)) return; // a forwarder
    const pos = at(call);
    if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
      if (USES.has(arg.text)) sites.push({ file, ...pos, tag: arg.text });
      else problems.push(`${where(call)}: realNow tag '${arg.text}' is not a real-time use of SPECIFICATIONS section 11.3`);
    } else {
      problems.push(`${where(call)}: realNow tag is not a string literal, so the listing cannot name its use`);
    }
  };

  const visit = (n: ts.Node): void => {
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === 'realNow') {
      problems.push(`${where(n)}: computed access to realNow; call it as realNow('<use>') or clock.realNow('<use>')`);
    } else if (ts.isIdentifier(n) && names.has(n.text)) {
      const p = n.parent;
      if (ts.isImportSpecifier(p) || ts.isImportClause(p)) {
        // the binding itself
      } else if (ts.isExportSpecifier(p)) {
        if (!isSeamFile(file)) problems.push(`${where(n)}: realNow is re-exported outside @bw/time; call sites must be listed where they are`);
      } else if (isFieldBinding(p, n)) {
        // a field read of the API's answer (F-939)
      } else if (isDeclarationName(n)) {
        // a Clock implementation's method name; its body is scanned like any code
      } else if (ts.isCallExpression(p) && p.expression === n) {
        checkCall(p);
      } else if (ts.isPropertyAccessExpression(p) && p.name === n) {
        if (n.text !== 'realNow') return ts.forEachChild(n, visit); // an alias name is not a property
        const gp = p.parent;
        if (ts.isCallExpression(gp) && gp.expression === p) checkCall(gp);
        else problems.push(`${where(n)}: realNow is used as a value; call it with its use tag where the reading happens`);
      } else if (ts.isPropertyAssignment(p) && p.name === n) {
        // an object key named realNow: its value is scanned
      } else {
        problems.push(`${where(n)}: realNow is used as a value; call it with its use tag where the reading happens`);
      }
    } else if (ts.isIdentifier(n) && fieldNames.has(n.text) && ts.isCallExpression(n.parent) && n.parent.expression === n) checkCall(n.parent);
    else if (ts.isIdentifier(n) && clockFields.has(n.text) && !isFieldBinding(n.parent, n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) {
      problems.push(`${where(n)}: realNow is used as a value; call it with its use tag where the reading happens`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { sites, problems };
}

export function trackedSources(root: string): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', 'apps', 'packages'], { cwd: root, encoding: 'utf8' });
  return out
    .split('\0')
    .filter((f) => f !== '' && SOURCE.test(f) && !f.includes('/node_modules/') && !isSeamTestFile(f));
}

export function scanTree(root: string): Scan {
  const all: Scan = { sites: [], problems: [] };
  for (const f of trackedSources(root)) {
    const text = readFileSync(path.join(root, f), 'utf8');
    if (!text.includes('realNow')) continue;
    const s = scanSource(text, f);
    all.sites.push(...s.sites);
    all.problems.push(...s.problems);
  }
  return all;
}

export function formatListing(scan: Scan): string {
  const lines = scan.sites.map((s) => `${s.file}:${s.line}:${s.column} ${s.tag}`);
  return [`realnow-sites: ${scan.sites.length} call sites`, ...lines].join('\n');
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, '..', '..', '..');
  const scan = scanTree(root);
  console.log(formatListing(scan));
  for (const p of scan.problems) console.error(`realnow-sites: FAIL ${p}`);
  if (scan.problems.length > 0) process.exit(1);
  console.log('realnow-sites: ok');
}
