// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// CMP-07 office top bar (CTL-CMP-07-01 to CTL-CMP-07-10): the kit's header.topbar.r1top (DK-15, DK-40; markup DK-76).
// FR-DISP-10: "Dispatch" beside "Brightwater Right On Time", and the menu of office-nav.ts in spec order (OI-22).
// FR-DISP-11: 1 search box for jobs, customers and addresses (API-130), focused by "/" while the user's switch is on,
// and the switch in the user menu (CTL-CMP-07-09, OI-30) saved with the user (API-08).
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertsPanelView, useBell } from './AlertsPanel.tsx';
import { BRANCHES, BRANCH_STORAGE_KEY, branchById } from './branches.ts';
import { Icon, Mark } from './Icon.tsx';
import { useT } from './intl.tsx';
import { searchQuery, slashFocusesSearch } from './keys.ts';
import { LanguageSwitch } from './LanguageSwitch.tsx';
import { confirmLeave } from './leave-guard.ts';
import { isCurrent, OFFICE_SECTIONS, visibleEntries } from './office-nav.ts';
import { createReader, type Reader } from './reads.ts';
import { createLatest } from './search-latest.ts';

export type Role = 'office' | 'manager' | 'technician';

/** API-07's answer, the fields this bar uses (UI-SPECIFICATION 12.2). */
export interface Me {
  userId?: string;
  /** null: no name on record (API-07; F-223). */
  name: string | null;
  role: Role;
  branch?: string;
  language?: 'en' | 'es';
  slashShortcut: 'on' | 'off';
  permissions: readonly string[];
}

export interface SearchAnswer {
  jobs: { jobNumber: number | string; customer: string; day?: string; window?: string; status?: string }[];
  customers: { id: string; name: string; area?: string; plan?: string }[];
  addresses: { customerId: string; address: string }[];
  more?: { jobs?: boolean; customers?: boolean; addresses?: boolean };
}

export function initials(name: string | null): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase();
}

