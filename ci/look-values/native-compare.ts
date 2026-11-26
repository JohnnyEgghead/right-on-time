// SPDX-License-Identifier: AGPL-3.0-or-later
// G-LOOK-PARITY for the native app (P6-NATIVE-SHELL Acceptance, look clause: SCR-TEC-12 and the tab bar against DK-117's frames, native
// values read from the view hierarchy, compared with DK-50 to DK-59, in each state its frames show, light theme).
//   node ci/look-values/native-compare.ts --dumps <dir> [--set shell,mapme,job,today,steps]   exit 0 PASS, 1 a difference or a missing dump, 2 usage
// The app side is the look dump the native app writes in each state (apps/tech-native/src/ui/look.ts): per tagged view, what UIKit draws
// (BwLook, modules/bw-look: size, background, a UIKit layer border, the text face's typographic family and OS/2 weight class, size,
// color and line height, an icon's tint) and the style Yoga laid it out by (padding, gap, a border UIKit does not hold as a layer
// border). The frame side is mockups/pages/r1-ios-b.html's computed values in headless Chromium, as compare.ts reads them. The values
// compared are compare.ts's PROPERTIES, chosen per kind of element:
//   box   size, background, borders (style and color only where the frame has a border), padding, gaps
//   text  font family, size, weight, line height, color, and the text box's size
//   type  the text values without a box (the frame's text sits in a box element of its own: a button, a message)
//   face  font family, size, weight and color (a text field: UIKit fields carry no line height)
//   icon  size and color
// A frame tile is a fragment drawn at the details strip's width, not the device's. A pair marked `fill` fills its parent on both sides,
// so its width is compared as the room left beside it in its parent (parent content width minus its width), not as a number. A pair
// marked `data` holds the test's own data where the frame has sample words (a saved address): its width is not compared, every other
// value is. A pair marked `sum` is a container whose height is the sum of its children, each compared on its own (UIKit snaps every
// child to the screen's pixel grid, so the sum can drift past the box tolerance): its height is not compared. Colors are compared as values, never against a contrast threshold (OA-84).
// Declared, not drawn (F-993 b): padding, gaps and one-sided borders come from the style each view was given (the lk() registry,
// apps/tech-native/src/ui/look.ts), not from the view hierarchy; only sizes, colors and faces are read from UIKit. The tab bar is
// compared in the Today frame and, since P6-NATIVE-MAP-ME, in the Map, Parts and Me frames too (native-mapme-cases.ts).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';
import { isMain } from '../is-main.ts';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { PROPERTIES, valuesDiffer, type LookProperty } from './compare.ts';
import { DIRECTIONS_CASE, MAPME_CASES } from './native-mapme-cases.ts';
import { JOB_CASES } from './native-job-cases.ts';
import { NATIVE_TODAY_CASES } from './native-today-cases.ts';

const NATIVE_FRAME = 'mockups/pages/r1-ios-b.html';

export type Kind = 'box' | 'text' | 'type' | 'face' | 'icon';
export interface NativePair {
  frame: string;
  native: string;
  kind: Kind;
  fill?: { frame: string; native: string };
  data?: string;
  /** Why the height is not compared: a container whose height is the sum of children each compared on its own. */
  sum?: string;
}
export interface NativeCase {
  name: string;
  /** The dump the app wrote in this state (<state>.json). */
  state: string;
  /** The frame root: a caption (data-bw-cap), or a tile name (data-bw-tile) with its .b body. */
  root: string;
  pairs: NativePair[];
}

