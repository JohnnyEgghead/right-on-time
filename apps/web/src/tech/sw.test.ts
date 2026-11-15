// SPDX-License-Identifier: AGPL-3.0-or-later
// The web technician app's service worker (src/tech/sw.js; SPECIFICATIONS SD-47) run as written in a Node vm with a
// worker global of its own: its fetch, cache and message handlers over an in-memory Cache Storage and a scripted network.
// The real browsers run it in the stack suite (ci/gates/G-CI1/client: an open with no signal).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { embedsServerState, SERVER_STATE_HEADER } from './server-state.ts';
import { TECH_MANIFEST, TECH_MANIFEST_PATH, TECH_SW_PATH, techShellAsset, workerSource } from './shell-assets.ts';

const ORIGIN = 'https://bw.example';
type Handler = (e: unknown) => void;

/** 1 worker over its Cache Storage: `stores` shared with an earlier worker is the same browser after a deploy of build `build`. */
function worker(stores = new Map<string, Map<string, Response>>(), build?: string) {
  const handlers = new Map<string, Handler>();
  const net: { down: boolean; answer: (url: string) => Response; seen: string[]; hold: Promise<void> | null } = { down: false, answer: () => new Response('ok', { status: 200 }), seen: [], hold: null };
  const keyOf = (r: Request | string) => (typeof r === 'string' ? r : r.url);
  const cacheOf = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      match: async (r: Request | string) => m.get(keyOf(r))?.clone(),
      put: async (r: Request | string, res: Response) => { m.set(keyOf(r), res); },
      keys: async () => [...m.keys()].map((url) => ({ url })),
      delete: async (r: Request | string) => m.delete(keyOf(r)),
    };
  };
  const self = {
    location: new URL(`${ORIGIN}/tech/sw.js`),
    addEventListener: (t: string, h: Handler) => handlers.set(t, h),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  const fetchFn = async (input: Request | string) => {
    const url = keyOf(input);
    net.seen.push(url);
    if (net.hold) await net.hold;
    if (net.down) throw new TypeError('offline');
    const res = net.answer(url);
    Object.defineProperty(res, 'type', { value: 'basic' });
    return res;
  };
  /** The worker's timers, fired by hand: the open's time limit (F-952) is not waited out. */
  const timers: { ms: number; fire: () => void }[] = [];
  const ctx = vm.createContext({
    self, fetch: fetchFn, URL, Response, Request, Promise, Array, Set,
    setTimeout: (fire: () => void, ms: number) => { timers.push({ ms, fire }); return timers.length; },
    caches: { open: async (n: string) => cacheOf(n), keys: async () => [...stores.keys()], delete: async (n: string) => stores.delete(n) },
  });
  const src = readFileSync(path.join(import.meta.dirname, 'sw.js'));
  vm.runInContext(build ? workerSource(src, build).toString() : src.toString('utf8'), ctx);
  /** 1 fetch event: what the worker answered with, or null when it left the request to the browser. */
  const request = async (url: string, mode = 'cors', method = 'GET'): Promise<Response | null> => {
    let answered: Promise<Response> | null = null;
    handlers.get('fetch')!({ request: { url, mode, method }, respondWith: (p: Promise<Response>) => { answered = p; }, waitUntil: () => undefined });
    return answered ? await answered : null;
  };
  const message = async (data: unknown) => {
    let done: Promise<unknown> = Promise.resolve();
    handlers.get('message')!({ data, waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
  };
  const activate = async () => {
    let done: Promise<unknown> = Promise.resolve();
    handlers.get('activate')!({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
  };
  return { request, message, activate, net, stores, timers };
}

describe('the service worker (SD-47)', () => {
  // why: SD-47 API answers are never cached by the service worker: an API call is never even handled, with or without signal
  it('never handles an API call, a write or another origin, so no API answer is ever stored', async () => {
    const w = worker();
    expect(await w.request(`${ORIGIN}/api/v1/tech/items`)).toBeNull();
    expect(await w.request(`${ORIGIN}/api/v1/me`, 'navigate')).toBeNull();
    expect(await w.request(`${ORIGIN}/tech`, 'navigate', 'POST')).toBeNull();
    expect(await w.request('https://other.example/_next/static/a.js')).toBeNull();
    await w.message({ type: 'keep', urls: ['/api/v1/me', `${ORIGIN}/api/v1/clock`] });
    expect([...w.stores.values()].flatMap((m) => [...m.keys()]).filter((k) => k.includes('/api/'))).toEqual([]);
  });
  // why: FR-TECH-4, SD-47 a technician page opened with no signal opens from the kept shell, its static files from the cache
  it('keeps the last good copy of a /tech page and its static files, and answers them with no signal', async () => {
    const w = worker();
    w.net.answer = (url) => new Response(url.includes('/tech') ? '<html>today</html>' : 'js', { status: 200 });
    expect(await (await w.request(`${ORIGIN}/tech`, 'navigate'))?.text()).toBe('<html>today</html>');
    expect(await (await w.request(`${ORIGIN}/_next/static/chunks/app.js`))?.text()).toBe('js');
    w.net.down = true;
    expect(await (await w.request(`${ORIGIN}/tech?x=1`, 'navigate'))?.text()).toBe('<html>today</html>');
    expect(await (await w.request(`${ORIGIN}/_next/static/chunks/app.js`))?.text()).toBe('js');
    // F-1083: a page with no kept copy is the app's no-signal page, never a rejection (the browser's error page)
    const miss = (await w.request(`${ORIGIN}/tech/map`, 'navigate'))!;
    expect(miss.status).toBe(503);
    expect(await miss.text()).toContain('data-bw-offline');
  });
  // why: SD-47 a redirect to sign in, a refusal or an error page is never kept as the shell
  it('keeps no redirected, refused or failed page answer, and the page\'s keep message stores what it already loaded', async () => {
    const w = worker();
    w.net.answer = () => {
      const r = new Response('sign in', { status: 200 });
      Object.defineProperty(r, 'redirected', { value: true });
      return r;
    };
    await w.request(`${ORIGIN}/tech`, 'navigate');
    w.net.answer = () => new Response('no', { status: 500 });
    await w.request(`${ORIGIN}/tech/me`, 'navigate');
    expect([...(w.stores.get('bw-tech-shell-v1')?.keys() ?? [])]).toEqual([]);
    w.net.answer = (url) => new Response(url, { status: 200 });
    await w.message({ type: 'keep', urls: ['/tech', `${ORIGIN}/_next/static/css/a.css`, '/office/board'] });
    expect([...(w.stores.get('bw-tech-shell-v1')?.keys() ?? [])]).toEqual([`${ORIGIN}/tech`]);
    expect([...(w.stores.get('bw-tech-assets-v1')?.keys() ?? [])]).toEqual([`${ORIGIN}/_next/static/css/a.css`]);
    await w.message({ type: 'forget' });
    expect(w.stores.size).toBe(0);
  });
});

describe('what the service worker keeps (F-952)', () => {
  // why: F-952 a /tech open with a kept copy and a weak signal does not wait for the browser's own network timeout
  it('opens the kept copy after the time limit when the network does not answer, and keeps the late answer', async () => {
    const w = worker();
    w.net.answer = () => new Response('<html>v1</html>', { status: 200 });
    await w.request(`${ORIGIN}/tech`, 'navigate');
    let release: () => void = () => undefined;
    w.net.hold = new Promise<void>((r) => { release = r; });
    w.net.answer = () => new Response('<html>v2</html>', { status: 200 });
    const opening = w.request(`${ORIGIN}/tech`, 'navigate');
    await new Promise((r) => setTimeout(r, 0));
    expect(w.timers.map((t) => t.ms)).toEqual([4000]);
    w.timers[0]!.fire();
    expect(await (await opening)?.text()).toBe('<html>v1</html>');
    release();
    await new Promise((r) => setTimeout(r, 0));
    w.net.down = true;
    expect(await (await w.request(`${ORIGIN}/tech`, 'navigate'))?.text()).toBe('<html>v2</html>');
  });
  // why: F-952 the first read of a page rendered on the server is an API answer: such a page is shown, never kept (SD-47)
  it('never keeps a page the server marks as holding an API answer', async () => {
    const w = worker();
    w.net.answer = () => new Response('<html>today with data</html>', { status: 200, headers: { 'x-bw-server-state': '1' } });
    expect(await (await w.request(`${ORIGIN}/tech`, 'navigate'))?.text()).toBe('<html>today with data</html>');
    await w.message({ type: 'keep', urls: ['/tech'] });
    expect([...(w.stores.get('bw-tech-shell-v1')?.keys() ?? [])]).toEqual([]);
  });
  // why: F-952 a superseded static file no kept page names is dropped on activate; the files the kept page names stay
  it('drops, on activate, the kept static files that no kept page names', async () => {
    const w = worker();
    w.net.answer = (url) => new Response(url.includes('/_next/') ? 'js' : '<script src="/_next/static/chunks/new.js"></script>', { status: 200 });
    await w.request(`${ORIGIN}/tech`, 'navigate');
    await w.request(`${ORIGIN}/_next/static/chunks/old.js`);
    await w.request(`${ORIGIN}/_next/static/chunks/new.js`);
    await w.activate();
    expect([...(w.stores.get('bw-tech-assets-v1')?.keys() ?? [])]).toEqual([`${ORIGIN}/_next/static/chunks/new.js`]);
  });
  // why: F-980 a page that embeds an API-100 read carries the mark and is never kept; the worker keeps the page's shell variant, so an open with no signal still opens
  it('never keeps a page with an embedded API-100 read, keeps its shell variant under the page address, and opens that with no signal', async () => {
    const w = worker();
    const day = JSON.stringify({ data: { date: '2026-09-15', van: '12', jobs: [{ jobNumber: 24830, customer: { name: 'Harold Jenkins' } }] } });
    w.net.answer = (url) => (url.includes('bw-shell=1')
      ? new Response('<html>shell</html>', { status: 200 })
      : new Response(`<html><script type="application/json">${day}</script></html>`, { status: 200, headers: { 'x-bw-server-state': '1' } }));
    expect(await (await w.request(`${ORIGIN}/tech`, 'navigate'))?.text()).toContain('Harold Jenkins');
    await w.message({ type: 'keep', urls: ['/tech'] });
    expect(w.net.seen).toContain(`${ORIGIN}/tech?bw-shell=1`);
    const kept = [...w.stores.values()].flatMap((m) => [...m.values()]);
    expect(kept.length).toBe(1);
    expect(await kept[0]!.clone().text()).toBe('<html>shell</html>');
    w.net.down = true;
    expect(await (await w.request(`${ORIGIN}/tech`, 'navigate'))?.text()).toBe('<html>shell</html>');
  });
  // why: F-979 a file named only inside a kept style sheet (the kit's Inter font) is kept when the sheet is named by a kept page; an unnamed file is dropped
  it('keeps, on activate, a font that only a kept style sheet names, and still drops an unnamed file', async () => {
    const w = worker();
    w.net.answer = (url) => new Response(url.endsWith('.css') ? '@font-face { src: url(../media/inter.woff2) format("woff2"); }' : url.includes('/_next/') ? 'bin' : '<link href="/_next/static/css/kit.css">', { status: 200 });
    await w.request(`${ORIGIN}/tech`, 'navigate');
    await w.request(`${ORIGIN}/_next/static/css/kit.css`);
    await w.request(`${ORIGIN}/_next/static/media/inter.woff2`);
    await w.request(`${ORIGIN}/_next/static/media/old.woff2`);
    await w.activate();
    expect([...(w.stores.get('bw-tech-assets-v1')?.keys() ?? [])].sort()).toEqual([`${ORIGIN}/_next/static/css/kit.css`, `${ORIGIN}/_next/static/media/inter.woff2`]);
  });
  // why: F-952 with no kept page to compare against, activate drops nothing
  it('drops no static file on activate when no page is kept', async () => {
    const w = worker();
    await w.request(`${ORIGIN}/_next/static/chunks/a.js`);
    await w.activate();
    expect([...(w.stores.get('bw-tech-assets-v1')?.keys() ?? [])]).toEqual([`${ORIGIN}/_next/static/chunks/a.js`]);
  });
});

describe('the day\'s pages with no signal (F-1083)', () => {
  const en = JSON.parse(readFileSync(path.join(import.meta.dirname, '../../../../packages/i18n/catalog/en.json'), 'utf8')) as Record<string, string>;
  const page = (url: string) => `<html><link rel="stylesheet" href="/_next/static/chunks/kit.css"><script src="/_next/static/chunks/${new URL(url).pathname.split('/').pop()}.js"></script>${url}</html>`;
  const site = (url: string) => (url.endsWith('.css') ? new Response('@font-face { src: url(../media/inter.woff2) }', { status: 200 })
    : url.includes('/_next/') ? new Response('bin', { status: 200 }) : new Response(page(url), { status: 200 }));

  // why: F-1083 (FR-TECH-4) with no signal the owner opened Add note, a page he had never opened: the worker's answer rejected and the iPhone showed "FetchEvent.respondWith received an error"
  it('answers a page it does not hold with the app\'s no-signal page, never a rejection; a job\'s page says the job is not on the phone', async () => {
    const w = worker();
    w.net.down = true;
    const own = (await w.request(`${ORIGIN}/tech/jobs/24830`, 'navigate'))!;
    expect([own.status, own.headers.get('content-type')]).toEqual([503, 'text/html; charset=utf-8']);
    const html = await own.text();
    expect(html).toContain('<main data-bw-offline="1"><h1>No signal</h1><p>This job is not on this phone yet. Connect to load it.</p><a href="/tech">Back to Today</a></main>');
    expect(html).toContain('<html lang="en">');
    const me = await (await w.request(`${ORIGIN}/tech/me`, 'navigate'))!.text();
    expect(me).toContain('<h1>No signal</h1><a href="/tech">Back to Today</a>');
    expect([...w.stores.values()].flatMap((m) => [...m.keys()])).toEqual([]);
  });
  // why: F-1083 the worker's own words before any page sent them are the English catalog's, so the no-signal page never shows other words
  it('starts with the English catalog\'s words, and uses the words a page sent in the person\'s language, escaped', async () => {
    const src = readFileSync(path.join(import.meta.dirname, 'sw.js'), 'utf8');
    expect(src).toContain(`noSignal: '${en['tech.sync.noSignal']}', notOnPhone: '${en['tech.job.notOnPhone']}', screenNotOnPhone: '${en['tech.job.screenNotOnPhone']}', back: '${en['tech.job.backToToday']}'`);
    const w = worker();
    w.net.down = true;
    await w.message({ type: 'fill', urls: [], words: { lang: 'es', noSignal: 'Sin señal', notOnPhone: 'Este trabajo <b>todavía</b> no está', back: 'Volver a Hoy' } });
    const html = await (await w.request(`${ORIGIN}/tech/jobs/24830`, 'navigate'))!.text();
    expect(html).toContain('<html lang="es">');
    expect(html).toContain('<h1>Sin señal</h1><p>Este trabajo &lt;b&gt;todavía&lt;/b&gt; no está</p><a href="/tech">Volver a Hoy</a>');
    await w.message({ type: 'fill', urls: [], words: { lang: 'fr', noSignal: 1 } });
    expect(await (await w.request(`${ORIGIN}/tech/me`, 'navigate'))!.text()).toContain('<h1>Sin señal</h1>');
  });
  // why: F-1083 (FR-TECH-4, FR-TECH-10) the day's pages are kept while there is signal, each with the files it names, so each opens with none
  it('keeps each page of the day it is sent, with its scripts, styles and the font a style names, and opens each with no signal', async () => {
    const w = worker();
    w.net.answer = site;
    const pages = ['/tech', '/tech/map', '/tech/jobs/24830', '/tech/jobs/24830/note', '/tech/jobs/24830/photo'];
    await w.message({ type: 'fill', urls: [...pages, '/office/board', 'https://other.example/tech/me', '/api/v1/tech/day'] });
    expect(w.net.seen.filter((u) => !u.includes('/_next/'))).toEqual(pages.map((p) => `${ORIGIN}${p}?bw-shell=1`));
    expect([...(w.stores.get('bw-tech-shell-v1')?.keys() ?? [])]).toEqual(pages.map((p) => `${ORIGIN}${p}`));
    expect([...(w.stores.get('bw-tech-assets-v1')?.keys() ?? [])].sort()).toEqual([
      'kit.css', 'map.js', 'media/inter.woff2', 'note.js', 'photo.js', 'tech.js', '24830.js'].map((f) => `${ORIGIN}/_next/static/${f.startsWith('media/') ? f : `chunks/${f}`}`).sort());
    w.net.down = true;
    for (const p of pages) expect(await (await w.request(`${ORIGIN}${p}?from=1`, 'navigate'))?.text()).toBe(page(`${ORIGIN}${p}?bw-shell=1`));
    expect(await (await w.request(`${ORIGIN}/_next/static/chunks/note.js`))?.text()).toBe('bin');
  });
  // why: F-1268 the no-signal page draws the kit's Inter from the font file the worker keeps, not from a family name a phone may lack
  it('names the kept Inter file in an @font-face on the no-signal page, and none when no font is kept', async () => {
    const w = worker();
    w.net.answer = site;
    await w.message({ type: 'fill', urls: ['/tech'] });
    w.net.down = true;
    const html = await (await w.request(`${ORIGIN}/tech/jobs/24830/note`, 'navigate'))!.text();
    expect(html).toContain('@font-face{font-family:Inter;src:url("/_next/static/media/inter.woff2") format("woff2")');
    expect(html).toContain('font:14px/1.4 Inter,sans-serif');
    const b = worker();
    b.net.down = true;
    const bare = await (await b.request(`${ORIGIN}/tech/jobs/24830/note`, 'navigate'))!.text();
    expect(bare).not.toContain('@font-face');
  });
  // why: F-1083 every technician screen sends the list at each open: a page already kept under this build is not fetched again; a new build keeps them again
  it('fetches a page it already kept under this build no more, and keeps it again under a new build', async () => {
    const w = worker();
    w.net.answer = site;
    await w.message({ type: 'fill', urls: ['/tech/jobs/24830/note'] });
    const first = w.net.seen.length;
    expect(first).toBeGreaterThan(0);
    await w.message({ type: 'fill', urls: ['/tech/jobs/24830/note'] });
    expect(w.net.seen.length).toBe(first);
    const next = worker(w.stores, 'build-2');
    next.net.answer = site;
    await next.activate();
    expect([...w.stores.keys()].filter((k) => k.startsWith('bw-tech-filled-'))).toEqual([]);
    await next.message({ type: 'fill', urls: ['/tech/jobs/24830/note'] });
    expect(next.net.seen).toContain(`${ORIGIN}/tech/jobs/24830/note?bw-shell=1`);
  });
  // why: F-1083 a fill with no signal keeps nothing and records nothing, so the next open with signal keeps the page; a name that is no file does not refill the page at each open
  it('keeps nothing with no signal and fills the page at the next open with signal; a named file that answers an error is passed over', async () => {
    const w = worker();
    w.net.down = true;
    await w.message({ type: 'fill', urls: ['/tech/parts'] });
    expect([...w.stores.values()].flatMap((m) => [...m.keys()]).filter((k) => !k.endsWith('__bw-no-signal-words'))).toEqual([]);
    w.net.down = false;
    w.net.answer = (url) => (url.includes('missing') ? new Response('no', { status: 404 }) : new Response('<script src="/_next/static/chunks/missing.js"></script>', { status: 200 }));
    await w.message({ type: 'fill', urls: ['/tech/parts'] });
    expect([...(w.stores.get('bw-tech-shell-v1')?.keys() ?? [])]).toEqual([`${ORIGIN}/tech/parts`]);
    const seen = w.net.seen.length;
    await w.message({ type: 'fill', urls: ['/tech/parts'] });
    expect(w.net.seen.length).toBe(seen);
  });
  // why: F-1083, F-937 sign-out drops every kept page, the fill record and the words; a fill under way when it came keeps nothing after it
  it('drops the fill record with the kept pages at sign-out, and a fill under way keeps nothing after it', async () => {
    const w = worker();
    w.net.answer = site;
    await w.message({ type: 'fill', urls: ['/tech/me'], words: { lang: 'es', noSignal: 'Sin señal', notOnPhone: 'x', back: 'Volver a Hoy' } });
    let release: () => void = () => undefined;
    w.net.hold = new Promise<void>((r) => { release = r; });
    const under = w.message({ type: 'fill', urls: ['/tech/map'] });
    await new Promise((r) => setTimeout(r, 0));
    await w.message({ type: 'forget' });
    release();
    await under;
    expect([...w.stores.values()].flatMap((m) => [...m.keys()])).toEqual([]);
  });
});

describe('what the day\'s fill keeps and drops (F-1099, F-1100, F-1101)', () => {
  const page = (url: string) => `<html><script src="/_next/static/chunks/${new URL(url).pathname.split('/').pop()}.js"></script>${url}</html>`;
  const site = (url: string) => (url.includes('/_next/') ? new Response('bin', { status: 200 }) : new Response(page(url), { status: 200 }));
  const shellKeys = (w: ReturnType<typeof worker>) => [...(w.stores.get('bw-tech-shell-v1')?.keys() ?? [])].map((k) => k.replace(ORIGIN, ''));
  const assetKeys = (w: ReturnType<typeof worker>) => [...(w.stores.get('bw-tech-assets-v1')?.keys() ?? [])].map((k) => k.replace(`${ORIGIN}/_next/static/chunks/`, ''));

  // why: F-1099 the fill added 5 pages per job of every day and nothing dropped them: after a complete fill the job pages it was not sent go, and the next activate frees the files only they named
  it('drops the job pages a complete fill was not sent, and at the next activate the files only they named', async () => {
    const w = worker();
    w.net.answer = site;
    const day1 = ['/tech', '/tech/jobs/100', '/tech/jobs/100/note'];
    await w.message({ type: 'fill', urls: day1, complete: true });
    expect(shellKeys(w)).toEqual(day1);
    const day2 = ['/tech', '/tech/jobs/200', '/tech/jobs/200/note'];
    await w.message({ type: 'fill', urls: day2, complete: true });
    expect(shellKeys(w).sort()).toEqual(day2.sort());
    expect(assetKeys(w).sort()).toEqual(['100.js', '200.js', 'note.js', 'tech.js']);
    await w.activate();
    expect(assetKeys(w).sort()).toEqual(['200.js', 'note.js', 'tech.js']);
  });

  // why: F-1099 a fill that is not complete (a page could not be kept) or is not sent as the whole list drops nothing, so no page the phone needs is lost to a weak signal
  it('drops nothing when the fill is incomplete or not marked complete', async () => {
    const w = worker();
    w.net.answer = site;
    await w.message({ type: 'fill', urls: ['/tech/jobs/100'], complete: true });
    await w.message({ type: 'fill', urls: ['/tech/jobs/200'] });
    expect(shellKeys(w).sort()).toEqual(['/tech/jobs/100', '/tech/jobs/200']);
    w.net.down = true;
    await w.message({ type: 'fill', urls: ['/tech/jobs/300'], complete: true });
    expect(shellKeys(w).sort()).toEqual(['/tech/jobs/100', '/tech/jobs/200']);
  });

  // why: F-1100 the no-signal page said the job is not on the phone on Add note, Add photo, Finish and Directions too, a fact the worker cannot know: only the job's own page says it
  it('says the job is not on the phone only on the job\'s own page, and the screen is not on the phone elsewhere', async () => {
    const w = worker();
    w.net.down = true;
    const own = await (await w.request(`${ORIGIN}/tech/jobs/24830`, 'navigate'))!.text();
    expect(own).toContain('<p>This job is not on this phone yet. Connect to load it.</p>');
    for (const sub of ['note', 'photo', 'finish', 'directions']) {
      const html = await (await w.request(`${ORIGIN}/tech/jobs/24830/${sub}`, 'navigate'))!.text();
      expect(html, sub).toContain('<p>This screen is not on this phone yet. Connect to load it.</p>');
      expect(html, sub).not.toContain('This job is not');
    }
    expect(await (await w.request(`${ORIGIN}/tech/me`, 'navigate'))!.text()).not.toContain('<p>');
  });

  // why: F-1101 a forget that lands while a page's text is read keeps nothing after it: the page, then its files, were put after the sign-out
  it('keeps nothing when a forget is released during the page\'s text read', async () => {
    const w = worker();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    w.net.answer = (url) => (url.includes('/_next/') ? new Response('bin') : new Response(new ReadableStream({
      async pull(c) {
        await gate;
        c.enqueue(new TextEncoder().encode(page(url)));
        c.close();
      },
    }), { status: 200 }));
    const under = w.message({ type: 'fill', urls: ['/tech/jobs/100'] });
    await new Promise((r) => setTimeout(r, 0));
    await w.message({ type: 'forget' });
    release();
    await under;
    expect([...w.stores.values()].flatMap((m) => [...m.keys()])).toEqual([]);
  });
});

describe('the build stamp and the server-state mark (F-979, F-980)', () => {
  // why: F-979 a deploy that changes nothing in sw.js still changes the bytes the browser compares: the worker is served with the build's id
  it('serves the worker with the build id in its place, so 2 builds serve different bytes', () => {
    const src = readFileSync(path.join(import.meta.dirname, 'sw.js'));
    const a = workerSource(src, 'build-a').toString();
    const b = workerSource(src, 'build-b').toString();
    expect(a).toContain("const BUILD = 'build-a';");
    expect(a).not.toContain('__BW_BUILD__');
    expect(a).not.toBe(b);
    expect(techShellAsset(TECH_SW_PATH, () => src, () => 'x1')?.body.toString()).toContain("'x1'");
  });
  // why: F-980 the Today page (SCR-TEC-02) embeds API-100 and is marked; its shell variant, other screens and an unknown screen are not
  it('marks the Today page and not its shell variant', () => {
    expect(embedsServerState('SCR-TEC-02', '/tech')).toBe(true);
    expect(embedsServerState('SCR-TEC-02', '/tech?x=1')).toBe(true);
    expect(embedsServerState('SCR-TEC-02', '/tech?bw-shell=1')).toBe(false);
    expect(embedsServerState('SCR-TEC-01', '/tech/sign-in')).toBe(false);
    expect(SERVER_STATE_HEADER).toBe('x-bw-server-state');
  });
});

describe('the shell files the web process serves (NFR-09)', () => {
  // why: NFR-09 the manifest installs the app at /tech, standalone; the worker may control /tech and is never HTTP-cached
  it('answers the manifest and the worker with their types and headers, and nothing for any other path', () => {
    const m = techShellAsset(TECH_MANIFEST_PATH)!;
    expect([m.headers['content-type'], JSON.parse(m.body.toString())]).toEqual(['application/manifest+json; charset=utf-8', TECH_MANIFEST]);
    expect(TECH_MANIFEST).toMatchObject({ start_url: '/tech', scope: '/tech', display: 'standalone' });
    // F-1231: the web clip's Home Screen name differs from the iPhone app's "Right On Time".
    expect(TECH_MANIFEST).toMatchObject({ name: 'Right On Time Web', short_name: 'Right On Time Web' });
    expect(TECH_MANIFEST.icons.map((i) => [i.src, i.sizes])).toEqual([['/tech/icons/icon-180.png', '180x180'], ['/tech/icons/icon-192.png', '192x192'], ['/tech/icons/icon-512.png', '512x512']]);
    const sw = techShellAsset(TECH_SW_PATH)!;
    expect(sw.headers).toMatchObject({ 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'service-worker-allowed': '/tech' });
    expect(sw.body.toString()).toContain("url.pathname.startsWith('/api/')");
    expect(techShellAsset('/tech')).toBeNull();
    expect(techShellAsset('/tech/sw.js.map')).toBeNull();
  });
});
