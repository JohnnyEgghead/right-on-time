// SPDX-License-Identifier: AGPL-3.0-or-later
// The page sheets' screen scope (F-1896, BUILD_PLAN P9-UG-WEB; owned by the web build's CSS step).
//
// Each apps/web/styles/page-*.css is a byte copy of a kit frame page's last <style> block (UI-DESIGN-KIT 1.1) and is never
// edited, so its selectors are the frame's bare page classes (.main, .box, .win, .rlist ...). Next.js keeps a route's CSS in
// the document after a client move, so without a scope a page sheet's rules reach the next screen (F-1887: the booking
// page's .win box on the You're booked text) or a screen looks right only after a move from the page whose sheet it needs
// (F-1884: the Reassign dialog on the job page). The web build (next.config.ts, turbopack.rules) runs every page sheet
// through scopeSheet() as it bundles it, so a page sheet's rules apply only on its own screens:
//   - a rule's subject (its last compound selector) must be one of the sheet's screen roots or inside one:
//     `.win { ... }` becomes `.win:where([data-screen="SCR-CUS-01"], [data-screen="SCR-CUS-01"] *, ...) { ... }`;
//   - a rule whose subject is body or html applies only while one of its screens is shown:
//     `body { ... }` becomes `body:where(:has([data-screen="SCR-CUS-01"], ...)) { ... }`.
// :where() has 0 specificity, so the cascade among the rules that still apply is unchanged: every app sheet's adaptation
// (apps/web/styles/app/*.css) keeps winning exactly as before. A screen root is the element carrying
// data-screen="<UI-SPECIFICATION screen ID>" (apps/web/src/shell/Surface.tsx); a hosted dialog carries its own on its own
// root inside its host page, and the harness draws a hosted screen alone in a frame whose root carries its ID.
// A part of a screen drawn outside its root carries data-screen-of="<its screen ID>" instead (never data-screen, which the
// audits read as a screen root): an overlay sheet a screen opens beside its root (the tech job's photo viewer and Add photo
// sheet), a dialog drawn with no root of its own (Dialog hosted={false}), and a harness tile that draws a screen's part alone.
// The scope treats that element as one of the screen's roots, so the part keeps the rules it had before the scope.
//
// A sheet with no entry in PAGE_SCOPES fails the build (the loader throws), so a new page sheet is never shipped unscoped.

export interface SheetScope {
  /** The screens the sheet belongs to: its rules apply in these roots, and its body or html rules while one is shown. */
  readonly screens: readonly string[];
  /**
   * Hosted screens (dialogs) that other pages draw too, whose markup is styled by this sheet's rules: its rules apply
   * inside them wherever they are drawn (never its body or html rules). The module that draws them imports the sheet.
   */
  readonly shared?: readonly string[];
  /** Why the scope reaches past the sheet's own page (a finding or the frame that needs it). */
  readonly why?: string;
}

/**
 * Every page sheet's screens. Keyed by the file name under apps/web/styles/. The screens are the pages whose modules import
 * the sheet, and the hosted screens those pages draw (a hosted screen drawn alone in a harness frame is its own root).
 */
