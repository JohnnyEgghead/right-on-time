// SPDX-License-Identifier: AGPL-3.0-or-later
// Planted known-bad and clean fixture pages for the walker proofs. Served by a local http server in the tests.
import type { Catalog } from './walkers.ts';

const page = (lang: string, body: string, head = '') =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>fixture</title>${head}</head><body><main>${body}</main></body></html>`;

export const catalog: Catalog = {
  en: { save: 'Save changes', cancel: 'Cancel', total: 'Total', jobs: '{count} jobs today', 'service.furnace_tune_up.screen': 'Furnace tune-up' },
  es: { save: 'Guardar cambios', cancel: 'Cancelar', total: 'Total', jobs: '{count} trabajos hoy', 'service.furnace_tune_up.screen': 'Revision del calentador' },
};

export const fixtures: Record<string, string> = {
  // axe-scan: an unlabeled button (button-name, critical)
  '/axe-bad.html': page('en', '<h1>Pedido</h1><button></button>'),
  '/axe-clean.html': page('en', '<h1>Pedido</h1><button>Guardar</button>'),
  // OA-84: a contrast violation only; axe-scan must not fail it
  '/axe-contrast.html': page(
    'en',
    '<h1>Pedido</h1><p style="color:#eeeeee;background:#ffffff">pale gray text on white</p><button>Guardar</button>',
  ),
  // tap-target-44: a 40 px button
  '/tap-bad.html': page('en', '<button style="width:120px;height:40px">Guardar</button>'),
  '/tap-clean.html': page('en', '<button style="width:120px;height:44px">Guardar</button>'),
  // tap-target-44: a menu option, a listbox option and a label under 44 px (the selector must reach the ARIA roles and label)
  '/tap-menu-bad.html': page(
    'en',
    '<div role="menu"><div role="menuitem" tabindex="-1" style="width:120px;height:40px">Editar</div></div>' +
      '<div role="listbox"><div role="option" style="width:120px;height:40px">Uno</div></div>' +
      '<label style="display:block;width:120px;height:40px">Nombre<input style="width:44px;height:44px"></label>',
  ),
  '/tap-menu-clean.html': page(
    'en',
    '<div role="menu"><div role="menuitem" tabindex="-1" style="width:120px;height:44px">Editar</div></div>' +
      '<div role="listbox"><div role="option" style="width:120px;height:44px">Uno</div></div>' +
      '<label style="display:block;width:120px;height:44px">Nombre<input style="width:44px;height:44px"></label>',
  ),
  // outside-origin-guard: a page that fetches https://example.com
  '/origin-bad.html': page('en', '<p id="o">x</p><script>fetch("https://example.com/").catch(function(){});</script>'),
  '/origin-clean.html': page('en', '<p id="o">x</p><script>fetch("/ok.txt").catch(function(){});</script>'),
  '/ok.txt': 'ok',
  // outside-origin-guard: a service worker script the guard must refuse to register
  '/sw.js': [
    'self.addEventListener("install", function (e) { e.waitUntil(self.skipWaiting()); });',
    'self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });',
    'self.addEventListener("fetch", function (e) { if (new URL(e.request.url).pathname === "/ok.txt") e.respondWith(new Response("from-sw")); });',
  ].join('\n'),
  // spanish-fallback-pass: a Spanish page holding 1 English catalog value ("Save changes")
  '/es-bad.html': page('es', '<h1>Pedido</h1><button>Save changes</button><button>Cancelar</button><p>Total</p>'),
  '/es-clean.html': page('es', '<h1>Pedido</h1><button>Guardar cambios</button><button>Cancelar</button><p>Total</p>'),
  // spanish-fallback-pass: an ICU value rendered with its argument filled in, and a value split across inline elements
  '/es-icu-bad.html': page('es', '<h1>Pedido</h1><p>3 jobs today</p>'),
  '/es-split-bad.html': page('es', '<h1>Pedido</h1><button>Save <b>changes</b></button>'),
  '/es-icu-attr-bad.html': page('es', '<h1>Pedido</h1><button aria-label="3 jobs today">&#9733;</button>'),
  '/es-icu-attr-clean.html': page('es', '<h1>Pedido</h1><button aria-label="3 trabajos hoy">&#9733;</button>'),
  // spanish-fallback-pass, F-658: text inside an element whose lang names another language is data in that language (a customer's text);
  // the same words outside such an element still count.
  '/es-lang-part.html': page('es', '<h1>Pedido</h1><p lang="en" title="Save changes">Save changes now</p><button>Cancelar</button>'),
  '/es-lang-part-bad.html': page('es', '<h1>Pedido</h1><p lang="en">Save changes now</p><button>Save changes</button>'),
  // spanish-fallback-pass, F-713: a stored code (a snake_case segment of a catalog key) shown raw on the page
  '/es-code-bad.html': page('es', '<h1>Pedido</h1><p>Trabajo: furnace_tune_up</p>'),
  '/es-code-clean.html': page('es', '<h1>Pedido</h1><p>Trabajo: Revision del calentador, furnace tune up</p>'),
  '/es-icu-clean.html': page('es', '<h1>Pedido</h1><p>3 trabajos hoy</p>'),
  // overflow-pass: a label clipped at 520 x 980
  '/overflow-bad.html': page(
    'es',
    '<div id="label" style="width:200px;overflow:hidden;white-space:nowrap">Confirmar la llegada del tecnico a la direccion indicada del cliente</div>',
  ),
  // F-310: a label that fits with 3 px to spare in the machine's own font, so only a wider font (or the wide-font probe) clips it.
  // The box is sized from the text's own width in a script, so the fixture means the same on any machine.
  '/overflow-tight.html': page(
    'es',
    '<div id="label" style="overflow:hidden;white-space:nowrap">Confirmar la llegada del tecnico a la direccion indicada del cliente</div>' +
      '<script>const l=document.getElementById("label");l.style.display="inline-block";l.style.width=(l.scrollWidth+3)+"px";</script>',
  ),
  '/overflow-clean.html': page(
    'es',
    '<div id="label" style="width:200px;overflow:hidden">Confirmar la llegada del tecnico a la direccion indicada del cliente</div>',
  ),
};
