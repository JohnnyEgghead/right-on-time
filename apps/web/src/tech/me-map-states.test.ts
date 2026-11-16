// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1739, F-1750, F-1758: what Me and Map draw when no day or route is saved, rendered from the preview states the page walkers also reach
// (preview-day.ts). The look is held by ci/look-values; the axe pass by the page walkers. F-1775: the live Me page as app/tech/me/page.tsx renders it,
// over a scripted API-07 at the fetch the page calls (the browsers and the real server read the same page in ci/mapme-stack).
import { cloneElement, createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TechMePage from '../../app/tech/me/page.tsx';
import { ShellIntl } from '../shell/intl.tsx';
import { MAP_PREVIEWS, ME_PREVIEWS } from './preview-day.ts';
import { TechMapScreen } from './TechMapScreen.tsx';
import { TechMeScreen, type TechMeScreenProps } from './TechMeScreen.tsx';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined, refresh: () => undefined }),
  usePathname: () => '/tech/me',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('not found'); },
}));
let incoming: Record<string, string> = {};
vi.mock('next/headers', () => ({ headers: async () => ({ get: (n: string) => incoming[n] ?? null }) }));

const me = (name: string, lang: 'en' | 'es' = 'en'): string => {
  const p = ME_PREVIEWS[name];
  if (!p) throw new Error(`no Me preview ${name}`);
  return renderToStaticMarkup(createElement(ShellIntl, { lang, children: createElement(TechMeScreen, { fixedData: p.data, fixedOutbox: p.outbox }) }));
};
const map = (name: string): string => {
  const p = MAP_PREVIEWS[name];
  if (!p) throw new Error(`no Map preview ${name}`);
  return renderToStaticMarkup(createElement(ShellIntl, { lang: 'en', children: createElement(TechMapScreen, { fixedData: p.data, fixedOutbox: p.outbox }) }));
};