export const PAGE_SCOPES: Readonly<Record<string, SheetScope>> = {
  'page-admin-clock-app.css': { screens: ['SCR-OFC-17', 'SCR-OFC-27'] },
  'page-admin-clock.css': { screens: ['SCR-OFC-17', 'SCR-OFC-27'] },
  'page-admin-health.css': { screens: ['SCR-OFC-16'] },
  'page-admin-import-dryrun.css': { screens: ['SCR-OFC-13', 'SCR-OFC-25'] },
  'page-admin-import-duplicates.css': { screens: ['SCR-OFC-14'] },
  'page-admin-import-history.css': { screens: ['SCR-OFC-15', 'SCR-OFC-26'] },
  'page-admin-import.css': { screens: ['SCR-OFC-13', 'SCR-OFC-14', 'SCR-OFC-15', 'SCR-OFC-25', 'SCR-OFC-26'] },
  'page-admin-users.css': { screens: ['SCR-OFC-43', 'SCR-OFC-44', 'SCR-OFC-45', 'SCR-OFC-46'] },
  'page-admin-windows.css': { screens: ['SCR-OFC-12', 'SCR-OFC-24'] },
  'page-booking-done.css': { screens: ['SCR-CUS-03'] },
  'page-booking-phone.css': { screens: ['SCR-CUS-01', 'SCR-CUS-02'] },
  'page-booking-taken.css': { screens: ['SCR-CUS-01', 'SCR-CUS-02'] },
  'page-booking.css': { screens: ['SCR-CUS-01', 'SCR-CUS-02'] },
  'page-customer-live-map-ended.css': { screens: ['SCR-CUS-05'] },
  'page-customer-live-map.css': { screens: ['SCR-CUS-04', 'SCR-CUS-05'] },
  'page-customer-reschedule.css': { screens: ['SCR-CUS-06'] },
  'page-customer-texts.css': { screens: ['SCR-INB-01'] },
  'page-office-billing.css': { screens: ['SCR-OFC-10', 'SCR-OFC-22', 'SCR-OFC-47'] },
  'page-office-board-week.css': { screens: ['SCR-OFC-34'] },
  'page-office-board.css': {
    screens: ['SCR-OFC-02', 'SCR-OFC-29', 'SCR-OFC-31', 'SCR-OFC-32', 'SCR-OFC-33'],
    shared: ['SCR-OFC-18', 'SCR-OFC-19'],
    why: 'F-1884: the Reassign dialog (SCR-OFC-18) and the conflict dialog (SCR-OFC-19) are also drawn on the job page, and their rows, move preview and marks are this sheet\'s rules',
  },
  'page-office-call-list.css': { screens: ['SCR-OFC-09'] },
  'page-office-customer.css': { screens: ['SCR-OFC-06', 'SCR-OFC-39', 'SCR-OFC-40'] },
  'page-office-customers.css': { screens: ['SCR-OFC-05', 'SCR-OFC-38'] },
  'page-office-job.css': { screens: ['SCR-OFC-03', 'SCR-OFC-21', 'SCR-OFC-22', 'SCR-OFC-23', 'SCR-OFC-35', 'SCR-OFC-36', 'SCR-OFC-37'] },
  'page-office-jobs.css': { screens: ['SCR-OFC-30'] },
  'page-office-messages.css': { screens: ['SCR-OFC-08'] },
  'page-office-new-job.css': { screens: ['SCR-OFC-04'] },
  'page-office-reports.css': { screens: ['SCR-OFC-11'] },
  'page-office-signin.css': { screens: ['SCR-OFC-01'] },
  'page-office-technicians.css': { screens: ['SCR-OFC-07', 'SCR-OFC-41', 'SCR-OFC-42'] },
  'page-r1-eml-email.css': { screens: ['SCR-EML-01'] },
  'page-r1-eml-forgot.css': { screens: ['SCR-EML-03'] },
  'page-r1-eml-setpw.css': { screens: ['SCR-EML-02'] },
  'page-tech-finish.css': { screens: ['SCR-TEC-07'] },
  'page-tech-install.css': { screens: ['SCR-TEC-11'] },
  'page-tech-job.css': { screens: ['SCR-TEC-04', 'SCR-TEC-03', 'SCR-TEC-06', 'SCR-TEC-13', 'SCR-TEC-14'] },
  'page-tech-map.css': { screens: ['SCR-TEC-15', 'SCR-TEC-08'] },
  'page-tech-me.css': { screens: ['SCR-TEC-10'] },
  'page-tech-offline.css': { screens: ['SCR-TEC-05', 'SCR-TEC-09'] },
  'page-tech-parts.css': { screens: ['SCR-TEC-16'] },
  'page-tech-signin.css': { screens: ['SCR-TEC-01'] },
  'page-tech-today.css': { screens: ['SCR-TEC-02', 'SCR-TEC-03', 'SCR-TEC-13', 'SCR-TEC-14'] },
};

/** The page sheet file names this module scopes: `page-<name>.css` directly under apps/web/styles/. */
export const PAGE_SHEET_NAME = /^page-[a-z0-9-]+\.css$/;

/** A screen's roots: its screen root, and any part of it drawn outside that root (data-screen-of). */
const roots = (id: string): string[] => {
  if (!/^SCR-[A-Z]{3,4}-[0-9]{2}$/.test(id)) throw new Error(`page-scope: "${id}" is not a screen ID`);
  return [`[data-screen="${id}"]`, `[data-screen-of="${id}"]`];
};

