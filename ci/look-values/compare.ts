// SPDX-License-Identifier: AGPL-3.0-or-later
// Look-values comparator (G-LOOK-PARITY). Reads computed style values for selector pairs
// in an app route and in a mockup frame page, and reports every difference.
// Light theme only (kit section 3.4). Colors are compared as values, never against a
// contrast threshold (OA-84, D-5): there is no contrast check here and none may be added.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { guardedContext } from '../page-walkers/origin-guard.ts';

/** The computed values read per element. Each name is one reported property. */
export const PROPERTIES = [
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'color',
  'background-color',
  'background-image',
  'border-top-width',
  'border-top-style',
  'border-top-color',
  'border-right-width',
  'border-right-style',
  'border-right-color',
  'border-bottom-width',
  'border-bottom-style',
  'border-bottom-color',
  'border-left-width',
  'border-left-style',
  'border-left-color',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'row-gap',
  'column-gap',
  'width',
  'height',
] as const;
export type LookProperty = (typeof PROPERTIES)[number];
type LookValues = Record<LookProperty, string>;

export interface SelectorPair {
  /** Selector in the app page. */
  app: string;
  /** Selector in the frame page; defaults to the app selector. */
  frame?: string;
  /** The owner's ruling that this element's words differ from the frozen frame: its text-fitted width is not compared, every other value is. */
  wordsRuled?: string;
  /** The owner's ruling that this box holds more words than the frozen frame, so they wrap: its height is not compared, every other value is. */
  wrapRuled?: string;
  /**
   * F-1347: also compare this element's text content (whitespace collapsed). The style values and box sizes cannot see a text change that leaves the box as
   * it was: F-1345's extra " EDT" on Today's window line compared equal on Chromium, where that line's box does not follow its text, and only WebKit's
   * width moved. Opt-in per pair, for elements whose words the frame and the app share; most pairs hold sample data the frames word differently.
   */
  textSame?: boolean;
}

export interface CompareOptions {
  /** Absolute URL of the app route (http, https or file). */
  appUrl: string;
  /** Path of the frame page, e.g. mockups/pages/office-board.html (relative to cwd) or absolute. */
  framePath: string;
  /** State name. Applied as the URL hash of both pages when set (the frames read #es and similar). */
  state?: string;
  pairs: SelectorPair[];
  /** Runs after each page loads and before values are read (open a menu, wait for data). */
  setup?: (page: Page, which: 'app' | 'frame') => Promise<void>;
  /** Viewport; both pages use the same one. Default 1440x900. */
  viewport?: { width: number; height: number };
  /** Reuse a browser the caller launched. Otherwise one headless Chromium is launched and closed. */
  browser?: Browser;
}

interface Difference {
  pair: string;
  /** Position among the selector's matches; set only when the selector matches more than 1 element. */
  index?: number;
  property: LookProperty | 'element' | 'text';
  app: string;
  frame: string;
}

export interface CompareResult {
  differences: Difference[];
  pairsCompared: number;
  seconds: number;
}

type Read = { invalid: string } | { invalid?: undefined; all: LookValues[]; texts: string[] };

/**
 * Box width and height are a difference only when app and frame differ by MORE than this many px (owner ruling ea38f588,
 * F-482). The raw sizes are compared, never rounded ones: rounding to 0.01 px made 13.7325 vs 13.7351 (a 0.003 px gap
 * on WebKit) land on either side of a rounding step. Every other property is still compared for exact equality.
 */
export const BOX_TOLERANCE_PX = 0.5;

/** True when the two values of one property count as a difference. */
export function valuesDiffer(property: LookProperty, app: string, frame: string): boolean {
  if (property === 'width' || property === 'height') {
    const [a, f] = [Number.parseFloat(app), Number.parseFloat(frame)];
    if (Number.isFinite(a) && Number.isFinite(f)) return Math.abs(a - f) > BOX_TOLERANCE_PX;
  }
  return app !== frame;
}

