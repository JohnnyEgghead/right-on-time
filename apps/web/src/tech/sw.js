// SPDX-License-Identifier: AGPL-3.0-or-later
// The web technician app's service worker (SPECIFICATIONS SD-47: "a hand-written service worker caches the app shell,
// fonts and catalog; API answers are never cached by the service worker"). Served by the web process at /tech/sw.js
// with Service-Worker-Allowed: /tech, registered with scope /tech (src/tech/TechAppFrame.tsx).
//   /api/...                  never handled: every API call goes to the network, and its answer is never stored
//   /_next/static/...         cache first: the app's scripts, styles, fonts and the message catalog they carry are
//                             content-hashed and never change under a name
//   a /tech page (navigation) network first: a fresh page with signal, kept as the last good copy of that page; with
//                             no signal, or no answer within OPEN_TIMEOUT_MS, the kept copy opens, so the app opens with its
//                             waiting items (UI-SPECIFICATION 4.5; F-952); the late answer still refreshes the kept copy. With no
//                             signal and no kept copy, the app's no-signal page answers, never the browser's error page (F-1083)
//   anything else             never handled
// Only a 200 same-origin answer that was not redirected is kept (a signed-out open answers a redirect to sign in), and never
// a page that carries an API answer: the server marks such a page with the header X-Bw-Server-State (SD-47: API answers are
// never cached by the service worker; the first read of a page rendered on the server is one). F-952.
// On activate, a kept static file that no kept page names is dropped, so the origin's storage does not grow with each deploy.
// The page tells the worker which files it already loaded before the worker took control ({type: 'keep'}), so the
// first open with signal already leaves an openable shell. {type: 'forget'} drops every kept copy (sign-out).
// F-1083: a page visited with signal is not enough: with no signal the technician opens pages never opened before (Add note, Add photo,
// another tab). Each page also names the day's pages ({type: 'fill'}: Today, the tabs, Waiting and each job's pages, src/tech/offline-pages.ts)
// with the no-signal page's words in the person's language; the worker keeps each one it has not kept under this build, with the static
// files it names, while there is signal.
// F-979: the web process serves this file with the build's id here (src/tech/shell-assets.ts), so every deploy changes the bytes
// the browser compares, the new worker installs and activates, and the activate pass below prunes that deploy's superseded files.
const BUILD = '__BW_BUILD__';
const SHELL = 'bw-tech-shell-v1';
const ASSETS = 'bw-tech-assets-v1';
// F-1083: the pages the fill pass kept under this build, and the no-signal page's words. A deploy starts a new record (activate drops the
// old one), so the day's pages are kept again with that build's files.
const FILLED = `bw-tech-filled-${BUILD}`;
const OURS = [SHELL, ASSETS, FILLED];
const OPEN_TIMEOUT_MS = 4000;
const SERVER_STATE_HEADER = 'x-bw-server-state';
const WORDS_PATH = '/tech/__bw-no-signal-words';
/** F-1083: the no-signal page's words before any page has sent them: the English catalog's (packages/i18n/catalog/en.json; sw.test.ts holds them to it). */
const DEFAULT_WORDS = { lang: 'en', noSignal: 'No signal', notOnPhone: 'This job is not on this phone yet. Connect to load it.', screenNotOnPhone: 'This screen is not on this phone yet. Connect to load it.', back: 'Back to Today' };
const WORD_KEYS = Object.keys(DEFAULT_WORDS);

const isTechPage = (url) => url.pathname === '/tech' || url.pathname.startsWith('/tech/');
const isJobPage = (url) => /^\/tech\/jobs\/[1-9]\d{0,9}(\/|$)/.test(url.pathname);
/** The job's own page, /tech/jobs/{n}: the only page whose no-signal line may say the job is not on the phone (F-1100). */
const isJobOwnPage = (url) => /^\/tech\/jobs\/[1-9]\d{0,9}\/?$/.test(url.pathname);
const isStatic = (url) => url.pathname.startsWith('/_next/static/');
const keepable = (res) => res && res.status === 200 && res.type === 'basic' && !res.redirected && !res.headers.get(SERVER_STATE_HEADER);
const pageKey = (url) => url.origin + url.pathname;
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** Changes at each forget (sign-out): a fill that began before it keeps nothing after it. */
let epoch = 0;
/** 1 fill at a time: the next one finds what the last one kept. */
let filling = Promise.resolve();

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('bw-tech-') && !OURS.includes(k)).map((k) => caches.delete(k))))
      .then(() => dropUnnamedAssets().catch(() => undefined))
      .then(() => self.clients.claim()),
  );
});

