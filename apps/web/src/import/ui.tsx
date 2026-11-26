// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The import pages' shared pieces: the admin frame with the page header and its 3 tabs (CTL-OFC-13-01 to -03), the confirm dialog
// (DK-34; SCR-OFC-25 and SCR-OFC-26: initial focus on the cancelling button, Escape cancels, Tab stays inside), and the typed
// client the pages call.
import { ApiError, createClient, type ContractRow } from '@bw/api';
import { useEffect, useRef, type ReactNode } from 'react';
import type { z } from '@bw/api';
import { AdminSide } from '../shell/Headers.tsx';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { useModalFocus } from '../shell/modal-focus.ts';
import { useMe } from '../shell/me.ts';
import { OfficeTopBar, type Me, type OfficeTopBarProps } from '../shell/OfficeTopBar.tsx';
import type { Reader } from '../shell/reads.ts';
import { Screen } from '../shell/Surface.tsx';
import type { ClockAnswer } from '../shell/clock.ts';
import type { AppInfo } from '../shell/Footer.tsx';

const client = createClient({ baseUrl: '' });

export type CallOutcome<R extends z.ZodType> = { ok: true; data: z.output<R> } | { ok: false; code: string; status: number };

/** One call through the typed client; a Problem or a network failure is a value, never a throw. */
export async function call<Q extends z.ZodType, R extends z.ZodType>(row: ContractRow<Q, R>, input?: z.input<Q>): Promise<CallOutcome<R>> {
  try {
    return { ok: true, data: (await client.call(row, input)).data };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, code: e.problem.code, status: e.status };
    return { ok: false, code: 'network', status: 0 };
  }
}

/** The raw text of a file row (API-83). */
export async function callFile<Q extends z.ZodType, R extends z.ZodType>(row: ContractRow<Q, R>, input?: z.input<Q>): Promise<string | null> {
  try {
    const a = await client.raw(row, (input ?? {}) as Record<string, unknown>);
    return a.status === 200 && typeof a.body === 'string' ? a.body : null;
  } catch {
    return null;
  }
}

/** An element whose width is a computed share (a count bar, a progress bar): set through the CSSOM, since the page's CSP allows no style attribute. */
export function Fill({ width, className }: { width: string; className?: string }) {
  return (
    <i
      {...(className ? { className } : {})}
      ref={(el) => {
        if (el) el.style.width = width;
      }}
    />
  );
}

export type TabId = 'dry' | 'dups' | 'history';
const TAB_HREF: Record<TabId, string> = { dry: '/office/admin/import', dups: '/office/admin/import/duplicates', history: '/office/admin/import/history' };

export interface FrameProps {
  screen: string;
  tab: TabId;
  title: string;
  sub: string;
  /** The Duplicates tab's count (CTL-OFC-13-02); null or undefined: no count (the read failed or has not landed). */
  dupCount?: number | null;
  /** The count's text on the Duplicates page itself ("367 left"). */
  dupText?: string;
  /** Preview: the frame's fixed shared state. */
  me?: Me;
  clock?: ClockAnswer | null;
  appInfo?: AppInfo | null;
  reader?: Reader | false;
  bar?: Omit<OfficeTopBarProps, 'me'>;
  /** `main` is the approved pages' class for the column (DK-98, DK-99); the history page uses the kit's `mainc` directly. */
  column: 'main' | 'mainc';
  children: ReactNode;
}