/** An element's words as the comparator reads them: its text content with every run of whitespace as 1 space, trimmed (F-1347). */
export const normalizeText = (raw: string): string => raw.replace(/\s+/g, ' ').trim();

/** True when the two texts differ once normalized (F-1347). */
export const textsDiffer = (app: string, frame: string): boolean => normalizeText(app) !== normalizeText(frame);

/** For the report only: a box size shown to 0.01 px. */
function show(property: LookProperty, v: string): string {
  return property === 'width' || property === 'height' ? `${Math.round(Number.parseFloat(v) * 100) / 100}px` : v;
}

/** Runs in the page. Reads every match of the selector. Box sizes are read unrounded (see BOX_TOLERANCE_PX). */
async function readValues(page: Page, selector: string): Promise<Read> {
  return page.evaluate(
    ({ selector: sel, props }) => {
      // No DOM lib in this tsconfig; this function runs inside the page, where these exist.
      const g = globalThis as unknown as {
        document: { querySelectorAll(s: string): ArrayLike<{ getBoundingClientRect(): { width: number; height: number }; textContent: string | null }> };
        getComputedStyle(e: unknown): { getPropertyValue(p: string): string };
      };
      let els: ArrayLike<{ getBoundingClientRect(): { width: number; height: number }; textContent: string | null }>;
      try {
        els = g.document.querySelectorAll(sel);
      } catch (e) {
        return { invalid: String((e as Error).message) };
      }
      const all: Record<string, string>[] = [];
      const texts: string[] = [];
      for (let i = 0; i < els.length; i++) {
        const el = els[i]!;
        const cs = g.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const values: Record<string, string> = {};
        for (const p of props) {
          if (p === 'width') values[p] = `${rect.width}px`;
          else if (p === 'height') values[p] = `${rect.height}px`;
          else values[p] = cs.getPropertyValue(p);
        }
        all.push(values);
        texts.push(el.textContent ?? '');
      }
      return { all, texts };
    },
    { selector, props: [...PROPERTIES] },
  ) as Promise<Read>;
}

async function load(page: Page, url: string, state: string | undefined): Promise<void> {
  const target = state ? `${url.split('#')[0]}#${state}` : url;
  await page.goto(target, { waitUntil: 'load' });
  await page.evaluate(() => (globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } }).document.fonts.ready);
}