/** F-952: the static files a kept page names (its script, style and chunk references), as paths under /_next/. */
async function namedStatic() {
  const shell = await caches.open(SHELL);
  const named = new Set();
  const pages = await shell.keys();
  for (const page of pages) {
    const res = await shell.match(page);
    const text = res ? await res.text() : '';
    for (const m of text.matchAll(/static\/[^"'\s\\)<>?]+/g)) named.add(m[0]);
  }
  // F-979: a file named only inside a kept style sheet (the kit's Inter font, kit.css @font-face) is named too: its url() is resolved
  // against the sheet's own address.
  const assets = await caches.open(ASSETS);
  for (const request of await assets.keys()) {
    const sheet = new URL(request.url);
    if (!sheet.pathname.endsWith('.css') || !named.has(sheet.pathname.slice('/_next/'.length))) continue;
    const res = await assets.match(request);
    const css = res ? await res.text() : '';
    for (const m of css.matchAll(/url\(\s*["']?([^"')\s]+)/g)) {
      try {
        const file = new URL(m[1], sheet);
        if (file.origin === sheet.origin) named.add(file.pathname.slice('/_next/'.length));
      } catch {
        // not a url: nothing to keep
      }
    }
  }
  return { named, pages: pages.length };
}

async function dropUnnamedAssets() {
  const { named, pages } = await namedStatic();
  if (pages === 0) return;
  const assets = await caches.open(ASSETS);
  for (const request of await assets.keys()) {
    const path = new URL(request.url).pathname;
    if (!named.has(path.slice('/_next/'.length))) await assets.delete(request);
  }
}

async function networkFirst(event) {
  const request = event.request;
  const url = new URL(request.url);
  const key = pageKey(url);
  const kept = await (await caches.open(SHELL)).match(key);
  const live = fetch(request).then(async (res) => {
    if (keepable(res)) await (await caches.open(SHELL)).put(key, res.clone());
    return res;
  });
  // F-1083: a rejected answer is the browser's error page ("FetchEvent.respondWith received an error" on an iPhone); the app's own page instead.
  if (!kept) return live.catch(() => noSignalPage(url));
  // F-952: with a kept copy, a weak signal does not hold the open past OPEN_TIMEOUT_MS; the late answer still lands in the cache.
  const late = live.catch(() => kept);
  event.waitUntil(late);
  return Promise.race([late, new Promise((resolve) => setTimeout(() => resolve(kept), OPEN_TIMEOUT_MS))]);
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSETS);
  const kept = await cache.match(request);
  if (kept) return kept;
  const res = await fetch(request);
  if (keepable(res)) await cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (isStatic(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (request.mode === 'navigate' && isTechPage(url)) event.respondWith(networkFirst(event));
});

/**
 * F-1083: the app's no-signal page, for a /tech page the phone does not hold: the words the app's pages sent (the person's language), the
 * job screen's "not on this phone" line on a job's page (UI-SPECIFICATION, SCR-TEC-04 Offline, not saved), and the way back to Today.
 */
async function noSignalPage(url) {
  let w = DEFAULT_WORDS;
  try {
    const res = await (await caches.open(FILLED)).match(self.location.origin + WORDS_PATH);
    if (res) w = { ...DEFAULT_WORDS, ...(await res.json()) };
  } catch {
    // the English words
  }
  // F-1268: the page has no kit sheet, so Inter is drawn from the kit's font file the worker keeps (F-979) when it holds it; with no
  // file kept, the stack's sans-serif is drawn. The stack stays the frame's own string: the look comparator reads the computed family.
  let inter = '';
  try {
    for (const key of await (await caches.open(ASSETS)).keys()) {
      const file = new URL(key.url);
      if (file.origin === self.location.origin && /\/inter[^/]*\.woff2$/i.test(file.pathname)) inter = file.pathname;
    }
  } catch {
    // no font file to name
  }
  const html = `<!doctype html><html lang="${escapeHtml(w.lang)}"><head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0a3a48">'
    // DK-110 SCR-TEC-04 Offline, screen not saved (kit 0.9, F-1144): the frame's .nsp rules and the kit's .r1p-btn.pri, in the kit's own
    // values (the page has no kit sheet to link offline); ci/look-values/tech-job-cases.ts compares this page with the frame.
    + `<title>${escapeHtml(w.noSignal)}</title><style>${inter ? `@font-face{font-family:Inter;src:url("${inter}") format("woff2");font-weight:100 900;font-style:normal}` : ''}`
    + '*{box-sizing:border-box}html,body{margin:0;padding:0}'
    + 'body{background:#f2f4f6;color:#111827;font:14px/1.4 Inter,sans-serif}'
    + 'main{margin:0 auto;max-width:520px;min-height:300px;padding:max(28px,env(safe-area-inset-top)) 16px 28px}'
    + 'h1{margin:0 0 10px;color:#0a3a48;font-size:24px;font-weight:750;letter-spacing:-.01em}p{margin:0 0 22px;font-size:17px;line-height:1.45;color:#111827}'
    + 'a{min-height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;gap:8px;font-size:16px;font-weight:700;'
    + 'border:1.5px solid #0f5e73;background:#0f5e73;color:#fff;text-decoration:none}'
    // The frames' phone rule (F-1137, owner ruling 362101fd): under 720 px a link is a 44 px target.
    + '@media (max-width:720px){a{min-height:44px;min-width:44px}}</style></head>'
    + `<body><main data-bw-offline="1"><h1>${escapeHtml(w.noSignal)}</h1>${isJobPage(url) ? `<p>${escapeHtml(isJobOwnPage(url) ? w.notOnPhone : w.screenNotOnPhone)}</p>` : ''}`
    + `<a href="/tech">${escapeHtml(w.back)}</a></main></body></html>`;
  return new Response(html, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

/** A same-origin /tech page address, or null. */
function techPage(raw) {
  try {
    const url = new URL(raw, self.location.origin);
    return url.origin === self.location.origin && isTechPage(url) ? url : null;
  } catch {
    return null;
  }
}

/**
 * F-1083: the static files a kept page names (its scripts, styles and chunks), and the files those style sheets name (the kit's font), each
 * kept once. False when a file could not be fetched (no signal), so the page is filled again; a name that is no file (an error answer) is
 * passed over, so it does not refill the page at every open.
 */
async function keepNamed(text, from = epoch) {
  const assets = await caches.open(ASSETS);
  const files = [...new Set([...text.matchAll(/static\/[^"'\s\\)<>?]+/g)].map((m) => `${self.location.origin}/_next/${m[0]}`))];
  let all = true;
  for (let i = 0; i < files.length; i += 1) {
    const href = files[i];
    try {
      let res = await assets.match(href);
      if (!res) {
        const got = await fetch(href);
        if (!keepable(got)) continue;
        if (from !== epoch) return false; // F-1101: a forget landed while the file was fetched: nothing is kept after it
        await assets.put(href, got.clone());
        res = got;
      }
      if (!href.endsWith('.css')) continue;
      for (const m of (await res.text()).matchAll(/url\(\s*["']?([^"')\s]+)/g)) {
        try {
          const file = new URL(m[1], href);
          if (file.origin === self.location.origin && isStatic(file) && !files.includes(file.href)) files.push(file.href);
        } catch {
          // not a url: nothing to keep
        }
      }
    } catch {
      all = false;
    }
  }
  return all;
}

/** F-980: a page's shell variant (no embedded API read, so unmarked), kept under the page's own address; F-1083: with the files it names. */
async function keepPage(url, from = epoch) {
  const shellUrl = new URL(url.href);
  shellUrl.searchParams.set('bw-shell', '1');
  const res = await fetch(shellUrl.href, { credentials: 'same-origin', headers: { accept: 'text/html' } });
  if (!keepable(res) || from !== epoch) return false;
  const text = await res.clone().text();
  if (from !== epoch) return false; // F-1101: a forget that landed during the text read keeps nothing after it
  await (await caches.open(SHELL)).put(pageKey(url), res);
  return keepNamed(text, from);
}

async function keep(urls) {
  const assets = await caches.open(ASSETS);
  for (const raw of urls) {
    let url;
    try {
      url = new URL(raw, self.location.origin);
    } catch {
      continue;
    }
    if (url.origin !== self.location.origin) continue;
    try {
      if (isStatic(url)) {
        if (!(await assets.match(url.href))) {
          const res = await fetch(url.href);
          if (keepable(res)) await assets.put(url.href, res);
        }
      } else if (isTechPage(url)) {
        await keepPage(url);
      }
    } catch {
      // no signal now: kept on the next open with signal
    }
  }
}

/** The address key of a job's page (/tech/jobs/{n}, and its Add note, Add photo, Finish and Directions pages): what a complete fill may drop (F-1099). */
const isJobKey = (key) => /^\/tech\/jobs\/[1-9]\d{0,9}(\/|$)/.test(new URL(key).pathname);

/**
 * F-1083: the day's pages, each kept once under this build with its files; the no-signal page's words, kept for that page.
 * F-1099: after a complete fill (every page sent is kept), the job pages that were not sent go (a past day's jobs): the kept pages hold the
 * day and the jobs with an item waiting, so the origin's storage does not grow with each day; the next activate frees the files only they named.
 */
async function fill(urls, words, prune = false) {
  const from = epoch;
  let complete = true;
  const record = await caches.open(FILLED);
  if (words) await record.put(self.location.origin + WORDS_PATH, new Response(JSON.stringify(words), { headers: { 'content-type': 'application/json' } }));
  const shell = await caches.open(SHELL);
  for (const raw of urls) {
    const url = techPage(raw);
    if (!url || from !== epoch) continue;
    const key = pageKey(url);
    if ((await record.match(key)) && (await shell.match(key))) continue;
    try {
      if ((await keepPage(url, from)) && from === epoch) await record.put(key, new Response('1'));
      else complete = false;
    } catch {
      complete = false; // no signal now: the next open with signal fills it
    }
  }
  if (!prune || !complete || from !== epoch) return;
  const sent = new Set(urls.map(techPage).filter(Boolean).map(pageKey));
  for (const request of await shell.keys()) {
    if (isJobKey(request.url) && !sent.has(request.url)) {
      await shell.delete(request);
      await record.delete(request.url);
    }
  }
}

/** The no-signal page's words a page sent: each a string, or none. */
const WORDS_REQUIRED = ['lang', 'noSignal', 'notOnPhone', 'back'];
const wordsOf = (w) => (w && typeof w === 'object' && WORDS_REQUIRED.every((k) => typeof w[k] === 'string') ? Object.fromEntries(WORD_KEYS.filter((k) => typeof w[k] === 'string').map((k) => [k, w[k]])) : null);

self.addEventListener('message', (event) => {
  const m = event.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'keep' && Array.isArray(m.urls)) event.waitUntil(keep(m.urls.filter((u) => typeof u === 'string').slice(0, 400)));
  if (m.type === 'fill' && Array.isArray(m.urls)) {
    const urls = m.urls.filter((u) => typeof u === 'string').slice(0, 400);
    const words = wordsOf(m.words);
    // m.complete: the list is every page the phone should hold now (a page that could not read its day sends none, so nothing is dropped)
    filling = filling.then(() => fill(urls, words, m.complete === true)).catch(() => undefined);
    event.waitUntil(filling);
  }
  if (m.type === 'forget') {
    epoch += 1;
    event.waitUntil(Promise.all(OURS.map((k) => caches.delete(k))));
  }
});
