// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1652: the Jobs list service cell shows the job's own problem words when it has them, the catalog word when it has none.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BwIntlProvider } from '@bw/i18n';
import { JOBS_SERVICE_WORDS, JOBS_SUCCESS, JOBS_SUCCESS_ES } from './jobs-fixtures.ts';
import { JobsView } from './JobsView.tsx';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined, refresh: () => undefined }),
  usePathname: () => '/office/jobs',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('not found'); },
}));

const render = (problem: string | null): string => {
  const first = JOBS_SUCCESS.rows[0];
  if (!first) throw new Error('no fixture row');
  const data = { ...JOBS_SUCCESS, filters: { ...JOBS_SUCCESS.filters, services: [] }, rows: [{ ...first, service: 'plumbing_repair', problem }] };
  return renderToStaticMarkup(createElement(BwIntlProvider, {
    locale: 'en',
    children: createElement(JobsView, {
      state: 'ready', data, branch: 'columbus', tab: 'all', query: '', date: 'upcoming', technicianId: '', status: '', serviceId: '', sort: 'attention', page: 1, live: 'live',
    }),
  }));
};

describe('F-1652 Jobs list service cell', () => {
  // why: F-1652, CTL-OFC-30-10 (the cell says the job's own words, 1 line cut with an ellipsis, the full words as the name)
  it('renders the problem words, with the full words as the accessible name', () => {
    const html = render('Water softener service');
    expect(html).toContain('>Water softener service</span>');
    expect(html).toContain('aria-label="Water softener service"');
    expect(html).not.toContain('Plumbing repair');
  });

  // why: F-1652 a job with no problem words keeps the catalog word of its service
  it('renders the catalog word when the job has no problem words', () => {
    const html = render(null);
    expect(html).toContain('Plumbing repair');
    expect(html).not.toContain('bw-jb-svc');
  });
});

describe('F-1659 F-1664 Jobs list fixture', () => {
  // why: F-1659 the fixture's service filter holds service ids (the frame's), not the language keys en and es
  it('the service filter holds the service ids of the fixture rows', () => {
    const ids = JOBS_SUCCESS.filters.services;
    expect(ids).not.toContain('en');
    for (const r of JOBS_SUCCESS.rows) expect(ids).toContain(r.service);
  });

  // why: F-1664 every success row carries the page's problem words, so the look case draws the 220 px service cell
  it('every success row holds problem words', () => {
    expect(JOBS_SUCCESS.rows.every((r) => typeof r.problem === 'string' && r.problem !== '')).toBe(true);
  });

  // why: F-1736 the Spanish page's success rows hold the same jobs with the problem words in Spanish, as the service words are (the Spanish walker flags an English catalog value)
  it('gives the Spanish page the same rows with Spanish problem words', () => {
    expect(JOBS_SUCCESS_ES.rows.map((r) => ({ ...r, problem: null }))).toEqual(JOBS_SUCCESS.rows.map((r) => ({ ...r, problem: null })));
    expect(JOBS_SUCCESS_ES.rows.map((r) => r.problem)).toEqual(JOBS_SUCCESS.rows.map((r) => JOBS_SERVICE_WORDS.es[r.service]));
  });
});