describe('Me with the phone read and no day saved (SCR-TEC-10)', () => {
  // why: F-1739 Loading draws skeletons for the van, the hours and the call number, under the title Today's hours, and never No van assigned, a call button or a trailing separator
  it('Loading shows no No van assigned, no call button and no trailing separator', () => {
    const html = me('loading');
    expect(html).not.toContain('No van assigned');
    expect(html).not.toContain('Not started yet');
    expect(html).not.toMatch(/Today&#x27;s hours - </);
    expect(html).toContain('Today&#x27;s hours</h3>');
    expect(html).not.toContain('CTL-TEC-10-10');
    expect(html).not.toContain('class="call');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-ctl="CTL-TEC-10-02"'); // the sync line is the phone's own
  });

  // why: F-1739 Loading with no demo time yet draws the sync line without the time, never a sentence that ends in a blank value
  it.each(['en', 'es'] as const)('Loading sync line has no blank time (%s)', (lang) => {
    const html = me('loading', lang);
    expect(html).toContain(lang === 'en' ? '<b>All synced</b>' : '<b>Todo enviado</b>');
    expect(html).not.toMatch(/(All synced|Todo enviado) <\/b>/);
  });

  // why: F-1739 Day not loaded draws CMP-12 with Try again in place of the van and hours cards, and leaves the call row out
  it('Day not loaded shows the error panel with Try again and no call row', () => {
    const html = me('error');
    expect(html).toContain('Your van and today&#x27;s hours could not load.');
    expect(html).toContain('data-ctl="CTL-CMP-12-02"');
    expect(html).not.toContain('No van assigned');
    expect(html).not.toContain('class="call');
    expect(html).not.toContain('Call dispatch');
  });

  // why: F-1739 Offline with nothing saved says so in place of the van and hours cards and leaves the call row out
  it('Offline, nothing saved shows its words and no call row', () => {
    const html = me('nosaved');
    expect(html).toContain('No signal and no saved day. Connect once to load your van and today&#x27;s hours.');
    expect(html).not.toContain('No van assigned');
    expect(html).not.toContain('Call dispatch');
  });

  // why: F-1739 FR-LANG-4 the Spanish words of the new states are the catalog's, not the English key
  it('says the Day not loaded words in Spanish', () => {
    expect(me('error', 'es')).toContain('No se pudieron cargar su camioneta y las horas de hoy.');
  });

  // why: F-1740 Reading the phone draws the name, initials and role from the signed-in session, with the branch line a skeleton until the day is read
  it('Reading the phone shows the name, initials and role, and a skeleton for the branch line', () => {
    const html = me('reading');
    expect(html).toContain('Maria Santos');
    expect(html).toContain('<span class="av">MS</span>');
    expect(html).toContain('Technician, heating &amp; cooling');
    expect(html).not.toContain('Columbus');
    expect(html).not.toContain('No van assigned');
  });

  // why: F-1740 the no-day rows draw the profile as Reading the phone does
  it.each(['loading', 'error', 'nosaved'])('%s draws the same profile', (name) => {
    const html = me(name);
    expect(html).toContain('Maria Santos');
    expect(html).toContain('<span class="av">MS</span>');
  });

  // why: F-1739 a saved day still draws the van and the dated hours title (the fix leaves Success alone)
  it('Success still shows the van and the hours', () => {
    const html = me('success');
    expect(html).toContain('Van ');
    expect(html).toContain('class="call');
  });
});

describe('Map with no route saved (SCR-TEC-15)', () => {
  // why: F-1750 a failed read with signal and no route saved shows Route not loaded with Try again, never the map skeleton
  it('Route not loaded shows the error panel and no skeleton map', () => {
    const html = map('error');
    expect(html).toContain('Today&#x27;s route could not load.');
    expect(html).toContain('data-ctl="CTL-CMP-12-02"');
    expect(html).not.toContain('class="skel"');
    expect(html).not.toContain('CTL-TEC-15-02');
  });

  // why: F-1758 Loading with no saved route, and Route not loaded, read Today's route with no stop count, never 0 stops
  it('shows no stop count while loading with no saved route', () => {
    for (const name of ['loadingempty', 'error']) {
      const html = map(name);
      expect(html, name).toContain('data-ctl="CTL-TEC-15-08">Today&#x27;s route</div>');
      expect(html, name).not.toContain('0 stops');
    }
  });
});

describe('the live Me page as app/tech/me/page.tsx renders it (SCR-TEC-10, F-1775)', () => {
  const seen: string[] = [];
  // API-07 as the kernel answers it: the person's session cookie is the only way in.
  const api = (async (url: unknown, init?: RequestInit) => {
    seen.push(String(url));
    const cookie = ((init?.headers ?? {}) as Record<string, string>).cookie ?? '';
    if (!cookie.includes('bw_session=')) return new Response(JSON.stringify({ code: 'unauthenticated' }), { status: 401 });
    if (!String(url).endsWith('/api/v1/me')) return new Response('{}', { status: 404 });
    const data = { userId: 'u1', name: 'Maria Santos', role: 'technician', skill: 'heating_cooling', branch: 'columbus', employeeNumber: '40712', language: 'en', slashShortcut: 'on', permissions: [] };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const page = async (search: Record<string, string> = {}) =>
    (await TechMePage({ searchParams: Promise.resolve(search) })) as ReactElement<TechMeScreenProps>;
  const draw = (el: ReactElement): string => renderToStaticMarkup(createElement(ShellIntl, { lang: 'en', children: el }));
  const head = (html: string): string => {
    const from = html.indexOf('<div class="prof"');
    return html.slice(from, html.indexOf('</div>', html.indexOf('class="d"', from)) + 6);
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    incoming = {};
    seen.length = 0;
  });

  // why: F-1775 Reading the phone on the live page (the server's draw, before the phone's copy is read) names the signed-in person (F-1740, item 29 option b)
  it('Reading the phone names the person, with the branch line a skeleton', async () => {
    vi.stubGlobal('fetch', api);
    incoming = { cookie: 'bw_session=s1' };
    const html = draw(await page());
    expect(html, 'the draw is Reading the phone').not.toContain('No van assigned');
    expect(head(html)).toContain('<span class="av">MS</span>');
    expect(head(html)).toContain('<h1 translate="no">Maria Santos</h1>');
    expect(head(html)).toContain('Technician, heating &amp; cooling<br/><span class="r1-skel bw-skel-40"');
    expect(seen).toEqual([`http://127.0.0.1:${process.env.PORT ?? 3000}/api/v1/me`]);
  });

  // why: F-1775 on a first open (no profile kept on the phone), Loading and Day not loaded name the person from the page's own read, whatever the day read did
  it.each(['loading', 'error'])('%s on a first open names the person', async (name) => {
    vi.stubGlobal('fetch', api);
    incoming = { cookie: 'bw_session=s1' };
    const p = ME_PREVIEWS[name]!;
    // the page's element, with the phone's reads in this state and nothing kept (data.ts: profile null)
    const html = draw(cloneElement(await page(), { fixedData: { ...p.data, profile: null }, fixedOutbox: p.outbox }));
    expect(head(html)).toContain('<span class="av">MS</span>');
    expect(head(html)).toContain('<h1 translate="no">Maria Santos</h1>');
  });

  // why: F-980 SD-47 the worker keeps the page's shell variant, which must hold no API answer: it reads nothing and names no one
  it('the shell variant reads nothing and names no one', async () => {
    vi.stubGlobal('fetch', api);
    incoming = { cookie: 'bw_session=s1' };
    const html = draw(await page({ 'bw-shell': '1' }));
    expect(seen).toEqual([]);
    expect(html).not.toContain('Maria Santos');
  });
});
