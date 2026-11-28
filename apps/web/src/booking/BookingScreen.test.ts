// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: K-01, F-2011 (the booking page's Confirm booking sends 1 booking per draft)
// The real BookingScreen, rendered once on the server renderer (the web tests have no DOM, so the page's effects do not run): the view is
// a stand-in that hands back the props the screen gave it, so a test presses Confirm booking and Book this window exactly as BookingView's
// buttons do (on.confirm, taken.onBook). The draft is a complete one; api.book is a fake that answers, and router.push never settles, as a
// slow page move does.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookingApi } from './api.ts';
import type { ViewProps } from './BookingView.tsx';

const nav = vi.hoisted(() => ({ push: vi.fn(() => new Promise<never>(() => undefined)), replace: vi.fn() }));
const seen = vi.hoisted(() => ({ props: null as ViewProps | null }));
const keys = vi.hoisted(() => ({ made: 0 }));
// F-2085: the server renderer never runs a state updater, so each functional update is also applied once to the value its render saw and kept here.
const updates = vi.hoisted(() => ({ applied: [] as unknown[] }));
vi.mock('react', async (real) => {
  const r = await real<typeof import('react')>();
  return {
    ...r,
    useState: (init: unknown) => {
      const [v, set] = (r.useState as (i: unknown) => [unknown, (u: unknown) => void])(init);
      return [v, (u: unknown) => {
        if (typeof u === 'function') updates.applied.push((u as (x: unknown) => unknown)(v));
        set(u);
      }];
    },
  };
});
vi.mock('next/navigation', () => ({ useRouter: () => nav }));
vi.mock('./BookingView.tsx', () => ({ BookingView: (p: ViewProps) => { seen.props = p; return null; } }));
vi.mock('../shell/BookingFrame.tsx', () => ({ BookingFrame: ({ children }: { children: unknown }) => children }));
vi.mock('./model.ts', async (real) => {
  const m = await real<typeof import('./model.ts')>();
  const complete = (lang: 'en' | 'es') => ({
    ...m.emptyDraft(lang), serviceId: 'furnace_tune_up', streetText: 'Maple Hollow Ct, Westerville 43081',
    street: { streetId: '00000000-0000-4000-8000-000000000001', name: 'Maple Hollow Ct', city: 'Westerville', zip: '43081', branch: 'columbus' },
    house: '418', date: '2026-09-17', windowId: 'w10', name: 'Harold Jenkins', mobile: '', textsOn: false,
  });
  return { ...m, emptyDraft: complete, newBookingKey: () => `00000000-0000-4000-8000-00000000000${(keys.made += 1)}` };
});

const { BookingScreen } = await import('./BookingScreen.tsx');
const { ShellIntl } = await import('../shell/intl.tsx');

const booked = { ok: true as const, data: { bookingToken: 'tok-1', visit: { jobNumber: 24800, serviceId: 'furnace_tune_up', date: '2026-09-17', window: { start: '', end: '' }, zone: 'America/New_York' } } };
function fakeApi(book: BookingApi['book']): BookingApi {
  const never = () => new Promise<never>(() => undefined);
  return { services: never, streets: never, availability: never, summary: never, book };
}
function open(api: BookingApi): ViewProps {
  seen.props = null;
  renderToStaticMarkup(createElement(ShellIntl, { lang: 'en', children: createElement(BookingScreen, { api }) }));
  if (!seen.props) throw new Error('the screen rendered no view');
  return seen.props;
}
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  nav.push.mockClear();
});

describe('Confirm booking sends 1 booking per press-run (K-01)', () => {
  // why: K-01 the page turned booking off before router.push, so a second Confirm while the page moved booked a second visit
  it('sends 1 booking for 2 Confirm clicks while the page moves to SCR-CUS-03', async () => {
    const book = vi.fn(async () => booked);
    const view = open(fakeApi(book));
    view.on.confirm();
    await settle(); // the booking answered; router.push is still moving the page
    expect(nav.push).toHaveBeenCalledWith('/book/done/tok-1');
    view.on.confirm();
    await settle();
    expect(book).toHaveBeenCalledTimes(1);
  });

  // why: K-01 the guard is held outside React state, so 2 presses through 1 render's handler send 1 booking
  it('sends 1 booking for 2 Confirm clicks in the same tick, and the draft key goes with it', async () => {
    const book = vi.fn(async () => booked);
    const view = open(fakeApi(book));
    view.on.confirm();
    view.on.confirm();
    await settle();
    expect(book).toHaveBeenCalledTimes(1);
    const sent = (book.mock.calls[0] as unknown as [{ bookingKey: string }])[0];
    expect(sent.bookingKey).toMatch(UUID4);
  });

  // why: K-01 only a refusal or a failed send lets the guard go: the next press sends again, with the same key (a refusal stores no key)
  it('lets a press after a failed send send again with the same key', async () => {
    const book = vi.fn<BookingApi['book']>()
      .mockResolvedValueOnce({ ok: false, code: 'offline', status: 0, detail: {} })
      .mockResolvedValueOnce(booked);
    const view = open(fakeApi(book));
    view.on.confirm();
    await settle();
    expect(nav.push).not.toHaveBeenCalled();
    view.on.confirm();
    await settle();
    expect(book).toHaveBeenCalledTimes(2);
    const keys = book.mock.calls.map((c) => c[0].bookingKey);
    expect(keys[0]).toMatch(UUID4);
    expect(keys[1]).toBe(keys[0]);
    expect(nav.push).toHaveBeenCalledTimes(1);
  });

  // why: F-2085 the branch that replaces the key (CTL-CUS-01-13) ran in no test: a refusal naming bookingKey gives the draft a new key, any other validation_failed does not
  it('gives the draft a new key only when the refusal names bookingKey', async () => {
    const refused = (fields: unknown) => ({ ok: false as const, code: 'validation_failed', status: 422, detail: { fields } });
    const book = vi.fn<BookingApi['book']>().mockResolvedValue(refused([{ field: 'houseNumber' }]));
    const view = open(fakeApi(book));
    const keyed = () => updates.applied.filter((d) => typeof (d as { bookingKey?: unknown } | null)?.bookingKey === 'string' && (d as { bookingKey: string }).bookingKey.startsWith('00000000-0000-4000-8000-0000000000')) as { bookingKey: string; name: string; house: string }[];
    updates.applied.length = 0;
    view.on.confirm();
    await settle();
    expect(keyed()).toEqual([]); // another field: the key stays
    book.mockResolvedValue(refused([{ field: 'bookingKey' }]));
    view.on.confirm();
    await settle();
    // the key field: the draft is given 1 new key and every other field of it stays (the input stays)
    expect(keyed()).toHaveLength(1);
    expect(keyed()[0]).toMatchObject({ name: 'Harold Jenkins', house: '418' });
  });
});
