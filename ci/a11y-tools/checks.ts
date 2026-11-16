// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: NFR-06 (P8-A11Y-TOOLS: the tools-run web checks of UI-SPECIFICATION 14.1 items 11, 12 and 13)
// The 3 checks, as page-side source strings run through Playwright, and the planted fixtures that prove each fires:
//   reflow-320  14.1 item 11: at 320 CSS px the page does not scroll sideways, no box lies past the edge outside a scroll region of its own,
//               and no text is clipped (overflow-pass's clipped-text measure). A region with overflow-x auto or scroll is the item's 2-dimension exception.
//   text-200    14.1 item 12, "Text resizes to 200% without loss": the text resized to 200%, then overflow-pass's clipped-text measure ONLY (text that a box cuts
//               off is lost content; a page that scrolls sideways at 200% loses nothing: 14.1 item 11 owns the sideways scroll, at 320 px). What also clipped
//               at 100% is not counted again. The method follows WCAG 1.4.4 (resize text up to 200%, no loss of content or function), 2 ways by page kind:
//               page-zoom (desktop pages, the office and the booking pages): browser zoom 200% on a 1440 x 900 window, which is a 720 x 450 CSS px viewport,
//               text and layout together as a visitor's zoom does it (F-1628: doubling every font at 1440 x 900 kept the wide layout and was a 400% test);
//               text-only (phone-width pages): every element's font size doubled at the phone viewport, as a larger text-size setting does it.
//   motion      14.1 item 13: with the browser's reduced-motion setting on, nothing runs an animation or a transition and no element declares one.
import type { Page } from 'playwright';
import { overflowPass, type Finding } from '../page-walkers/walkers.ts';

export const REFLOW_VIEWPORT = { width: 320, height: 640 };

const SETTLE = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))))';

const REFLOW_SCRIPT = `(() => {
  const out = [];
  const W = window.innerWidth;
  const inRegion = (el) => {
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 1 && setSideways(p)) return true;
    }
    return false;
  };
  // F-1630: overflow-y auto alone computes overflow-x to auto, so an up-and-down panel looks like a sideways region. A sideways region is one whose
  // overflow-x stays auto or scroll with overflow-y taken back to visible (the 2-dimension exception is for a region that was given a sideways scroll).
  const setSideways = (p) => {
    const keep = p.style.getPropertyValue('overflow-y'), prio = p.style.getPropertyPriority('overflow-y');
    p.style.setProperty('overflow-y', 'visible', 'important');
    const ox = getComputedStyle(p).overflowX;
    if (keep) p.style.setProperty('overflow-y', keep, prio); else p.style.removeProperty('overflow-y');
    return ox === 'auto' || ox === 'scroll';
  };
  const named = (el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/)[0] : '');
  const reported = new Set();
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue; // a visually hidden element
    if (r.right <= W + 1 && r.left >= -1) continue;
    if (inRegion(el)) continue;
    if (el.parentElement && reported.has(el.parentElement)) { reported.add(el); continue; } // the outermost box only
    reported.add(el);
    out.push('box past the 320 px edge: ' + named(el) + ' ' + Math.round(r.left) + ' to ' + Math.round(r.right) + ' (' + ((el.textContent || '').trim().slice(0, 30)) + ')');
  }
  return out.slice(0, 10);
})()`;

const DOUBLE_SCRIPT = `(() => {
  const els = [document.documentElement, ...document.body.querySelectorAll('*')];
  const sizes = els.map((e) => parseFloat(getComputedStyle(e).fontSize));
  els.forEach((e, i) => { if (sizes[i] > 0) e.style.setProperty('font-size', sizes[i] * 2 + 'px', 'important'); });
})()`;

