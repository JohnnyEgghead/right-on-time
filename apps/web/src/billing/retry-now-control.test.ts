// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1898: Retry now (CTL-OFC-10-07) is drawn only on a retrying row. The server refuses any other state (not_retrying, 409), so a
// control on a Sending now row was dead. This draws the table's rows, in both states.
import { BwIntlProvider } from '@bw/i18n';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BillingBody, type Queue } from './BillingBody.tsx';
import { QUEUE_SUCCESS } from './preview-data.ts';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined, refresh: () => undefined }),
  usePathname: () => '/office/billing',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('not found'); },
}));

const retrying = QUEUE_SUCCESS.items.find((i) => i.state === 'retrying')!;

const html = (state: 'sending' | 'retrying'): string => {
  const data: Queue = { ...QUEUE_SUCCESS, items: [{ ...retrying, state }] };
  return renderToStaticMarkup(createElement(BwIntlProvider, {
    locale: 'en',
    children: createElement(BillingBody, { status: 'ready', data, branchName: 'Columbus', live: 'live' }),
  }));
};

describe('Retry now on the billing waiting table', () => {
  // why: FR-BILL-10
  it('is absent on a Sending now row and present on a retrying row', () => {
    expect(html('sending')).not.toContain('data-ctl="CTL-OFC-10-07"');
    expect(html('retrying')).toContain('data-ctl="CTL-OFC-10-07"');
  });

  // why: FR-BILL-10
  it('leaves Mark fixed on a Sending now row', () => {
    expect(html('sending')).toContain('data-ctl="CTL-OFC-10-09"');
  });
});
