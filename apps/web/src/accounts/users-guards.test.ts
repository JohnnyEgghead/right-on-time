// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: K-01, F-2011 (Turn on, the invite send and the turn-off confirm send 1 write per press-run)
// The web tests have no DOM, so the real UsersScreen renders once on the server renderer and the test presses its buttons by calling the
// handlers the rendered elements carry: the frame is a stand-in that hands back its children, and a dialog component's own tree is taken
// by rendering it inside a probe. callRow is a fake whose answer lands when the test says so; a second press comes before it lands.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DialogState } from './UsersScreen.tsx';

const frame = vi.hoisted(() => ({ children: null as unknown }));
const call = vi.hoisted(() => ({ fn: null as unknown as ReturnType<typeof import('vitest').vi.fn>, land: [] as ((v: unknown) => void)[] }));
vi.mock('../shell/Frames.tsx', () => ({ AdminFrame: (p: { children: unknown }) => { frame.children = p.children; return null; } }));
vi.mock('./api.ts', async (real) => {
  const m = await real<typeof import('./api.ts')>();
  const { vi: v } = await import('vitest');
  call.fn = v.fn(() => new Promise((r) => call.land.push(r)));
  return { ...m, callRow: call.fn };
});

const { UsersScreen } = await import('./UsersScreen.tsx');
const { ShellIntl } = await import('../shell/intl.tsx');
const { rows } = await import('./api.ts');
const { AREAS, CHANGES, ME, OMAR, SEARCH, TANYA } = await import('./preview-fixtures.ts');

type El = ReactElement<Record<string, unknown>>;
/** Every element in a tree, walking children and element-valued props (a dialog's foot). */
function* walk(n: unknown): Generator<El> {
  if (Array.isArray(n)) for (const c of n) yield* walk(c);
  else if (isValidElement(n)) {
    const el = n as El;
    yield el;
    for (const v of Object.values(el.props)) if (Array.isArray(v) || isValidElement(v)) yield* walk(v);
  }
}
const find = (tree: unknown, pick: (e: El) => boolean): El => {
  for (const e of walk(tree)) if (pick(e)) return e;
  throw new Error('no such element');
};
const ctl = (id: string) => (e: El) => e.props['data-ctl'] === id && typeof e.props['onClick'] === 'function';

/** The screen's tree, with an open dialog if given. */
function screen(dialog: DialogState | null = null): unknown {
  frame.children = null;
  renderToStaticMarkup(createElement(ShellIntl, { lang: 'en', children: createElement(UsersScreen, { me: ME, search: SEARCH, areas: AREAS, changes: CHANGES, dialog, clock: null, appInfo: null }) }));
  return frame.children;
}
/** A dialog component's own tree: the screen's dialog element, rendered inside a probe so its hooks run. */
function dialogTree(dialog: DialogState): unknown {
  const host = find(screen(dialog), (e) => typeof e.type === 'function' && (e.props['d'] as DialogState | undefined)?.kind === dialog.kind);
  let got: ReactNode = null;
  function Probe() {
    got = (host.type as (p: unknown) => ReactNode)(host.props);
    return null;
  }
  renderToStaticMarkup(createElement(ShellIntl, { lang: 'en', children: createElement(Probe) }));
  return got;
}
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const sent = (row: unknown) => call.fn.mock.calls.filter((c) => c[0] === row).length;

beforeEach(() => {
  call.fn.mockClear();
  call.land.length = 0;
});

describe('the Users page sends 1 write per press-run (K-01)', () => {
  // why: K-01 Turn on had no in-flight guard, so a second press before the answer sent a second turn-on
  it('sends 1 turn-on for 2 Turn on presses before the answer', async () => {
    const on = find(screen(), ctl('CTL-OFC-43-13'));
    (on.props['onClick'] as () => void)();
    (on.props['onClick'] as () => void)();
    await settle();
    expect(sent(rows.turnUserOn)).toBe(1);
    call.land[0]?.({ ok: false, code: 'rule_refused', status: 409, detail: {} });
    await settle();
    (on.props['onClick'] as () => void)(); // the refusal let the guard go
    await settle();
    expect(sent(rows.turnUserOn)).toBe(2);
  });

  // why: F-2088 the Turn on guard was let go at the write's answer, so a press while the re-reads were out sent a second API-170 the server refuses (409)
  it('sends no second turn-on after the write answered while the follow-up reads are still out', async () => {
    const on = find(screen(), ctl('CTL-OFC-43-13'));
    (on.props['onClick'] as () => void)();
    await settle();
    call.land[0]?.({ ok: true, data: { user: { ...OMAR, status: 'active' } } });
    await settle();
    expect(call.fn.mock.calls.length).toBeGreaterThan(1); // the re-reads were asked for and none has answered
    (on.props['onClick'] as () => void)();
    await settle();
    expect(sent(rows.turnUserOn)).toBe(1);
  });

  // why: K-01 the invite send had no in-flight guard of its own, and the dialog could close while it sent (inventory section 9)
  it('sends 1 invite for 2 submits before the answer', async () => {
    const form = find(dialogTree({ kind: 'invite', step: 'editing', name: TANYA.name, email: TANYA.email, role: 'office', branch: 'columbus' }),
      (e) => e.type === 'form');
    const submit = form.props['onSubmit'] as (e: { preventDefault: () => void }) => void;
    submit({ preventDefault: () => undefined });
    submit({ preventDefault: () => undefined });
    await settle();
    expect(sent(rows.inviteUser)).toBe(1);
  });

  // why: K-01 the turn-off confirm had no in-flight guard of its own (inventory section 9)
  it('sends 1 turn-off for 2 confirm presses before the answer', async () => {
    const confirm = find(dialogTree({ kind: 'off', step: 'asking', user: OMAR }), ctl('CTL-OFC-46-02'));
    (confirm.props['onClick'] as () => void)();
    (confirm.props['onClick'] as () => void)();
    await settle();
    expect(sent(rows.turnUserOff)).toBe(1);
  });
});
