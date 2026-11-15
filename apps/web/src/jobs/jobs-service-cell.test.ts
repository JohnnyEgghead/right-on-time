// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1652: the Jobs list service cell shows the job's own problem words when it has them, the catalog word when it has none.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BwIntlProvider } from '@bw/i18n';
import { JOBS_SUCCESS } from './jobs-fixtures.ts';
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