/** The admin frame (CMP-01, CMP-07, CMP-08, CMP-04) around the page header and its tabs. */
export function ImportFrame(p: FrameProps) {
  const t = useT();
  const me = useMe(p.reader, p.me);
  const changeHref = me?.permissions.includes('SCR-OFC-17') ? '/office/admin/clock' : null;
  const tab = (id: TabId, icon: 'refresh' | 'user' | 'list', ctl: string, label: string, n?: ReactNode) => (
    <a href={TAB_HREF[id]} className={p.tab === id ? 'on' : undefined} aria-current={p.tab === id ? 'page' : undefined} data-ctl={ctl}>
      <Icon name={icon} />
      {label}
      {n}
    </a>
  );
  const dupN = p.tab === 'dups' && p.dupText ? <span className="n">{p.dupText}</span> : p.dupCount != null ? <span className="n">{p.dupCount.toLocaleString(t.lang === 'es' ? 'es-US' : 'en-US')}</span> : null;
  const head = (
    <div className="ah">
      <div>
        <h1>{t('admin.import.title')}</h1>
        <p>{p.sub}</p>
      </div>
      <div className="tabs" role="navigation" aria-label={t('admin.import.nav')}>
        {tab('dry', 'refresh', 'CTL-OFC-13-01', t('admin.import.tab.dry'))}
        {tab('dups', 'user', 'CTL-OFC-13-02', t('admin.import.tab.dups'), dupN)}
        {tab('history', 'list', 'CTL-OFC-13-03', t('admin.import.tab.history'))}
      </div>
    </div>
  );
  return (
    <Screen
      screen={p.screen}
      surface="SURF-OFC"
      changeHref={changeHref}
      live={me !== null}
      title={p.title}
      {...(p.clock !== undefined ? { clock: p.clock } : {})}
      {...(p.appInfo !== undefined ? { appInfo: p.appInfo } : {})}
      {...(p.reader !== undefined ? { reader: p.reader } : {})}
    >
      {me ? <OfficeTopBar me={me} {...(p.reader !== undefined && p.reader !== false ? { reader: p.reader } : {})} liveAlerts={p.reader !== false} {...p.bar} /> : null}
      <div className="shell">
        <AdminSide permissions={me?.permissions ?? []} currentPath="/office/admin/import" />
        <div className="mainc">
          {p.column === 'main' ? (
            <div className="main">
              {head}
              {p.children}
            </div>
          ) : (
            <>
              {head}
              {p.children}
            </>
          )}
        </div>
      </div>
    </Screen>
  );
}


export interface DialogProps {
  screen: string;
  title: string;
  /** The control id of the dialog's close button (CTL-OFC-25-03, CTL-OFC-26-03). */
  closeCtl: string;
  onClose: () => void;
  /** Drawn inside its host (the look comparator's tiles) instead of over the page. */
  inline?: boolean;
  body: ReactNode;
  foot: ReactNode;
}

/** DK-34 dialog: role dialog, modal, Escape cancels, Tab stays inside, focus returns to the control that opened it. */
export function Dialog({ screen, title, closeCtl, onClose, inline, body, foot }: DialogProps) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  // The first focus goes to the dialog's own initial control; the Tab ring and the focus return are useModalFocus's (F-1464), whose effect runs after this one.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[data-initial]')?.focus();
  }, []);
  useModalFocus(root);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <div className={inline ? 'r1-scrim in' : 'r1-scrim bw-modal'} onKeyDown={onKey} ref={root}>
      <div className="r1-dlg" role="dialog" aria-modal="true" aria-label={title} data-screen={screen}>
        <div className="r1-dlg-h">
          <h2>{title}</h2>
          <button type="button" className="r1-x" aria-label={t('admin.import.dialog.close')} data-ctl={closeCtl} onClick={onClose}>
            <i className="ic">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </i>
          </button>
        </div>
        <div className="r1-dlg-b">{body}</div>
        <div className="r1-dlg-f">{foot}</div>
      </div>
    </div>
  );
}

/** A busy button's spinner and label (DK-34 Starting, Undoing): aria-busy, a repeated press is ignored by the caller. */
export function BusyLabel({ children, dark }: { children: ReactNode; dark?: boolean }) {
  return (
    <>
      <span className={dark ? 'r1-spin dark' : 'r1-spin'} />
      {children}
    </>
  );
}