export async function compareLook(opts: CompareOptions): Promise<CompareResult> {
  // An empty pair list would compare nothing and report PASS (F-34).
  if (opts.pairs.length === 0) throw new Error('compareLook: pairs is empty; nothing would be compared');
  const started = performance.now();
  const ownBrowser = !opts.browser;
  const browser = opts.browser ?? (await chromium.launch({ headless: true }));
  try {
    // The context is opened through the outside-origin guard (F-36): an app page that requests another
    // origin makes compareLook reject when the context closes. The frame page is a file: page.
    const appUrl = new URL(opts.appUrl);
    const guard = await guardedContext(browser, appUrl.protocol.startsWith('http') ? [appUrl.origin] : [], {
      viewport: opts.viewport ?? { width: 1440, height: 900 },
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    const context = guard.context;
    try {
      const frameUrl = pathToFileURL(path.resolve(opts.framePath)).href;
      const reads: Record<'app' | 'frame', Page> = {
        app: await context.newPage(),
        frame: await context.newPage(),
      };
      await load(reads.app, opts.appUrl, opts.state);
      await load(reads.frame, frameUrl, opts.state);
      if (opts.setup) {
        await opts.setup(reads.app, 'app');
        await opts.setup(reads.frame, 'frame');
        // Again after setup: text the setup waited for (a streamed screen revealed, a state drawn) can start a font face that the
        // load's wait never saw, and a width read in the fallback face misses by about 1 px (P9-UG-WEB, red on a8e90d75 too).
        for (const p of [reads.app, reads.frame]) {
          await p.evaluate(() => (globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } }).document.fonts.ready);
        }
      }
      const differences: Difference[] = [];
      for (const pair of opts.pairs) {
        const frameSel = pair.frame ?? pair.app;
        const label = pair.frame && pair.frame !== pair.app ? `${pair.app} | ${pair.frame}` : pair.app;
        const [a, f] = [await readValues(reads.app, pair.app), await readValues(reads.frame, frameSel)];
        if (a.invalid !== undefined || f.invalid !== undefined) {
          differences.push({
            pair: label,
            property: 'element',
            app: a.invalid !== undefined ? `invalid selector: ${pair.app} (${a.invalid})` : 'ok',
            frame: f.invalid !== undefined ? `invalid selector: ${frameSel} (${f.invalid})` : 'ok',
          });
          continue;
        }
        const [av, fv] = [a.all, f.all];
        const [at, ft] = [a.texts, f.texts];
        if (av.length === 0 || fv.length === 0) {
          differences.push({
            pair: label,
            property: 'element',
            app: av.length ? 'found' : `not found: ${pair.app}`,
            frame: fv.length ? 'found' : `not found: ${frameSel}`,
          });
          continue;
        }
        // Every match is read: a different match count is a difference, and so is a change on any match (F-34).
        if (av.length !== fv.length) {
          differences.push({ pair: label, property: 'element', app: `${av.length} match(es)`, frame: `${fv.length} match(es)` });
        }
        for (let i = 0; i < Math.min(av.length, fv.length); i++) {
          if (pair.textSame && !pair.wordsRuled && textsDiffer(at[i]!, ft[i]!)) {
            differences.push({
              pair: label,
              ...(Math.max(av.length, fv.length) > 1 ? { index: i } : {}),
              property: 'text',
              app: JSON.stringify(normalizeText(at[i]!).slice(0, 120)),
              frame: JSON.stringify(normalizeText(ft[i]!).slice(0, 120)),
            });
          }
          for (const p of PROPERTIES) {
            if (p === 'width' && pair.wordsRuled) continue;
            if (p === 'height' && pair.wrapRuled) continue;
            if (valuesDiffer(p, av[i]![p], fv[i]![p])) {
              differences.push({
                pair: label,
                ...(Math.max(av.length, fv.length) > 1 ? { index: i } : {}),
                property: p,
                app: show(p, av[i]![p]),
                frame: show(p, fv[i]![p]),
              });
            }
          }
        }
      }
      return {
        differences,
        pairsCompared: opts.pairs.length,
        seconds: Math.round(((performance.now() - started) / 1000) * 100) / 100,
      };
    } finally {
      // Throws when the guard recorded an outside request.
      await context.close();
    }
  } finally {
    if (ownBrowser) await browser.close();
  }
}

/** One line per difference, naming the pair and the property. */
export function formatDifferences(r: CompareResult): string {
  const lines = r.differences.map((d) => `DIFF ${d.pair}${d.index === undefined ? '' : `[${d.index}]`} ${d.property}: app=${d.app} frame=${d.frame}`);
  lines.push(
    `${r.differences.length === 0 ? 'PASS' : 'FAIL'} ${r.pairsCompared} pair(s), ${r.differences.length} difference(s), ${r.seconds}s`,
  );
  return lines.join('\n');
}

/** The kit sheets are copied, not re-read: compare them byte for byte. Returns the paths that differ. */
export function compareKitSheets(
  files: { app: string; kit: string }[],
): { app: string; kit: string; reason: string }[] {
  const bad: { app: string; kit: string; reason: string }[] = [];
  for (const f of files) {
    try {
      if (!readFileSync(f.app).equals(readFileSync(f.kit))) bad.push({ ...f, reason: 'bytes differ' });
    } catch (e) {
      bad.push({ ...f, reason: (e as Error).message });
    }
  }
  return bad;
}