const MOTION_SCRIPT = `(async () => {
  await new Promise((r) => setTimeout(r, 1200));
  const name = (el) => (el ? el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/)[0] : '') : '?');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const running = document.getAnimations().filter((a) => a.playState === 'running' || a.playState === 'pending')
    .map((a) => 'running ' + (a.animationName ? 'animation ' + a.animationName : a.transitionProperty ? 'transition ' + a.transitionProperty : 'animation') + ' on ' + name(a.effect && a.effect.target));
  const declared = [];
  const secs = (v) => v.split(',').some((x) => parseFloat(x) > 0);
  for (const el of [document.documentElement, ...document.body.querySelectorAll('*')]) {
    const cs = getComputedStyle(el);
    if (cs.animationName !== 'none' && secs(cs.animationDuration)) declared.push('animation declared: ' + cs.animationName + ' on ' + name(el));
    if (cs.transitionProperty !== 'none' && secs(cs.transitionDuration)) declared.push('transition declared: ' + cs.transitionProperty + ' ' + cs.transitionDuration + ' on ' + name(el));
  }
  // F-1631: motion driven by script (requestAnimationFrame, a MapLibre marker) is no animation or transition. Sample every box 3 times, 120 ms apart;
  // a box that moved in both gaps in the same direction is gliding (a change that happens once, as data arrives, moves in 1 gap only).
  const els = [...document.body.querySelectorAll('*')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; }).slice(0, 1500);
  const at = () => els.map((el) => { const r = el.getBoundingClientRect(); return [r.left, r.top]; });
  const a = at(); await new Promise((r) => setTimeout(r, 120)); const b = at(); await new Promise((r) => setTimeout(r, 120)); const c = at();
  const scripted = [];
  els.forEach((el, i) => {
    for (const k of [0, 1]) {
      const d1 = b[i][k] - a[i][k], d2 = c[i][k] - b[i][k];
      if (Math.abs(d1) > 1 && Math.abs(d2) > 1 && Math.sign(d1) === Math.sign(d2)) { scripted.push('moved by script: ' + name(el) + (k ? ' (top)' : ' (left)')); break; }
    }
  });
  return { reduced, found: [...running, ...declared.slice(0, 12), ...scripted.slice(0, 5)] };
})()`;

export async function reflow320(page: Page): Promise<Finding[]> {
  await page.setViewportSize(REFLOW_VIEWPORT);
  await page.evaluate(SETTLE);
  const boxes = (await page.evaluate(REFLOW_SCRIPT)) as string[];
  const clipped = await overflowPass(page, [REFLOW_VIEWPORT]);
  return [...boxes.map((message) => ({ walker: 'reflow-320', message })), ...clipped.map((f) => ({ walker: 'reflow-320', message: f.message }))];
}

export type Text200Method = 'page-zoom' | 'text-only';

/** Only text a box cuts off counts as loss (14.1 item 12); overflow-pass also says "page scrolls sideways", which is not loss of text. */
const clippedOnly = (found: Finding[]): Finding[] => found.filter((f) => /clipped text:/.test(f.message));

export async function text200(page: Page, viewport: { width: number; height: number }, method: Text200Method): Promise<Finding[]> {
  const element = (f: Finding) => f.message.replace(/^\d+ x \d+: /, ''); // the same element at another viewport size is the same finding
  const before = new Set(clippedOnly(await overflowPass(page, [viewport])).map(element));
  let after: Finding[];
  if (method === 'page-zoom') {
    // 200% browser zoom: the same window holds half as many CSS pixels, each drawn twice as big (overflowPass sets the viewport and lets the page settle).
    after = await overflowPass(page, [{ width: Math.round(viewport.width / 2), height: Math.round(viewport.height / 2) }]);
  } else {
    await page.evaluate(DOUBLE_SCRIPT);
    after = await overflowPass(page, [viewport]);
  }
  return clippedOnly(after).filter((f) => !before.has(element(f))).map((f) => ({ walker: 'text-200', message: f.message }));
}

export async function motion(page: Page): Promise<Finding[]> {
  const r = (await page.evaluate(MOTION_SCRIPT)) as { reduced: boolean; found: string[] };
  const out = r.found.map((message) => ({ walker: 'motion', message }));
  if (!r.reduced) out.push({ walker: 'motion', message: 'the browser did not report prefers-reduced-motion: reduce (the setting is not on)' });
  return out;
}

