// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The web technician app's shell (SPECIFICATIONS SD-47 "Web technician app shell"; UI-SPECIFICATION 3.9 CMP-09, 3.10
// CMP-10, 4.5): every signed-in technician screen renders inside it. It holds the phone screen (DK-107's .screen with the
// app's adaptations, styles/app/tech.css), the screen's own header (passed in; each screen places its waiting count where
// its frame draws it), the No signal strip where the screen's frame draws one, the sent announcement, and the CMP-09 tab
// bar. It starts the page's item engine (useOutbox.ts) and registers the service worker (src/tech/sw.js, served at
// /tech/sw.js with scope /tech), which caches the shell, its fonts and its catalog for an open with no signal, and never an
// API answer.
import '../../styles/app/tech.css';
import { useRouter } from 'next/navigation';
import { useEffect, type KeyboardEvent, type ReactNode } from 'react';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import { Icon } from '../shell/Icon.tsx';
import type { IconName } from '../shell/icon-paths.ts';
import { useT } from '../shell/intl.tsx';
import { TechFrame } from '../shell/TechFrame.tsx';
import type { FrameData } from '../shell/frame-data.ts';
import { EMPTY_DATA, useTechData, type TechData } from './data.ts';
import { DayNotices } from './DayNotices.tsx';
import type { OutboxState } from './engine.ts';
import { noSignalWords, offlinePages } from './offline-pages.ts';
import { NoSignalBanner, SentAnnouncer } from './SyncStrip.tsx';
import { openTab } from './tab-open.ts';
import { useOwnOutbox } from './useOutbox.ts';

const SW_URL = '/tech/sw.js';
export const SW_SCOPE = '/tech';

type TechTab = 'today' | 'map' | 'parts' | 'me';

/** The tabs of the tab bar (CMP-09) in their order (Figure 8.4): Today, Map, Parts, Me. */
export const TABS: readonly { tab: TechTab; href: string; icon: IconName; label: MessageKey; ctl: string }[] = [
  { tab: 'today', href: '/tech', icon: 'list', label: 'tech.tab.today', ctl: 'CTL-CMP-09-01' },
  { tab: 'map', href: '/tech/map', icon: 'map', label: 'tech.tab.map', ctl: 'CTL-CMP-09-03' },
  { tab: 'parts', href: '/tech/parts', icon: 'box', label: 'tech.tab.parts', ctl: 'CTL-CMP-09-04' },
  { tab: 'me', href: '/tech/me', icon: 'user', label: 'tech.tab.me', ctl: 'CTL-CMP-09-02' },
];

/** CMP-09 as DK-107 draws it: 4 tabs with role link (the frame's own markup), the current one marked. */
export function TabBar({ current, markup = 'spans' }: { current: TechTab | null; markup?: 'spans' | 'anchors' }) {
  const t = useT();
  const router = useRouter();
  const go = (href: string) => openTab((h) => router.push(h), href); // F-1232: a full load when the data request is not answered
  const key = (href: string) => (e: KeyboardEvent) => {
    if (e.key === 'Enter') go(href);
  };
  // DK-116 (the Parts frame) draws the same 4 tabs as anchors in a nav element; its sheet styles `.tabbar a`, the others `.tabbar span`.
  if (markup === 'anchors') {
    return (
      <nav className="tabbar">
        {TABS.map((x) => (
          <a
            key={x.tab}
            href={x.href}
            data-ctl={x.ctl}
            {...(x.tab === current ? { className: 'on', 'aria-current': 'page' as const } : {})}
            onClick={(e) => {
              e.preventDefault();
              go(x.href);
            }}
          >
            <Icon name={x.icon} />
            {t(x.label)}
          </a>
        ))}
      </nav>
    );
  }
  return (
    <div className="tabbar">
      {TABS.map((x) => (
        <span
          key={x.tab}
          role="link"
          tabIndex={0}
          data-href={x.href}
          data-ctl={x.ctl}
          {...(x.tab === current ? { className: 'on', 'aria-current': 'page' as const } : {})}
          onClick={() => go(x.href)}
          onKeyDown={key(x.href)}
        >
          <Icon name={x.icon} />
          {t(x.label)}
        </span>
      ))}
    </div>
  );
}

