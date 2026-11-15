// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1542: a Service history row that is a job in the app opens that job's page; an old-system row stays plain text.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BwIntlProvider } from '@bw/i18n';
import { JobPreview } from './JobPreview.tsx';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined, refresh: () => undefined }),
  usePathname: () => '/office/jobs/24830',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('not found'); },
}));

const history = (html: string): string => {
  const m = /data-ctl="CTL-OFC-03-12"[\s\S]*?<\/table>/.exec(html);
  if (!m) throw new Error('no history table');
  return m[0];
};

describe('F-1542 job page history', () => {
  // why: FR-DISP-5, F-1542, CTL-OFC-03-12 (a job row is a link to its job page; an old-system row is plain text)
  it.each(['en', 'es'] as const)('links job rows and leaves old-system rows plain (%s)', (locale) => {
    const html = renderToStaticMarkup(createElement(BwIntlProvider, { locale, children: createElement(JobPreview, { state: 'success' as never }) }));
    const h = history(html);
    expect(h).toContain('href="/office/jobs/21102"');
    expect(h).toContain('href="/office/jobs/19877"');
    expect(h).not.toContain('/office/jobs/null');
    expect((h.match(/href="\/office\/jobs\//g) ?? []).length).toBe(2);
    expect(h).toContain('No heat (repair)');
    expect(h).not.toMatch(/<a[^>]*>No heat/);
  });
});
