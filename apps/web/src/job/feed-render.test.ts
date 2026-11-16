// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1752: the rendered half of F-704. An office text writes a job change of kind office_text and an outbox text; the feed draws them as 1 row
// that names the sender and moves the status word into the small line. jobFeed is pinned in model.test.ts; this draws the row, in both languages.
import { BwIntlProvider } from '@bw/i18n';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { JOB_MANAGER } from './JobPreview.tsx';
import { JobScreen } from './JobScreen.tsx';
import { HAROLD, previewApi } from './preview-fixtures.ts';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined, refresh: () => undefined }),
  usePathname: () => '/office/jobs/24830',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('not found'); },
}));

const at = (hour: number) => HAROLD.timeline[0]!.at.replace(/T\d\d/, `T${String(hour).padStart(2, '0')}`);
const job = {
  ...HAROLD,
  timeline: [
    ...HAROLD.timeline,
    { kind: 'office_text', at: at(11), by: 'Dana Whitfield', byKind: 'office', values: { textId: 'x1', status: 'sending' } },
  ],
  texts: [
    ...HAROLD.texts,
    { id: 'x1', kind: 'office', status: 'delivered', at: at(11), body: 'Running 10 minutes late.' },
    { id: 'x2', kind: 'reminder', status: 'delivered', at: at(12), body: '' },
  ],
} as typeof HAROLD;

const feedOf = (locale: 'en' | 'es'): string => {
  const html = renderToStaticMarkup(createElement(BwIntlProvider, {
    locale,
    children: createElement(JobScreen, { jobNumber: 24830, me: JOB_MANAGER, api: previewApi(), fixed: { job, onTheWay: null, frame: { clock: undefined as never, appInfo: undefined as never, reader: false } } } as never),
  }));
  const m = /data-ctl="CTL-OFC-03-17"[\s\S]*?<\/section>/.exec(html);
  if (!m) throw new Error('no feed');
  return m[0];
};

describe('F-1752 the office text row in the job feed', () => {
  it.each([
    ['en', 'Office text sent by Dana Whitfield', 'Delivered'],
    ['es', 'Texto de la oficina enviado por Dana Whitfield', 'Entregado'],
  ] as const)('draws 1 row that names the sender and the status word (%s)', (locale, sender, status) => {
    const feed = feedOf(locale);
    expect(feed.split(sender).length - 1).toBe(1);
    expect(feed).toContain(`<small>${status}, `);
    // the change folds into its text: each text is 1 .ev row (x1 once, with the change folded in; x2 has no change) beside the fixture's own timeline rows
    expect((feed.match(/class="ev[ "]/g) ?? []).length).toBe(HAROLD.timeline.length + job.texts.length);
    expect(feed).toContain('href="/office/messages?text=x1"');
    expect(feed).toContain('href="/office/messages?text=x2"');
  });
});
