// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1542: a Service history row that is a job in the app opens that job's page; an old-system row stays plain text.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BwIntlProvider } from '@bw/i18n';
import { CustomerView } from './CustomerView.tsx';
import { SEAN_DETAIL } from './preview-data.ts';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined, refresh: () => undefined }),
  usePathname: () => '/office/customers/x',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('not found'); },
}));

const DETAIL = {
  ...SEAN_DETAIL,
  history: [
    { date: '2026-09-02', service: 'Furnace tune-up', serviceId: 'furnace_tune_up', technician: 'Maria Santos', old: false, jobNumber: 21102, workDone: [] },
    ...SEAN_DETAIL.history,
  ],
};
const noop = () => undefined;
const VIEW = {
  state: 'ready' as const, data: DETAIL, zone: { kind: 'idle' as const }, onRetry: noop, onEditZone: noop, onPickZone: noop, onSaveZone: noop, onCancelZone: noop,
  onEdit: noop, onMap: noop, onNewJob: noop, perms: [] as string[], onText: noop, onAddEquipment: noop, onEditEquipment: noop, onAddNote: noop, onInbox: noop, inboxError: false,
};

const history = (html: string): string => {
  const m = /data-ctl="CTL-OFC-06-12"[\s\S]*?<\/table>/.exec(html);
  if (!m) throw new Error('no history table');
  return m[0];
};

describe('F-1542 customer page history', () => {
  // why: FR-DISP-5, F-1542, CTL-OFC-06-12 (a job row is a link to its job page; an old-system row is plain text)
  it.each(['en', 'es'] as const)('links job rows and leaves old-system rows plain (%s)', (locale) => {
    const html = renderToStaticMarkup(createElement(BwIntlProvider, { locale, children: createElement(CustomerView, VIEW) }));
    const h = history(html);
    expect(h).toContain('href="/office/jobs/21102"');
    expect(h).not.toContain('/office/jobs/null');
    expect((h.match(/href="\/office\/jobs\//g) ?? []).length).toBe(1);
    expect(h).toContain('Furnace repair');
    expect(h).not.toMatch(/<a[^>]*>Furnace repair/);
  });
});