/** The 2 suffixes a scoped rule's subject carries: `inside` (in a root) and `shown` (body or html, while a root is shown). */
function scopeSuffixes(scope: SheetScope): { inside: string; shown: string } {
  if (scope.screens.length === 0) throw new Error('page-scope: a sheet scope names no screen');
  const any = (ids: readonly string[]): string => `:is(${ids.flatMap(roots).join(', ')})`;
  const all = any([...scope.screens, ...(scope.shared ?? [])]);
  return { inside: `:where(${all}, ${all} *)`, shown: `:where(:has(${any(scope.screens)}))` };
}

// ---- A small CSS reader: comments, strings, blocks and selector lists (the page sheets use no nesting) ----

/** At-rules whose block holds style rules: scoped inside. */
const GROUPING = new Set(['media', 'supports', 'container', 'layer', 'document']);
/** At-rules whose block holds no style rule (keyframe selectors, descriptors): copied unchanged. */
const OPAQUE = new Set(['keyframes', '-webkit-keyframes', 'font-face', 'page', 'property', 'counter-style', 'font-feature-values', 'font-palette-values', 'view-transition']);

/** The index just past the string that opens at `i` (a quote character). */
function skipString(s: string, i: number): number {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q) j += s[j] === '\\' ? 2 : 1;
  return j + 1;
}

/** The index just past the comment that opens at `i` (`/*`). */
function skipComment(s: string, i: number): number {
  const end = s.indexOf('*/', i + 2);
  if (end < 0) throw new Error('page-scope: a comment is not closed');
  return end + 2;
}

/** The index of the first `stops` character at bracket depth 0 from `i`, outside strings and comments; -1 if none. */
function findTop(s: string, i: number, stops: string): number {
  let depth = 0;
  for (let j = i; j < s.length; ) {
    const c = s[j] as string;
    if (c === '"' || c === "'") j = skipString(s, j);
    else if (c === '/' && s[j + 1] === '*') j = skipComment(s, j);
    else {
      if (depth === 0 && stops.includes(c)) return j;
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      j++;
    }
  }
  return -1;
}

/** The index of the `}` that closes the block opened at `open` (a `{`). */
function blockEnd(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; ) {
    const c = s[j] as string;
    if (c === '"' || c === "'") j = skipString(s, j);
    else if (c === '/' && s[j + 1] === '*') j = skipComment(s, j);
    else {
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return j;
      j++;
    }
  }
  throw new Error('page-scope: a block is not closed');
}

const stripComments = (s: string): string => {
  let out = '';
  for (let j = 0; j < s.length; ) {
    const c = s[j] as string;
    if (c === '"' || c === "'") {
      const e = skipString(s, j);
      out += s.slice(j, e);
      j = e;
    } else if (c === '/' && s[j + 1] === '*') {
      j = skipComment(s, j);
      out += ' ';
    } else {
      out += c;
      j++;
    }
  }
  return out;
};

/** A selector list split at its top-level commas, each selector trimmed. */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let rest = stripComments(list);
  for (;;) {
    const k = findTop(rest, 0, ',');
    if (k < 0) break;
    out.push(rest.slice(0, k).trim());
    rest = rest.slice(k + 1);
  }
  out.push(rest.trim());
  if (out.some((x) => x === '')) throw new Error(`page-scope: an empty selector in "${list.trim()}"`);
  return out;
}

/** Where a complex selector's subject (its last compound selector) starts. */
function subjectStart(sel: string): number {
  let depth = 0;
  let start = 0;
  let inCombinator = false;
  for (let j = 0; j < sel.length; ) {
    const c = sel[j] as string;
    if (c === '"' || c === "'") {
      if (inCombinator && depth === 0) start = j;
      inCombinator = false;
      j = skipString(sel, j);
      continue;
    }
    if (c === '\\') {
      if (inCombinator && depth === 0) start = j;
      inCombinator = false;
      j += 2;
      continue;
    }
    if (depth === 0 && /[\s>+~]/.test(c)) inCombinator = true;
    else {
      if (inCombinator && depth === 0) start = j;
      inCombinator = false;
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
    }
    j++;
  }
  return start;
}

