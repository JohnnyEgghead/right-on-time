// SPDX-License-Identifier: AGPL-3.0-or-later
// The 5 page walkers (BUILD_PLAN P1-PAGE-GATES; SPECIFICATIONS section 14 Platform and Content gates).
// Each takes a Playwright Page already on the page under test and returns findings; an empty list is a pass.
// Page-side code is passed as source strings so this file needs no DOM typings.
import AxeBuilder from '@axe-core/playwright';
import { IntlMessageFormat } from 'intl-messageformat';
import type { Page } from 'playwright';

export type Finding = { walker: string; message: string };

const MIN_TAP_PX = 44;
export const PHONE_VIEWPORT = { width: 390, height: 844 };
// Mockup viewports the overflow walker checks (SPECIFICATIONS section 14 names 520 x 980).
const OVERFLOW_VIEWPORTS = [
  { width: 520, height: 980 },
  { width: 390, height: 844 },
];

// axe-scan: 0 serious or critical violations. color-contrast is OFF (OA-84, BUILD_PLAN section 3 D-5).
export async function axeScan(page: Page): Promise<Finding[]> {
  const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      walker: 'axe-scan',
      message: `${v.id} (${v.impact}): ${v.nodes.length} node(s), first ${v.nodes[0]?.target.join(' ')}`,
    }));
}

const TAP_SCRIPT = `(() => {
  const sel = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=slider], label, area[href], [tabindex]:not([tabindex="-1"])';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.width < ${MIN_TAP_PX} - 0.01 || r.height < ${MIN_TAP_PX} - 0.01) {
      out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
  }
  return out;
})()`;

// tap-target-44: every tap target on a phone layout is at least 44 x 44 px. The caller sets the phone viewport.
export async function tapTargets(page: Page): Promise<Finding[]> {
  const small = (await page.evaluate(TAP_SCRIPT)) as string[];
  return small.map((s) => ({ walker: 'tap-target-44', message: `under ${MIN_TAP_PX} px: ${s}` }));
}

export type Catalog = { en: Record<string, string>; es: Record<string, string> };

// English values that must never show on a Spanish page: the English text of every key whose Spanish
// value is missing or different. A key with the same text in both languages (a cognate) is allowed, and so
// is any English text that is also a Spanish value of another key.
export function forbiddenEnglish(catalog: Catalog): string[] {
  const esValues = new Set(Object.values(catalog.es));
  const out = new Set<string>();
  for (const [key, en] of Object.entries(catalog.en)) {
    if (catalog.es[key] === en) continue;
    if (esValues.has(en)) continue;
    out.add(en.trim());
  }
  return [...out].filter((s) => s.length > 0);
}

// A catalog value is an ICU message (SPECIFICATIONS FR-LANG-2): {count} jobs today renders as 3 jobs today, so the
// raw source never equals rendered text. These are the literal runs of the message (the text between its arguments,
// inside plural and select branches too), whitespace-normalized. Only runs of 2 or more words with a letter are kept: a single
// word is matched as a whole text node only (forbiddenEnglish), so "Open" is not found inside "Opening".
export function literalRuns(message: string): string[] {
  const runs: string[] = [];
  const flush = (t: string) => {
    const n = t.replace(/\s+/g, ' ').trim();
    // F-849: a run needs 2 words with a letter in them: the ". The" between 2 arguments is punctuation and 1 word, and matched an office note.
    if (n.split(' ').filter((w) => /\p{L}/u.test(w)).length >= 2) runs.push(n);
  };
  // AST node types (@formatjs/icu-messageformat-parser TYPE): 0 literal; every other node breaks a run, and a
  // plural or select node holds options[..].value, a tag holds children.
  type Node = { type: number; value?: unknown; options?: Record<string, { value: Node[] }>; children?: Node[] };
  const walk = (els: Node[]) => {
    let cur = '';
    for (const el of els) {
      if (el.type === 0) {
        cur += String(el.value);
        continue;
      }
      flush(cur);
      cur = '';
      for (const opt of Object.values(el.options ?? {})) walk(opt.value);
      if (el.children) walk(el.children);
    }
    flush(cur);
  };
  try {
    walk(new IntlMessageFormat(message, 'en').getAst() as unknown as Node[]);
  } catch {
    flush(message); // not valid ICU: treat the whole value as text
  }
  return runs;
}

// English literal runs (2 or more words) of every key whose Spanish value is missing or different, minus any run
// that the Spanish catalog also contains (a shared phrase).
export function forbiddenRuns(catalog: Catalog): string[] {
  const esRuns = new Set(Object.values(catalog.es).flatMap(literalRuns));
  const esValues = new Set(Object.values(catalog.es).map((v) => v.replace(/\s+/g, ' ').trim()));
  const out = new Set<string>();
  for (const [key, en] of Object.entries(catalog.en)) {
    if (catalog.es[key] === en) continue;
    for (const run of literalRuns(en)) if (!esRuns.has(run) && !esValues.has(run)) out.add(run);
  }
  return [...out];
}

// F-713: stored codes. A catalog key names its code in a segment (service.furnace_tune_up.screen, job.error.time_overlap): a lowercase
// word with 1 or more underscores. Such a code on a page, as a whole word in text or an attribute, is a stored value shown raw, which no
// English catalog value matches. The codes are read from the catalog's own keys, so a new code is covered with no list to keep.
function storedCodes(catalog: Catalog): string[] {
  const out = new Set<string>();
  for (const key of Object.keys(catalog.en)) for (const seg of key.split('.')) if (/^[a-z]+(?:_[a-z0-9]+)+$/.test(seg)) out.add(seg);
  return [...out];
}