/** Registers the shell's service worker once per page; a browser without one (or a refusal) leaves the app working online. */
function useServiceWorker(on: boolean, jobs: string, complete: boolean) {
  const t = useT();
  useEffect(() => {
    if (!on || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE }).catch(() => undefined);
    // The files this page loaded before the worker took control, so the first open with signal leaves an openable shell.
    void navigator.serviceWorker.ready.then((reg) => {
      const loaded = performance.getEntriesByType('resource').map((r) => r.name).filter((u) => u.startsWith(`${location.origin}/_next/static/`));
      reg.active?.postMessage({ type: 'keep', urls: [location.pathname, ...loaded] });
    }, () => undefined);
  }, [on]);
  // F-1083: every page the app links to during the day (offline-pages.ts), kept by the worker while there is signal, so a page never opened
  // before opens with none; and the words of the worker's no-signal page in the person's language. Sent again when the day's jobs or the
  // language change (t follows the language).
  const lang = t.lang;
  useEffect(() => {
    if (!on || !('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.ready.then((reg) => {
      // F-1099: `complete` says the list is every page the phone should hold now (the day and the waiting items are known), so the worker drops the job pages it was not sent.
      reg.active?.postMessage({ type: 'fill', urls: offlinePages(jobs ? jobs.split(' ').map(Number) : []), words: noSignalWords(t), complete });
    }, () => undefined);
  }, [on, jobs, complete, lang]);
}

export interface TechAppFrameProps extends FrameData {
  /** The screen's own header (its frame's .apphead), which places the waiting count (CMP-10) where the frame draws it. */
  header?: ReactNode;
  tab: TechTab | null;
  /** Whether this screen's frame draws the No signal strip (CMP-10) under the header (DK-111); Today draws its card in the list. */
  noSignalStrip?: boolean;
  /** A preview's fixed engine state; pages leave it unset and the engine runs. */
  fixed?: OutboxState;
  /** The screen draws the demo clock inside its header (Today, DK-107), so the strip above the header is left out (F-938). */
  clockInHeader?: boolean;
  /** A preview tile: the screen is drawn the way the frames' states boards draw it (`.screen.r1p-mini`, DK-64). */
  mini?: boolean;
  /** A preview's fixed day reads (P5-TWA-MAP-ME); unset, a page starts the reads, and a preview with a fixed engine state reads nothing. */
  data?: TechData;
  /** The tab bar's markup: DK-107's spans (default) or DK-116's anchors (the Parts screen). */
  tabMarkup?: 'spans' | 'anchors';
}

export function TechAppFrame({ header, tab, noSignalStrip = false, fixed, data, tabMarkup = 'spans', clockInHeader = false, mini = false, children, ...frame }: TechAppFrameProps) {
  // The day's reads (data.ts) run on every technician screen: the day-changed notices compare wherever the technician is, and the
  // Me screen's text size applies to the whole app.
  const reads = useTechData(data ?? (fixed ? EMPTY_DATA : undefined));
  // F-1099: the day's jobs, then every job with an item waiting (a job from another day keeps its pages while its items wait).
  const waiting = useOwnOutbox(fixed);
  useServiceWorker(
    fixed === undefined,
    [...(reads.day?.data.jobs ?? []).map((j) => j.jobNumber), ...waiting.waiting.map((i) => i.jobNumber)].join(' '),
    reads.day !== null && waiting.ready,
  );
  return (
    <TechFrame {...frame} {...(clockInHeader ? { noClock: true } : {})}>
      <div className={`screen bw-tech${mini ? ' r1p-mini' : ''}`} {...(data === undefined ? { 'data-text-size': reads.textSize } : {})}>
        {header}
        {noSignalStrip ? <NoSignalBanner {...(fixed ? { fixed } : {})} /> : null}
        <div className="bw-tech-body">{children}</div>
        <SentAnnouncer {...(fixed ? { fixed } : {})} />
        <DayNotices data={reads} fixed={fixed !== undefined || data !== undefined} />
        <TabBar current={tab} markup={tabMarkup} />
      </div>
    </TechFrame>
  );
}