/** Where the subject's pseudo-element starts (`::x`, or the legacy 1-colon 4), relative to the subject; its length if none. */
function pseudoElementAt(subject: string): number {
  let depth = 0;
  for (let j = 0; j < subject.length; ) {
    const c = subject[j] as string;
    if (c === '"' || c === "'") {
      j = skipString(subject, j);
      continue;
    }
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ':' && depth === 0) {
      if (subject[j + 1] === ':') return j;
      if (/^:(before|after|first-line|first-letter)(?![\w-])/i.test(subject.slice(j))) return j;
    }
    j++;
  }
  return subject.length;
}

/** Whether a subject compound selects the document element or body (whose rules apply while a screen is shown). */
const isDocumentSubject = (subject: string): boolean => /^(html|body)(?![\w-])/i.test(subject) || /:root(?![\w-])/i.test(subject);

/** 1 complex selector with the scope suffix on its subject. */
export function scopeSelector(sel: string, scope: SheetScope): string {
  const { inside, shown } = scopeSuffixes(scope);
  const at = subjectStart(sel);
  const subject = sel.slice(at);
  const pe = at + pseudoElementAt(subject);
  return `${sel.slice(0, pe)}${isDocumentSubject(subject) ? shown : inside}${sel.slice(pe)}`;
}

type Visit = (selectors: string[], at: number) => string | void;

/** Walks a sheet's style rules (inside grouping at-rules too); `visit` may return a new prelude for a rule. */
function walk(css: string, visit: Visit, problems: string[]): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const c = css[i] as string;
    if (/\s/.test(c)) {
      out += c;
      i++;
      continue;
    }
    if (c === '/' && css[i + 1] === '*') {
      const e = skipComment(css, i);
      out += css.slice(i, e);
      i = e;
      continue;
    }
    if (c === '}') throw new Error(`page-scope: an unmatched } at ${i}`);
    const stop = findTop(css, i, c === '@' ? '{;' : '{');
    if (stop < 0) throw new Error(`page-scope: a rule with no block at ${i}`);
    const prelude = css.slice(i, stop);
    if (c === '@') {
      const name = (/^@([\w-]+)/.exec(prelude)?.[1] ?? '').toLowerCase();
      if (css[stop] === ';') {
        out += css.slice(i, stop + 1);
        i = stop + 1;
        continue;
      }
      const end = blockEnd(css, stop);
      if (GROUPING.has(name)) out += `${prelude}{${walk(css.slice(stop + 1, end), visit, problems)}}`;
      else if (OPAQUE.has(name)) out += css.slice(i, end + 1);
      else {
        problems.push(`@${name} at ${i}: an at-rule this scope does not know`);
        out += css.slice(i, end + 1);
      }
      i = end + 1;
      continue;
    }
    const end = blockEnd(css, stop);
    const next = visit(splitSelectors(prelude), i);
    out += `${typeof next === 'string' ? next : prelude}${css.slice(stop, end + 1)}`;
    i = end + 1;
  }
  return out;
}

/** A page sheet with every rule scoped to its screens (the build's transform). Throws on CSS it cannot read. */
export function scopeSheet(css: string, scope: SheetScope): string {
  const problems: string[] = [];
  const out = walk(css, (selectors) => `${selectors.map((s) => scopeSelector(s, scope)).join(', ')} `, problems);
  if (problems.length) throw new Error(`page-scope: ${problems.join('; ')}`);
  return out;
}

/**
 * The selectors of a built sheet that can match outside the scope's screens: each subject must carry the scope's `inside`
 * suffix (or, for body and html, its `shown` suffix) before any pseudo-element, and no rule may sit in an at-rule this
 * reader does not know. Empty means every rule is scoped.
 */
export function unscopedSelectors(css: string, scope: SheetScope): string[] {
  const { inside, shown } = scopeSuffixes(scope);
  const bad: string[] = [];
  const problems: string[] = [];
  walk(
    css,
    (selectors) => {
      for (const sel of selectors) {
        const subject = sel.slice(subjectStart(sel));
        const head = subject.slice(0, pseudoElementAt(subject));
        const want = isDocumentSubject(subject) ? shown : inside;
        if (!head.endsWith(want)) bad.push(sel);
      }
    },
    problems,
  );
  return [...bad, ...problems];
}