const TEXT_SCRIPT = `(() => {
  const out = [];
  const blocks = new Set();
  // Text in another language than the page's is data in its own language (a customer's text, a script read aloud), and a
  // lang attribute says so (F-658): the copy of the page this reads drops every element whose lang names another language.
  const root = document.body.cloneNode(true);
  const page = (document.documentElement.lang || '').toLowerCase().split('-')[0];
  for (const el of [...root.querySelectorAll('[lang]')]) {
    const l = (el.getAttribute('lang') || '').toLowerCase().split('-')[0];
    if (l && l !== page) el.remove();
  }
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const t = (n.nodeValue || '').replace(/\\s+/g, ' ').trim();
    const p = n.parentElement;
    if (!t || !p || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(p.tagName)) continue;
    out.push(t);
  }
  for (const el of root.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) continue;
    const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (t) blocks.add(t);
  }
  for (const el of root.querySelectorAll('[aria-label],[placeholder],[title],[alt]')) {
    for (const a of ['aria-label', 'placeholder', 'title', 'alt']) {
      const v = el.getAttribute(a);
      if (v && v.trim()) out.push(v.trim());
    }
  }
  return { lang: document.documentElement.lang, texts: out, blocks: [...blocks] };
})()`;

// spanish-fallback-pass: a page shown in Spanish holds no English catalog value. Two surfaces: a whole text node or
// attribute equal to an English value, and an English literal run (2 or more words) inside any element's text or any
// aria-label, placeholder, title or alt value, which also sees ICU values with arguments and values split across
// inline elements.
export async function spanishFallback(page: Page, catalog: Catalog): Promise<Finding[]> {
  const { lang, texts, blocks } = (await page.evaluate(TEXT_SCRIPT)) as { lang: string; texts: string[]; blocks: string[] };
  if (!lang.toLowerCase().startsWith('es')) {
    return [{ walker: 'spanish-fallback-pass', message: `page is not shown in Spanish (html lang="${lang}")` }];
  }
  const bad = new Set(forbiddenEnglish(catalog));
  const hits = new Set([...new Set(texts)].filter((t) => bad.has(t)));
  for (const run of forbiddenRuns(catalog)) {
    if (blocks.some((b) => b.includes(run)) || texts.some((t) => t.includes(run))) hits.add(run);
  }
  const findings: Finding[] = [...hits].map((t) => ({ walker: 'spanish-fallback-pass', message: `English catalog value on a Spanish page: "${t}"` }));
  // F-713: a stored code shown raw (checked on any language's page, as a whole word).
  for (const code of storedCodes(catalog)) {
    const word = new RegExp(`(^|[^A-Za-z0-9_])${code}($|[^A-Za-z0-9_])`);
    if (texts.some((t) => word.test(t))) findings.push({ walker: 'spanish-fallback-pass', message: `stored code shown on the page: "${code}"` });
  }
  return findings;
}

const OVERFLOW_SCRIPT = `(() => {
  const out = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > window.innerWidth + 1) out.push('page scrolls sideways: ' + doc.scrollWidth + ' > ' + window.innerWidth);
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || !(el.textContent || '').trim()) continue;
    const clipX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
    const clipY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
    if ((clipX && el.scrollWidth > el.clientWidth + 1) || (clipY && el.scrollHeight > el.clientHeight + 1)) {
      out.push('clipped text: ' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' "' + (el.textContent || '').trim().slice(0, 40) + '"');
    }
  }
  return out;
})()`;

// The wide-font probe (F-310). Text width depends on the fonts the machine has: Inter fits where Verdana, which a
// visitor's device may use, does not (F-309: the sign-in layout fit 295 of 296 px on the Mac and overflowed in the wave
// container). The probe widens every glyph run by 0.06em of letter spacing, about the step from Inter to Verdana, on
// any machine and whatever font it picks, so a tight fit fails here instead of only where the font happens to be wide.
const WIDE_FONT_PROBE_CSS = '*, *::before, *::after { letter-spacing: 0.06em !important; }';

const PROBE_ON_SCRIPT = `(() => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(${JSON.stringify(WIDE_FONT_PROBE_CSS)});
  window.__bwProbe = sheet;
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
})()`;
const PROBE_OFF_SCRIPT = `(() => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== window.__bwProbe); })()`;

export type FontProbe = 'natural' | 'wide';

// overflow-pass: no text clipped (and no sideways page scroll) at each mockup viewport. The caller loads the
// page in Spanish; this walker resizes the viewport and checks. `probe: 'wide'` checks again with the wide-font probe
// in place, then takes it out; a finding says which probe saw it.
const SETTLE_SCRIPT = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))))';

export async function overflowPass(page: Page, viewports = OVERFLOW_VIEWPORTS, probe: FontProbe = 'natural'): Promise<Finding[]> {
  const findings: Finding[] = [];
  // A constructable style sheet, not a <style> tag: the app's CSP (no inline style) refuses an injected tag.
  if (probe === 'wide') await page.evaluate(PROBE_ON_SCRIPT);
  try {
    for (const vp of viewports) {
      await page.setViewportSize(vp);
      // A resize is answered over the next frames (a ResizeObserver, a map that re-frames on its resize event): the page is
      // read once 3 frames have drawn at the new size, as a person sees it, not in the instant the window changed.
      await page.evaluate(SETTLE_SCRIPT);
      const issues = (await page.evaluate(OVERFLOW_SCRIPT)) as string[];
      for (const i of issues) findings.push({ walker: 'overflow-pass', message: `${vp.width} x ${vp.height}${probe === 'wide' ? ' (wide-font probe)' : ''}: ${i}` });
    }
  } finally {
    if (probe === 'wide') await page.evaluate(PROBE_OFF_SCRIPT);
  }
  return findings;
}