type Color = [number, number, number, number];
export interface DumpView {
  native: {
    width: number; height: number; background?: Color; borderWidth?: number; borderColor?: Color;
    font?: { size: number; family?: string; weight?: number; postScript: string }; color?: Color; minLineHeight?: number; tint?: Color;
  };
  style: Record<string, unknown>;
}
type Dump = { state: string; views: Record<string, DumpView> };
export type Values = Partial<Record<LookProperty, string>>;
export interface NativeDifference { pair: string; property: LookProperty | 'element' | 'fill'; app: string; frame: string }

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const BOX: LookProperty[] = [
  'background-color', 'background-image',
  ...SIDES.flatMap((s) => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`] as LookProperty[]),
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'row-gap', 'column-gap', 'width', 'height',
];
const TYPE: LookProperty[] = ['font-family', 'font-size', 'font-weight', 'line-height', 'color'];
export const KIND_PROPERTIES: Record<Kind, LookProperty[]> = {
  box: BOX,
  text: [...TYPE, 'width', 'height'],
  type: TYPE,
  face: ['font-family', 'font-size', 'font-weight', 'color'],
  icon: ['width', 'height', 'color'],
};

/** A number as the frame's computed value prints it: px, at most 4 decimals, no trailing zeros (a 32-bit 18.9 reads back as 18.9). */
export const px = (n: number): string => `${Number(n.toFixed(4))}px`;

/** A color as Chromium's computed value prints it. */
export function css(c: Color | undefined): string {
  if (!c) return 'rgba(0, 0, 0, 0)';
  const [r, g, b] = c.slice(0, 3).map((v) => Math.round(v));
  const a = Number(c[3].toFixed(2));
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** A style color (#rrggbb, transparent) as a Color. */
export function styleColor(v: unknown): Color | undefined {
  if (v === 'transparent') return [0, 0, 0, 0];
  if (typeof v !== 'string') return undefined;
  const rgba = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(v);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
  return m ? [parseInt(m[1] as string, 16), parseInt(m[2] as string, 16), parseInt(m[3] as string, 16), 1] : undefined;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const side = (style: Record<string, unknown>, prop: 'padding' | 'border', s: (typeof SIDES)[number]): number => {
  const cap = s[0]!.toUpperCase() + s.slice(1);
  const axis = s === 'top' || s === 'bottom' ? 'Vertical' : 'Horizontal';
  if (prop === 'padding') return num(style[`padding${cap}`]) ?? num(style[`padding${axis}`]) ?? num(style['padding']) ?? 0;
  return num(style[`border${cap}Width`]) ?? num(style['borderWidth']) ?? 0;
};

/**
 * The native values of 1 view. `band` is the view's 1-sided border drawn as a child band (the tab bar's top line): its height is the
 * border's width, its background the border's color, and the parent's padding counts it.
 */
export function nativeValues(v: DumpView, band?: DumpView): Values {
  const n = v.native;
  const out: Values = { width: px(n.width), height: px(n.height), 'background-color': css(n.background), 'background-image': 'none' };
  for (const s of SIDES) {
    let w = n.borderWidth ?? side(v.style, 'border', s);
    const cap = s[0]!.toUpperCase() + s.slice(1);
    let c = n.borderColor ?? styleColor(v.style[`border${cap}Color`]) ?? styleColor(v.style['borderColor']);
    let pad = side(v.style, 'padding', s);
    if (s === 'top' && band) {
      w = band.native.height;
      c = band.native.background;
      pad -= band.native.height;
    }
    out[`border-${s}-width`] = px(w);
    // A dashed border (SCR-TEC-07's signature pad) is drawn by React Native, not as a layer border: its style is the declared one.
    out[`border-${s}-style`] = w > 0 ? (v.style['borderStyle'] === 'dashed' ? 'dashed' : 'solid') : 'none';
    out[`border-${s}-color`] = css(c);
    out[`padding-${s}`] = px(pad);
  }
  const gap = (k: 'rowGap' | 'columnGap') => num(v.style[k]) ?? num(v.style['gap']);
  out['row-gap'] = gap('rowGap') === undefined ? 'normal' : px(gap('rowGap') as number);
  out['column-gap'] = gap('columnGap') === undefined ? 'normal' : px(gap('columnGap') as number);
  if (n.font) {
    out['font-family'] = n.font.family ?? `(unreadable: ${n.font.postScript})`;
    out['font-size'] = px(n.font.size);
    out['font-weight'] = n.font.weight === undefined ? '(unreadable)' : String(n.font.weight);
    out['line-height'] = n.minLineHeight ? px(n.minLineHeight) : 'normal';
  }
  out.color = css(n.color ?? n.tint);
  return out;
}

/** The frame's family as drawn: the first family of the computed list (the font the frame loads). */
const firstFamily = (list: string) => (list.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');

/** The differences of 1 pair, by its kind. */
export function comparePair(pair: NativePair, app: Values, frame: Values, label: string): NativeDifference[] {
  const out: NativeDifference[] = [];
  for (const p of KIND_PROPERTIES[pair.kind]) {
    if (p === 'width' && (pair.fill || pair.data)) continue;
    if (p === 'height' && pair.sum) continue;
    const a = app[p] ?? '(not read)';
    let f = frame[p] ?? '(not read)';
    if (p === 'font-family') f = firstFamily(f);
    if (p.startsWith('border-') && pair.kind === 'box') {
      // a border's style and color mean nothing where the frame draws no border (CSS reports currentColor there)
      const s = p.split('-')[1] as string;
      if (!p.endsWith('-width') && frame[`border-${s}-width` as LookProperty] === '0px') continue;
    }
    if (valuesDiffer(p, a, f)) out.push({ pair: label, property: p, app: a, frame: f });
  }
  return out;
}

const cap = (c: string) => `[data-bw-cap="${c}"]`;
const tile = (t: string) => `[data-bw-tile="${t}"] > .b`;
const R12 = 'SCR-TEC-12 Server address (native only): ';
const SCREEN = { native: 'srv.body' };

/** The shell's cases (P6-NATIVE-SHELL: sign-in, Today and the tab bar in the Today frame): what ShellUITests dumps. */
export const SHELL_CASES: NativeCase[] = [
  {
    name: 'SCR-TEC-12 Reachable (the main frame)', state: 'reachable', root: `${cap(`${R12}Reachable`)} .screen.server`,
    pairs: [
      { frame: '.navrow', native: 'srv.nav', kind: 'box' },
      { frame: '.navrow .tb:not(.strong)', native: 'srv.cancel', kind: 'box' },
      { frame: '.navrow .tb:not(.strong)', native: 'srv.cancel.text', kind: 'type' },
      { frame: '.navrow h1', native: 'srv.nav.title', kind: 'text' },
      { frame: '.navrow .tb.strong', native: 'srv.save', kind: 'box' },
      { frame: '.navrow .tb.strong', native: 'srv.save.text', kind: 'type' },
      { frame: '.body', native: 'srv.body', kind: 'box', sum: 'the sum of its 9 children, each compared; UIKit snaps each to the 1/3 pt pixel grid' },
      { frame: '.fld > label', native: 'srv.field.label', kind: 'text' },
      { frame: '.fld .inp', native: 'srv.field.inp', kind: 'box' },
      { frame: '.fld .inp .ic', native: 'srv.field.icon', kind: 'icon' },
      { frame: '.fld .inp .v', native: 'srv.field.value', kind: 'face' },
      { frame: '.fld .hint', native: 'srv.hint', kind: 'text' },
      { frame: '.body > a.sbtn:not(.ghost)', native: 'srv.check', kind: 'box' },
      { frame: '.body > a.sbtn:not(.ghost) .ic', native: 'srv.check.icon', kind: 'icon' },
      { frame: '.body > a.sbtn:not(.ghost) span', native: 'srv.check.text', kind: 'text' },
      { frame: '.okmsg', native: 'srv.ok', kind: 'box' },
      { frame: '.okmsg .ic', native: 'srv.ok.icon', kind: 'icon' },
      { frame: '.okmsg span', native: 'srv.ok.text', kind: 'text' },
      { frame: '.body > a.sbtn.ghost', native: 'srv.default', kind: 'box' },
      { frame: '.body > a.sbtn.ghost .ic', native: 'srv.default.icon', kind: 'icon' },
      { frame: '.body > a.sbtn.ghost span', native: 'srv.default.text', kind: 'text' },
      { frame: '.body > .hint.c', native: 'srv.defaultHint', kind: 'text' },
      { frame: '.body > .hint:last-child', native: 'srv.saveOff', kind: 'text' },
    ],
  },
  {
    name: 'SCR-TEC-12 Default', state: 'default', root: cap(`${R12}Default`),
    pairs: [
      { frame: '.fld > label', native: 'srv.field.label', kind: 'text', fill: { frame: '.b', ...SCREEN } },
      { frame: '.inp', native: 'srv.field.inp', kind: 'box', fill: { frame: '.b', ...SCREEN } },
      { frame: '.inp .ic', native: 'srv.field.icon', kind: 'icon' },
      { frame: '.inp .v', native: 'srv.field.value', kind: 'face' },
      { frame: '.sbtn.ghost', native: 'srv.default', kind: 'box', fill: { frame: '.b', ...SCREEN } },
      { frame: '.sbtn.ghost span', native: 'srv.default.text', kind: 'text' },
      { frame: '.hint.c', native: 'srv.defaultHint', kind: 'text', fill: { frame: '.b', ...SCREEN } },
    ],
  },
  {
    name: 'SCR-TEC-12 Checking', state: 'checking', root: cap(`${R12}Checking`),
    pairs: [
      { frame: '.sbtn.busy', native: 'srv.check', kind: 'box', fill: { frame: '.b', ...SCREEN } },
      { frame: '.sbtn.busy .r1-spin', native: 'srv.check.spin', kind: 'box' },
      { frame: '.sbtn.busy span:not(.r1-spin)', native: 'srv.check.text', kind: 'text' },
    ],
  },
  {
    name: 'SCR-TEC-12 Unreachable', state: 'unreachable', root: cap(`${R12}Unreachable`),
    pairs: [
      { frame: '.errbox', native: 'srv.err', kind: 'box', fill: { frame: '.b', ...SCREEN } },
      { frame: '.errbox .ic', native: 'srv.err.icon', kind: 'icon' },
      { frame: '.errbox span', native: 'srv.err.text', kind: 'text' },
    ],
  },
  {
    name: 'SCR-TEC-12 Not this product (control details)', state: 'not-product', root: tile('Not this product'),
    pairs: [
      { frame: '.errbox', native: 'srv.err', kind: 'box', fill: { frame: '', ...SCREEN } },
      { frame: '.errbox .ic', native: 'srv.err.icon', kind: 'icon' },
      { frame: '.errbox span', native: 'srv.err.text', kind: 'text' },
    ],
  },
  {
    name: 'SCR-TEC-12 Not a web address (control details)', state: 'not-address', root: tile('Not a web address'),
    pairs: [
      { frame: '.fld > label', native: 'srv.field.label', kind: 'text', fill: { frame: '', ...SCREEN } },
      { frame: '.inp.bad', native: 'srv.field.inp', kind: 'box', fill: { frame: '', ...SCREEN } },
      { frame: '.inp.bad .ic', native: 'srv.field.icon', kind: 'icon' },
      { frame: '.r1-fmsg', native: 'srv.fmsg', kind: 'box', fill: { frame: '', ...SCREEN } },
      { frame: '.r1-fmsg .ic', native: 'srv.fmsg.icon', kind: 'icon' },
      { frame: '.r1-fmsg', native: 'srv.fmsg.text', kind: 'type' },
    ],
  },
  {
    name: 'SCR-TEC-12 Saved (the sign-in screen\'s Server row)', state: 'saved', root: cap(`${R12}Saved`),
    pairs: [
      { frame: '.grp.setg', native: 'signin.server.grp', kind: 'box', fill: { frame: '.b', native: 'signin.form' }, sum: 'the sign-in screen draws the Language row above the Server row in this group card; the tile draws the Server row alone' },
      { frame: '.row.set', native: 'signin.server', kind: 'box', fill: { frame: '.grp.setg', native: 'signin.server.grp' } },
      { frame: '.row.set > .ic', native: 'signin.server.icon', kind: 'icon' },
      { frame: '.row.set .k', native: 'signin.server.key', kind: 'text', data: 'its width is the room the saved address leaves' },
      { frame: '.row.set .v', native: 'signin.server.value', kind: 'text', data: 'the address the test saved, not the frame\'s sample address' },
      { frame: '.row.set .chev', native: 'signin.server.chev', kind: 'icon' },
    ],
  },
  {
    name: 'CMP-09 tab bar (the Today frame)', state: 'today', root: `${cap('SCR-TEC-02 Today, iPhone: Success')} .tabbar`,
    pairs: [
      { frame: '', native: 'tabbar', kind: 'box' },
      { frame: '.tab.on', native: 'tab.today', kind: 'box' },
      { frame: '.tab.on::before', native: 'tab.today.mark', kind: 'box' },
      { frame: '.tab.on .ic', native: 'tab.today.icon', kind: 'icon' },
      { frame: '.tab.on span', native: 'tab.today.text', kind: 'text' },
      ...(['map', 'parts', 'me'] as const).flatMap((t, i): NativePair[] => [
        { frame: `.tab:nth-child(${i + 2})`, native: `tab.${t}`, kind: 'box' },
        { frame: `.tab:nth-child(${i + 2}) .ic`, native: `tab.${t}.icon`, kind: 'icon' },
        { frame: `.tab:nth-child(${i + 2}) span`, native: `tab.${t}.text`, kind: 'text' },
      ]),
    ],
  },
];

/** Every case of every task's suite (the whole set needs every task's states dumped). */
export const NATIVE_CASES: NativeCase[] = [...SHELL_CASES, ...MAPME_CASES, DIRECTIONS_CASE, ...JOB_CASES, ...NATIVE_TODAY_CASES];

/** P6-NATIVE-STEPS's StepsUITests dumps SCR-TEC-08's Route and SCR-TEC-04's Success (with Photos (3)): the Directions case (its own set since
 * the steps) and the job set's Success case. */
const STEPS_CASES: NativeCase[] = [DIRECTIONS_CASE, ...JOB_CASES.filter((c) => c.state === 'job')];

/** The named case sets (F-1071): a rig run compares exactly the cases its test classes dump. `names` is comma separated; unknown is null. */
export function casesNamed(names: string): NativeCase[] | null {
  const sets: Record<string, NativeCase[]> = { shell: SHELL_CASES, mapme: MAPME_CASES, job: JOB_CASES, today: NATIVE_TODAY_CASES, steps: STEPS_CASES, all: NATIVE_CASES };
  const out: NativeCase[] = [];
  for (const n of names.split(',')) {
    const set = sets[n];
    if (!set) return null;
    for (const c of set) if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** The cases' states: the app must have dumped each one. */
export const NATIVE_STATES = [...new Set(NATIVE_CASES.map((c) => c.state))];

type FrameRead = { count: number; values: Values; content: number };

// No DOM lib in this tsconfig; these run inside the page, where the document exists (as compare.ts reads it).
type El = { getBoundingClientRect(): { width: number; height: number }; closest(s: string): El | null; nextElementSibling: El | null;
  setAttribute(k: string, v: string): void; querySelector(s: string): El | null; textContent: string | null };
type Doc = { querySelectorAll(s: string): ArrayLike<El> & Iterable<El>; fonts: { ready: Promise<unknown> } };
type Win = { document: Doc; getComputedStyle(e: El, pseudo: string | null): { getPropertyValue(p: string): string; width: string; height: string } };

/** Reads every selector of a case in the tagged frame page (computed values; a ::before pseudo element by its computed size). */
async function readFrame(page: Page, root: string, sels: string[]): Promise<Record<string, FrameRead>> {
  return page.evaluate(({ root, sels, props }) => {
    const out: Record<string, { count: number; values: Record<string, string>; content: number }> = {};
    for (const sel of sels) {
      const pseudo = sel.endsWith('::before') ? '::before' : null;
      const inner = pseudo ? sel.slice(0, -'::before'.length) : sel;
      const full = inner === '' ? root : `${root} ${inner}`;
      const g = globalThis as unknown as Win;
      const els = g.document.querySelectorAll(full);
      const values: Record<string, string> = {};
      let content = 0;
      const el = els[0];
      if (el) {
        const cs = g.getComputedStyle(el, pseudo);
        const r = el.getBoundingClientRect();
        for (const p of props) values[p] = cs.getPropertyValue(p);
        values['width'] = pseudo ? cs.width : `${r.width}px`;
        values['height'] = pseudo ? cs.height : `${r.height}px`;
        const f = (p: string) => Number.parseFloat(cs.getPropertyValue(p)) || 0;
        content = r.width - f('padding-left') - f('padding-right') - f('border-left-width') - f('border-right-width');
      }
      out[sel] = { count: els.length, values, content };
    }
    return out;
  }, { root, sels, props: [...PROPERTIES] });
}

/** The room a native view's content leaves: its width less its padding and borders. */
function nativeContent(v: DumpView): number {
  const n = v.native;
  const b = n.borderWidth !== undefined ? 2 * n.borderWidth : side(v.style, 'border', 'left') + side(v.style, 'border', 'right');
  return n.width - side(v.style, 'padding', 'left') - side(v.style, 'padding', 'right') - b;
}

async function compareNative(dumps: Record<string, Dump>, page: Page, cases: NativeCase[] = NATIVE_CASES): Promise<{ name: string; differences: NativeDifference[]; pairs: number }[]> {
  const results: { name: string; differences: NativeDifference[]; pairs: number }[] = [];
  for (const c of cases) {
    const differences: NativeDifference[] = [];
    const dump = dumps[c.state];
    if (!dump) {
      results.push({ name: c.name, differences: [{ pair: c.state, property: 'element', app: 'no dump in this state', frame: '-' }], pairs: c.pairs.length });
      continue;
    }
    const sels = [...new Set(c.pairs.flatMap((p) => [p.frame, ...(p.fill ? [p.fill.frame] : [])]))];
    const frame = await readFrame(page, c.root, sels);
    for (const pair of c.pairs) {
      const label = `${pair.native} | ${pair.frame || '(root)'}`;
      const f = frame[pair.frame] as FrameRead;
      const v = dump.views[pair.native];
      if (f.count !== 1 || !v) {
        differences.push({ pair: label, property: 'element', app: v ? 'found' : `not found: ${pair.native}`, frame: f.count === 1 ? 'found' : `${f.count} match(es): ${c.root} ${pair.frame}` });
        continue;
      }
      const app = nativeValues(v, dump.views[`${pair.native}.border`]);
      differences.push(...comparePair(pair, app, f.values, label));
      if (pair.fill) {
        const fp = frame[pair.fill.frame] as FrameRead;
        const np = dump.views[pair.fill.native];
        if (!np || fp.count !== 1) {
          differences.push({ pair: label, property: 'fill', app: np ? 'found' : `parent not found: ${pair.fill.native}`, frame: `parent ${fp.count} match(es)` });
        } else {
          const [a, fr] = [nativeContent(np) - v.native.width, fp.content - Number.parseFloat(f.values.width ?? '0')];
          if (valuesDiffer('width', `${a}px`, `${fr}px`)) differences.push({ pair: label, property: 'fill', app: `${px(a)} left beside it`, frame: `${px(fr)} left beside it` });
        }
      }
    }
    results.push({ name: c.name, differences, pairs: c.pairs.length });
  }
  return results;
}

/** Tags each frame tile (data-bw-cap by its caption, as compare.ts's tagFrames) and each state tile by its name (data-bw-tile). */
async function tagNativeFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const d = (globalThis as unknown as Win).document;
    for (const c of d.querySelectorAll('p.frame-cap')) (c.closest('.r1-st') ?? c.nextElementSibling)?.setAttribute('data-bw-cap', (c.textContent ?? '').trim());
    for (const t of d.querySelectorAll('.r1-st')) {
      const name = t.querySelector(':scope > .h > b')?.textContent?.trim();
      if (name) t.setAttribute('data-bw-tile', name);
    }
  });
}

function loadDumps(dir: string): Record<string, Dump> {
  const out: Record<string, Dump> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const d = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Dump;
    out[d.state] = d;
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  const i = argv.indexOf('--dumps');
  const dir = i >= 0 ? argv[i + 1] : undefined;
  if (!dir) {
    console.error('usage: node ci/look-values/native-compare.ts --dumps <dir>');
    return 2;
  }
  // --set <name>: a run of 1 task's suite compares that task's cases only (the whole set needs every task's states dumped).
  const si = argv.indexOf('--set');
  const set = si >= 0 ? argv[si + 1] : undefined;
  const cases = set === undefined ? NATIVE_CASES : casesNamed(set);
  if (!cases) {
    console.error(`native-compare: no case set named ${String(set)} (known: shell, mapme, job, today, steps, all; join with commas)`);
    return 2;
  }
  const dumps = loadDumps(dir);
  const browser = await chromium.launch({ headless: true });
  try {
    // The frame page is a file: page; the outside-origin guard (F-36) allows no origin, so any request off the file fails the run.
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const page = await g.context.newPage();
    await page.goto(pathToFileURL(path.resolve(NATIVE_FRAME)).href, { waitUntil: 'load' });
    await page.evaluate(() => (globalThis as unknown as Win).document.fonts.ready);
    await tagNativeFrames(page);
    let total = 0;
    for (const r of await compareNative(dumps, page, cases)) {
      for (const d of r.differences) console.log(`DIFF ${r.name}: ${d.pair} ${d.property}: app=${d.app} frame=${d.frame}`);
      console.log(`${r.differences.length === 0 ? 'PASS' : 'FAIL'} ${r.name}: ${r.pairs} pair(s), ${r.differences.length} difference(s)`);
      total += r.differences.length;
    }
    await g.context.close(); // throws when the guard recorded an outside request
    console.log(`native-compare: ${total === 0 ? 'PASS' : 'FAIL'} ${cases.length} case(s), ${total} difference(s)`);
    return total === 0 ? 0 : 1;
  } finally {
    await browser.close();
  }
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));