/** "Dana R." for "Dana Ruiz", as the kit's user button shows it. */
export function shortName(name: string | null): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]?.[0]}.` : name;
}

const ROLE_KEY = { office: 'shell.role.office', manager: 'shell.role.manager', technician: 'shell.role.technician' } as const;
export const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_CARRY_KEY = 'bw.search.carry';

export interface OfficeTopBarProps {
  me: Me;
  /**
   * A fixed alert count (a preview, a frame state); null: the bell shows no count. Left out, the bar reads API-43 itself and keeps the
   * count current from the event stream (FR-DISP-12), unless `liveAlerts` is false (a preview with no API behind it).
   */
  alertCount?: number | null;
  liveAlerts?: boolean;
  reader?: Reader;
  /** Previews: open the user menu, the More menu or show search results as the kit frames show them. */
  initialMenu?: 'user' | 'more' | null;
  initialSearch?: { query: string; answer: SearchAnswer } | null;
  /** Previews: the path that marks the current section (pages use their own path). */
  currentPath?: string;
}

export function OfficeTopBar({ me, alertCount, liveAlerts = true, reader, initialMenu = null, initialSearch = null, currentPath }: OfficeTopBarProps) {
  const t = useT();
  const routePath = usePathname() ?? '';
  const pathname = currentPath ?? routePath;
  const router = useRouter();
  const read = useCallback(() => reader ?? createReader({ baseUrl: window.location.origin }), [reader]);
  const entries = visibleEntries(OFFICE_SECTIONS, me.permissions);

  // CTL-CMP-07-03: links that do not fit move into More, last first.
  const headerRef = useRef<HTMLElement>(null);
  const [overflow, setOverflow] = useState(0);
  const [moreOpen, setMoreOpen] = useState(initialMenu === 'more');
  // A new bar width starts the fit again from 0 links moved. The pass counter re-runs the fit even when the count is
  // already 0 (setting 0 to 0 alone would not re-render, so a narrowed bar would never move a link).
  const [fitPass, setFitPass] = useState(0);
  // K-08.25: a new language changes the labels' width the same way, so the fit starts again from 0 links moved (router.refresh keeps this bar mounted).
  const fitLang = useRef(t.lang);
  useLayoutEffect(() => {
    if (fitLang.current === t.lang) return;
    fitLang.current = t.lang;
    setOverflow(0);
    setFitPass((p) => p + 1);
  }, [t.lang]);
  useLayoutEffect(() => {
    const h = headerRef.current;
    if (!h) return;
    if (h.scrollWidth > h.clientWidth + 1 && overflow < entries.length) setOverflow((n) => n + 1);
  }, [overflow, entries.length, fitPass]);
  useEffect(() => {
    const h = headerRef.current;
    if (!h) return;
    let width = h.clientWidth;
    const ro = new ResizeObserver(() => {
      if (h.clientWidth === width) return;
      width = h.clientWidth;
      setOverflow(0);
      setFitPass((p) => p + 1);
    });
    ro.observe(h);
    return () => ro.disconnect();
  }, []);
  const shownLinks = entries.slice(0, entries.length - overflow);
  const moreLinks = entries.slice(entries.length - overflow);

  // CTL-CMP-07-04: the branch, kept in the URL and in the browser.
  const [branch, setBranch] = useState(BRANCHES[0]!.id as string);
  // The first paint must match the server's, so `branch` starts at the first branch; it is the kept branch only after this effect (F-712).
  const [branchKnown, setBranchKnown] = useState(false);
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('branch');
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(BRANCH_STORAGE_KEY);
    } catch {
      stored = null;
    }
    setBranch(branchById(fromUrl ?? stored ?? me.branch).id);
    setBranchKnown(true);
  }, [me.branch]);
  const chooseBranch = (id: string) => {
    if (!confirmLeave()) return;
    setBranch(id);
    try {
      window.localStorage.setItem(BRANCH_STORAGE_KEY, id);
    } catch {
      // storage blocked: the URL still carries the branch
    }
    const url = new URL(window.location.href);
    url.searchParams.set('branch', id);
    router.replace(url.pathname + url.search);
  };

  // The alerts bell and its count (CTL-CMP-07-06, FR-DISP-12), and the alerts list it opens (SCR-OFC-28).
  const bell = useBell({ enabled: liveAlerts && alertCount === undefined && branchKnown, branch, reader: read });
  const bellCount = alertCount !== undefined ? alertCount : bell.count;
  const bellOpen = bell.open;
  const closeBell = bell.close;
  useEffect(() => {
    if (!bell.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeBell();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [bell.open, closeBell]);

  // The search box (CTL-CMP-07-05) and the "/" key that moves focus to it (CTL-CMP-07-10).
  const inputRef = useRef<HTMLInputElement>(null);
  const [slash, setSlash] = useState(me.slashShortcut);
  const [slashError, setSlashError] = useState(false);
  const [typed, setTyped] = useState(initialSearch?.query ?? '');
  // F-1062 (shell/early-form.ts rule 1): the field is uncontrolled, so text typed while the page hydrates stays; the state takes it once hydrated.
  useEffect(() => {
    const v = inputRef.current?.value ?? '';
    setTyped((q) => (v !== q ? v : q));
  }, []);
  const [results, setResults] = useState<SearchAnswer | null>(initialSearch?.answer ?? null);
  const [searchFailed, setSearchFailed] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(Boolean(initialSearch));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!slashFocusesSearch(e, e.target as HTMLElement | null, slash === 'on')) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [slash]);
  // The answer of the newest query only (F-229).
  const latest = useRef(createLatest()).current;
  const runSearch = useCallback(
    async (q: string) => {
      await latest.run(
        () => read().read<SearchAnswer>('API-130', { query: q, branch }),
        (r) => {
          if (r.ok) {
            setResults(r.data);
            setSearchFailed(false);
          } else {
            setResults(null);
            setSearchFailed(true);
          }
          setResultsOpen(true);
        },
      );
    },
    [read, branch, latest],
  );
  useEffect(() => {
    if (initialSearch) return;
    latest.invalidate(); // an answer to an earlier query is stale from this keystroke on
    const q = searchQuery(typed);
    if (q === null) {
      setResultsOpen(false);
      return;
    }
    const h = window.setTimeout(() => void runSearch(q), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(h);
  }, [typed, runSearch, initialSearch, latest]);
  const seeAll = (where: '/office/jobs' | '/office/customers') => {
    if (!confirmLeave()) return;
    // The query goes in page state, never in the URL (NFR-05).
    try {
      window.sessionStorage.setItem(SEARCH_CARRY_KEY, typed.trim());
    } catch {
      // storage blocked: the page opens without the query
    }
    router.push(where);
  };

  // CTL-CMP-07-07 user menu, CTL-CMP-07-08 sign out, CTL-CMP-07-09 the switch.
  const [userOpen, setUserOpen] = useState(initialMenu === 'user');
  const toggleSlash = async () => {
    const want = slash === 'on' ? 'off' : 'on';
    setSlash(want);
    setSlashError(false);
    const saved = await read().read('API-08', { slashShortcut: want });
    if (!saved.ok) {
      // Fails: the switch returns to its saved position with the message (CTL-CMP-07-09).
      setSlash(want === 'on' ? 'off' : 'on');
      setSlashError(true);
    }
  };
  const signOut = async () => {
    // The session cookie is httpOnly: no script can clear it. API-06 clears it in its answer, on every outcome (F-230), and
    // the sign-in page opens whether the call worked or not (CTL-CMP-07-08).
    await read().read('API-06');
    window.location.assign('/sign-in');
  };

  const roleWord = t(ROLE_KEY[me.role]);
  const branchName = branchById(branch).name;
  return (
    <header className={overflow >= entries.length ? 'topbar r1top bw-all-in-more' : 'topbar r1top'} ref={headerRef} data-cmp="CMP-07">
      <a className="brand" href="/office/board" data-ctl="CTL-CMP-07-01">
        <Mark />
        <span className="word">
          {t('brand.name')}
          <small>{t('brand.product')}</small>
        </span>
      </a>
      <span className="appname">{t('shell.office.app')}</span>
      <nav data-ctl="CTL-CMP-07-02" aria-label={t('shell.office.sections')}>
        {shownLinks.map((e) => {
          const on = isCurrent(e, pathname);
          return (
            <a key={e.id} href={e.href} className={on ? 'on' : undefined} aria-current={on ? 'page' : undefined}>
              {t(e.label)}
            </a>
          );
        })}
        {moreLinks.length > 0 ? (
          <a href="#" role="button" aria-expanded={moreOpen} data-ctl="CTL-CMP-07-03" onClick={(ev) => (ev.preventDefault(), setMoreOpen((o) => !o))}>
            {t('shell.office.more')}
            <Icon name="chevDown" />
          </a>
        ) : null}
      </nav>
      {moreOpen && moreLinks.length > 0 ? (
        <div className="r1-menu bw-more" role="menu" aria-label={t('shell.office.more')} data-ctl="CTL-CMP-07-03">
          {moreLinks.map((e) => (
            <a key={e.id} role="menuitem" href={e.href} data-ctl="CTL-CMP-07-02" aria-current={isCurrent(e, pathname) ? 'page' : undefined}>
              {t(e.label)}
            </a>
          ))}
        </div>
      ) : null}
      <span className="spacer" />
      <div className="branch bw-overlay" data-ctl="CTL-CMP-07-04">
        <span translate="no">{branchName}</span>
        <Icon name="chevDown" />
        <select aria-label={t('shell.office.branch')} value={branch} onChange={(e) => chooseBranch(e.target.value)}>
          {BRANCHES.map((b) => (
            <option key={b.id} value={b.id} translate="no">
              {b.name}
            </option>
          ))}
        </select>
      </div>
      <div className="search" data-ctl="CTL-CMP-07-05">
        <Icon name="search" />
        <input
          ref={inputRef}
          type="search"
          className="bw-search-input"
          placeholder={t('shell.office.search')}
          aria-label={t('shell.office.searchLabel')}
          aria-expanded={resultsOpen}
          aria-controls="bw-search-results"
          role="combobox"
          autoComplete="off"
          defaultValue={initialSearch?.query ?? ''}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setResultsOpen(false);
          }}
        />
        {slash === 'on' ? <kbd data-ctl="CTL-CMP-07-10">/</kbd> : null}
      </div>
      {resultsOpen ? (
        <div className="r1-menu sres bw-search-results" id="bw-search-results" role="listbox" aria-label={t('shell.office.searchResults')} data-ctl="CTL-CMP-07-05">
          {searchFailed ? (
            <div className="mi" role="alert">
              {t('shell.office.searchError')}{' '}
              <button type="button" className="btn sm" onClick={() => void runSearch(typed.trim())}>
                {t('shell.error.tryAgain')}
              </button>
            </div>
          ) : results && results.jobs.length + results.customers.length + results.addresses.length === 0 ? (
            <div className="mi">{t('shell.office.searchNone')}</div>
          ) : results ? (
            <>
              {results.jobs.length > 0 ? <h5>{t('shell.office.nav.jobs')}</h5> : null}
              {results.jobs.map((j) => (
                <a key={`j${j.jobNumber}`} role="option" aria-selected="false" href={`/office/jobs/${j.jobNumber}`}>
                  {t('shell.office.searchJob', { jobNumber: j.jobNumber, customer: j.customer })}
                </a>
              ))}
              {results.more?.jobs ? (
                <a role="option" aria-selected="false" href="/office/jobs" onClick={(e) => (e.preventDefault(), seeAll('/office/jobs'))}>
                  {t('shell.office.searchAllJobs')}
                </a>
              ) : null}
              {results.customers.length > 0 ? <h5>{t('shell.office.nav.customers')}</h5> : null}
              {results.customers.map((c) => (
                <a key={`c${c.id}`} role="option" aria-selected="false" href={`/office/customers/${c.id}`}>
                  {c.name}
                </a>
              ))}
              {results.more?.customers ? (
                <a role="option" aria-selected="false" href="/office/customers" onClick={(e) => (e.preventDefault(), seeAll('/office/customers'))}>
                  {t('shell.office.searchAllCustomers')}
                </a>
              ) : null}
              {results.addresses.length > 0 ? <h5>{t('shell.office.searchAddresses')}</h5> : null}
              {results.addresses.map((a) => (
                <a key={`a${a.customerId}${a.address}`} role="option" aria-selected="false" href={`/office/customers/${a.customerId}`}>
                  {a.address}
                </a>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
      <button type="button" className="iconbtn bw-btn-reset" aria-label={t('shell.office.alerts', { count: bellCount ?? 0 })} aria-haspopup="dialog" aria-expanded={bellOpen} data-ctl="CTL-CMP-07-06" onClick={bell.toggle}>
        <Icon name="bell" />
        {bellCount ? <span className="badge">{bellCount}</span> : null}
      </button>
      {bellOpen ? <AlertsPanelView state={bell.state} manager={me.role === 'manager'} onClose={closeBell} onEmail={bell.email} onDismiss={bell.dismiss} /> : null}
      <button type="button" className="user bw-btn-reset" data-ctl="CTL-CMP-07-07" aria-haspopup="menu" aria-expanded={userOpen} onClick={() => setUserOpen((o) => !o)}>
        <span className="av">{initials(me.name)}</span>
        <span>
          <span translate="no">{shortName(me.name)}</span>
          <span className="role">{roleWord}</span>
        </span>
      </button>
      {userOpen ? (
        <div className="r1-menu bw-user-menu" role="menu" aria-label={me.name ?? roleWord}>
          <div className="mi">
            <span className="av sm" translate="no">
              {initials(me.name)}
            </span>
            <span>
              <b translate="no">{me.name ?? roleWord}</b>
              <br />
              <small>{me.branch ? t('shell.role.withBranch', { role: roleWord, branch: branchById(me.branch).name }) : roleWord}</small>
            </span>
          </div>
          <div className="sep" />
          <div className="mi">
            <span>{t('language.choose')}</span>
            <LanguageSwitch staff />
          </div>
          <label className={slash === 'on' ? 'r1-switch on mi' : 'r1-switch mi'} data-ctl="CTL-CMP-07-09">
            <button type="button" className="trk bw-btn-reset" role="switch" aria-checked={slash === 'on'} aria-label={t('shell.office.slash')} onClick={() => void toggleSlash()} />
            {t('shell.office.slash')}
            <span className="st">{t(slash === 'on' ? 'shell.switch.on' : 'shell.switch.off')}</span>
          </label>
          {slashError ? (
            <div className="mi" role="alert">
              {t('shell.office.slashNotSaved')}
            </div>
          ) : null}
          <div className="sep" />
          <a role="menuitem" href="/sign-in" data-ctl="CTL-CMP-07-08" onClick={(e) => (e.preventDefault(), void signOut())}>
            <Icon name="back" />
            {t('shell.signOut')}
          </a>
        </div>
      ) : null}
    </header>
  );
}