const page = (body: string, head = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>fixture</title>${head}</head><body><main>${body}</main></body></html>`;

/** Planted known-bad pages and their clean twins. Each bad one is flagged by its check and each clean one passes. */
export const fixtures: Record<string, string> = {
  // reflow-320: a box 400 px wide
  '/reflow-bad.html': page('<h1>Pedido</h1><div style="width:400px;height:30px;background:#888">box</div>'),
  // clean: a box that fits, and a wide table inside a region of its own that scrolls (the item's exception)
  '/reflow-clean.html': page('<h1>Pedido</h1><div style="max-width:100%;height:30px;background:#888">box</div><div style="overflow-x:auto"><table style="width:600px"><tr><td>Uno</td><td>Dos</td></tr></table></div>'),
  // reflow-320, F-1630: a 400 px box inside an up-and-down panel (overflow-y auto alone, which computes overflow-x to auto) is not the sideways exception
  '/reflow-ypanel-bad.html': page('<h1>Pedido</h1><div style="overflow-y:auto;max-height:300px"><div style="width:400px;height:30px;background:#888">box</div></div>'),
  // text-200: a label that fits at 100% (a 130 px box) and clips at 200%
  '/text-bad.html': page('<h1>Pedido</h1><div id="l" style="width:130px;overflow:hidden;white-space:nowrap;font-size:16px">Guardar cambios</div>'),
  '/text-clean.html': page('<h1>Pedido</h1><div style="width:400px;overflow:hidden;white-space:nowrap;font-size:16px">Guardar cambios</div>'),
  // text-200, page-zoom method (F-1628): a label that fits in the wide layout and clips once the viewport is halved (a narrow-layout rule cuts it off)
  '/zoom-bad.html': page('<h1>Pedido</h1><div id="z">Guardar cambios</div>', '<style>#z{width:300px;overflow:hidden;white-space:nowrap}@media (max-width:800px){#z{width:60px}}</style>'),
  // clean twin: the narrow layout lets the label wrap instead of cutting it off
  '/zoom-clean.html': page('<h1>Pedido</h1><div id="z">Guardar cambios</div>', '<style>#z{width:300px;overflow:hidden;white-space:nowrap}@media (max-width:800px){#z{width:60px;white-space:normal}}</style>'),
  // the corrected measure: a page that only scrolls sideways at 200% (a 1000 px table, no clipped text) is not a loss of text
  '/zoom-sideways.html': page('<h1>Pedido</h1><table style="width:1000px"><tr><td>Uno</td><td>Dos</td></tr></table>'),
  // motion: an element that animates (and one that declares a transition)
  '/motion-bad.html': page('<h1>Pedido</h1><div style="width:40px;height:40px;background:#888;animation:slide 1s linear infinite;position:relative">m</div><button style="transition:background .3s">Guardar</button>', '<style>@keyframes slide{from{left:0}to{left:100px}}</style>'),
  // motion, F-1631: a box moved every frame by script (no CSS animation and no transition declared)
  '/motion-script-bad.html': page('<h1>Pedido</h1><div id="g" style="width:40px;height:40px;background:#888;position:relative">m</div>', '<script>addEventListener("DOMContentLoaded",()=>{let x=0;const g=document.getElementById("g");const f=()=>{x+=2;g.style.left=x+"px";requestAnimationFrame(f)};requestAnimationFrame(f)})</script>'),
  // clean: a box that moves once, as data arriving does, and then rests
  '/motion-script-clean.html': page('<h1>Pedido</h1><div id="g" style="width:40px;height:40px;background:#888;position:relative">m</div>', '<script>addEventListener("DOMContentLoaded",()=>{setTimeout(()=>{document.getElementById("g").style.left="40px"},300)})</script>'),
  // clean: the same animation only where the person has not asked for reduced motion
  '/motion-clean.html': page('<h1>Pedido</h1><div style="width:40px;height:40px;background:#888;position:relative" class="m">m</div><button>Guardar</button>', '<style>@keyframes slide{from{left:0}to{left:100px}}@media (prefers-reduced-motion:no-preference){.m{animation:slide 1s linear infinite}}</style>'),
};
