// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The Dispatch board's map panel (SCR-OFC-02; P4-BOARD-MAP; DK-85 office-board.html): the live vans count (CTL-OFC-02-23), Hide map (-22), Vans / Jobs /
// Both (-24), All skills (-30), the vans menu (-31), CMP-05 with its van and job markers (-12, -26) and legend (-25), the
// selected van card with Open job and Call (-13, -14, -27), and the job list tabs (-28) over Needs attention (-15) and the
// job rows (-29). The panel holds no state of its own beyond its open menu: BoardScreen owns the choices and the reads.
import type { MessageKey } from '@bw/i18n';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { MapView } from '../map/MapView.tsx';
import { isBranchId, type MapMarker, type MapRoute } from '../map/map-model.ts';
import { CallButton } from '../shell/CallButton.tsx';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { ErrorPanel } from '../shell/Panels.tsx';
import {
  allJobs, boardSkills, filtered, jobClass, jobMarkerState, JOB_TABS, shortName, shortWindow, statusKey, tabCounts, tabJobs, timeText, timingKey, vanState, windowText,
  type Board, type BoardJob, type JobTab, type MapShows, type Van,
} from './model.ts';

/** The panel's map opens on the whole branch area (the frame's crop), at the zoom its 372 px box fits it. */
const PANEL_ZOOM = 9.4;

const JOB_MARKER = 'job-';
const VAN_MARKER = 'van-';
const TAB_WORDS: Record<JobTab, MessageKey> = { all: 'board.map.tab.all', attention: 'board.att.title', onTheWay: 'status.job.onTheWay', onSite: 'status.job.onSite' };

export interface MapPanelProps {
  branch: string | null;
  board: Board | null;
  /** API-20's latest read failed. With no board that is the Partial state of the list region: CMP-12 there, no counts (F-812). */
  boardFailed: boolean;
  /** API-21's answer: the vans at the demo time, whatever day is shown; 'failed' is the Partial state (markers hidden, the message shown); null until it answers. */
  vans: readonly Van[] | 'failed' | null;
  shows: MapShows;
  skill: string | null;
  tab: JobTab;
  selected: string | null;
  /** The Needs attention rows (BoardScreen's, with Mark handled). */
  attention: ReactNode;
  /** CTL-OFC-02-35 / -36: the map at the board's full width and a tall height, the timeline set aside; the same button turns it back. */
  large: boolean;
  onLarge(on: boolean): void;
  onHide(): void;
  onShows(s: MapShows): void;
  onSkill(s: string | null): void;
  onTab(t: JobTab): void;
  onSelect(technicianId: string): void;
  onOpenJob(jobNumber: number, element: HTMLElement): void;
  onRetryVans(): Promise<unknown>;
  onRetryBoard(): Promise<unknown>;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function MapPanel(p: MapPanelProps) {
  const t = useT();
  const { board, skill, shows } = p;
  const f = useMemo(() => (board ? filtered(board, skill) : null), [board, skill]);
  const failed = p.vans === 'failed';
  // F-812: null while API-21 has not answered or failed, so every van number below is printed only from a read that succeeded.
  const known = p.vans === 'failed' || p.vans === null ? null : p.vans;
  const everyVan = useMemo(() => known ?? [], [known]);
  const vans = useMemo(() => (skill === null ? everyVan : everyVan.filter((v) => v.skills.includes(skill))), [everyVan, skill]);
  const jobOf = useMemo(() => new Map(board ? allJobs(board).map((j) => [j.jobNumber, j]) : []), [board]);
  const live = everyVan.filter((v) => v.position !== null).length;
  const selectedVan = p.selected ? vans.find((v) => v.technicianId === p.selected) ?? null : null;

  // A van's job comes from API-20: on another day's board, or with API-20 failed, it is not there, and the words say only what API-21 knows.
  const vanWords = (v: Van, job: BoardJob | undefined): string => {
    if (v.status === 'between_jobs') return t('board.map.van.between', { name: v.name });
    if (!job) return t(v.status === 'on_site' ? 'board.map.van.onSiteBare' : 'board.map.van.wayBare', { name: v.name });
    if (v.status === 'on_site') return t('board.map.van.onSite', { name: v.name, area: job.area });
    const eta = v.eta ? timeText(v.eta) : '';
    return vanState(v, job) === 'late' ? t('board.map.van.late', { name: v.name, area: job.area, eta }) : t('board.map.van.way', { name: v.name, area: job.area, eta });
  };

  const showVans = shows !== 'jobs';
  const showJobs = shows !== 'vans';
  const markers: MapMarker[] = [];
  const routes: MapRoute[] = [];
  if (showVans) {
    for (const v of vans) {
      const job = v.jobNumber === null ? undefined : jobOf.get(v.jobNumber);
      if (v.route) {
        routes.push({ id: `leg-${v.technicianId}`, from: [v.route.from.lon, v.route.from.lat], to: [v.route.to.lon, v.route.to.lat], track: v.route.track });
        markers.push({ id: `next-${v.technicianId}`, kind: 'house', at: [v.route.to.lon, v.route.to.lat], words: job ? t('board.map.nextStop', { customer: job.customerName, area: job.area }) : t('board.map.nextStopBare') });
      }
    }
    for (const v of vans) {
      if (!v.position) continue;
      const job = v.jobNumber === null ? undefined : jobOf.get(v.jobNumber);
      const on = v.technicianId === p.selected;
      markers.push({
        id: `${VAN_MARKER}${v.technicianId}`, kind: 'van', at: [v.position.lon, v.position.lat], state: vanState(v, job), text: v.initials, words: vanWords(v, job), ctl: 'CTL-OFC-02-12',
        ...(on ? { selected: true, ...(v.van ? { tag: t('board.map.vanNumber', { van: v.van }) } : {}) } : {}),
      });
    }
  }
  if (showJobs && f) {
    for (const j of f.jobs) {
      const status = timingKey(j) ?? statusKey(j);
      markers.push({
        id: `${JOB_MARKER}${j.jobNumber}`, kind: 'job', at: [j.position.lon, j.position.lat], state: jobMarkerState(j), ctl: 'CTL-OFC-02-26',
        words: t('board.map.job', { job: j.jobNumber, customer: j.customerName, area: j.area, status: t(status) }),
      });
    }
  }
  const pressed = (id: string, element: HTMLElement) => {
    if (id.startsWith(VAN_MARKER)) p.onSelect(id.slice(VAN_MARKER.length));
    else if (id.startsWith(JOB_MARKER)) p.onOpenJob(Number(id.slice(JOB_MARKER.length)), element);
  };

  const skills = board ? boardSkills(board) : [];
  const skillWord = (s: string) => t(`skill.${s}` as MessageKey);
  const counts = f ? tabCounts(f) : null;
  const legend = shows === 'both' ? (['vans', 'jobs'] as const) : shows === 'jobs' ? (['jobs'] as const) : (['vans'] as const);

  return (
    <aside className="panel mapp" aria-label={t('board.map.title')}>
      <div className="ph">
        <h2>{t('board.map.title')}</h2>
        {known ? <span className="live" data-ctl="CTL-OFC-02-23"><i className="dotp" />{t('board.map.live', { count: live })}</span> : null}
        <span className="grow" />
        <button type="button" className="btn sm" data-ctl="CTL-OFC-02-22" onClick={p.onHide}>{t('board.map.hide')}</button>
      </div>
      <div className="mtools">
        <div className="seg" role="radiogroup" aria-label={t('board.map.shows')} data-ctl="CTL-OFC-02-24">
          {(['vans', 'jobs', 'both'] as const).map((s) => (
            <span key={s} className={shows === s ? 'on' : undefined} role="radio" aria-checked={shows === s} tabIndex={shows === s ? 0 : -1} onClick={() => p.onShows(s)}
              onKeyDown={(e) => radioKey(e, s, (x) => p.onShows(x))}>{t(`board.map.shows.${s}` as MessageKey)}</span>
          ))}
        </div>
        <span className="msel" data-ctl="CTL-OFC-02-30">
          {skill === null ? t('board.map.allSkills') : skillWord(skill)}<Icon name="chevDown" />
          <select className="bw-msel-input" aria-label={t('board.map.skillFilter')} value={skill ?? ''} onChange={(e) => p.onSkill(e.target.value === '' ? null : e.target.value)}>
            <option value="">{t('board.map.allSkills')}</option>
            {skills.map((s) => <option key={s} value={s}>{skillWord(s)}</option>)}
          </select>
        </span>
        <VansMenu vans={known ? vans : null} onPick={p.onSelect} />
      </div>
      {skill !== null ? (
        <div className="row bw-skill-note">
          <b>{t('board.map.showing', { skill: skillWord(skill) })}</b>
          <button type="button" className="btn sm" data-ctl="CTL-OFC-02-30" onClick={() => p.onSkill(null)}>{t('board.map.allSkills')}</button>
        </div>
      ) : null}
      {failed ? <div className="bw-van-error"><ErrorPanel title={t('board.map.vansFailed')} hint={t('board.map.vansFailedHint')} onRetry={p.onRetryVans} /></div> : null}
      {p.branch && isBranchId(p.branch) ? (
        <MapView branch={p.branch} variant="panel" zoom={PANEL_ZOOM} markers={markers} routes={routes} legend={legend} onMarker={pressed}
          overlay={(
            // F-1544: on the map itself, so the panel's header keeps the frame's one button (look parity).
            <button type="button" className="btn sm bw-mapbig" data-ctl={p.large ? 'CTL-OFC-02-36' : 'CTL-OFC-02-35'} data-large-toggle aria-expanded={p.large} onClick={() => p.onLarge(!p.large)}>
              <Icon name="map" />{t(p.large ? 'board.map.smaller' : 'board.map.larger')}
            </button>
          )} />
      ) : <div className="r1-map bw-map bw-map-panel" />}
      {selectedVan ? <VanCard van={selectedVan} job={selectedVan.jobNumber === null ? undefined : jobOf.get(selectedVan.jobNumber)} /> : null}
      <div className="jtabs" role="tablist" aria-label={t('board.map.tabs')} data-ctl="CTL-OFC-02-28">
        {JOB_TABS.map((x) => (
          <a key={x} role="tab" className={p.tab === x ? 'on' : undefined} aria-selected={p.tab === x} tabIndex={p.tab === x ? 0 : -1} onClick={() => p.onTab(x)}
            onKeyDown={(e) => radioKey(e, x, (v) => p.onTab(v), JOB_TABS)}>
            {t(TAB_WORDS[x])} {counts ? <b>{counts[x]}</b> : null}
          </a>
        ))}
      </div>
      <div role="tabpanel" aria-label={t(TAB_WORDS[p.tab])}>
        {!board ? (p.boardFailed ? <ErrorPanel title={t('board.readError')} hint={t('shell.error.checkConnection')} onRetry={p.onRetryBoard} /> : null)
          : p.tab === 'attention' ? p.attention : f ? <JobRows jobs={tabJobs(f, p.tab)} board={board} /> : null}
      </div>
    </aside>
  );
}

/** Arrow keys walk a radio group or tab list; Enter and Space pick. */
function radioKey<T extends string>(e: KeyboardEvent, value: T, pick: (v: T) => void, list: readonly T[] = ['vans', 'jobs', 'both'] as unknown as readonly T[]) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    pick(value);
    return;
  }
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (step === 0) return;
  e.preventDefault();
  const i = (list.indexOf(value) + step + list.length) % list.length;
  pick(list[i] as T);
  const parent = (e.currentTarget as HTMLElement).parentElement;
  requestAnimationFrame(() => (parent?.children[i] as HTMLElement | undefined)?.focus());
}

/** CTL-OFC-02-31: the menu button with the van count; each van with its technician. Null: API-21 has given no answer, so no count and no menu. */
function VansMenu({ vans, onPick }: { vans: readonly Van[] | null; onPick(id: string): void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  // The list stays drawn for the 1 commit after a failed read, so the layout effect can see focus on an item before the item goes.
  const [list, setList] = useState(vans);
  if (vans !== null && vans !== list) setList(vans);
  const shut = open && vans === null; // the read failed under an open menu
  useLayoutEffect(() => {
    if (!shut) return;
    // F-839, the F-813 class: a 10 s read never drops the keyboard user. Focus on an item goes to the menu's own button.
    if (box.current?.querySelector('[role="menu"]')?.contains(document.activeElement)) box.current.querySelector('button')?.focus();
    setOpen(false);
  }, [shut]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <span className="bw-vans" ref={box} onKeyDown={(e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        box.current?.querySelector('button')?.focus();
      }
    }}>
      <button type="button" className="msel bw-btn-reset" data-ctl="CTL-OFC-02-31" aria-haspopup="menu" aria-expanded={open && vans !== null} aria-disabled={vans === null || undefined} onClick={() => { if (vans !== null) setOpen((o) => !o); }}>
        {vans ? t('board.map.vans', { count: vans.length }) : t('board.map.vansMenu')}<Icon name="chevDown" />
      </button>
      {open && list ? (
        <div className="r1-menu bw-vans-menu" role="menu" aria-label={t('board.map.vansMenu')}>
          {list.map((v) => (
            <button key={v.technicianId} type="button" className="mi bw-btn-reset" role="menuitem" onClick={() => {
              setOpen(false);
              onPick(v.technicianId);
            }}>{v.van ? t('board.map.vanRow', { van: v.van, name: v.name }) : v.name}</button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

/** CTL-OFC-02-13: what the selected van is doing, Open job for its current job, and Call (CMP-16). */
function VanCard({ van, job }: { van: Van; job: BoardJob | undefined }) {
  const t = useT();
  const skill = van.skills.map((x) => t(`skill.${x}` as MessageKey)).join(', ');
  const service = job ? t(job.serviceLabelKey.replace(/\.screen$/, '.text') as MessageKey) : '';
  const eta = van.eta ? timeText(van.eta) : '';
  const window = job ? windowText(job.window.start, job.window.end) : '';
  const chip = van.status === 'on_the_way' ? 'way' : van.status === 'on_site' ? 'site' : 'sched';
  const word: MessageKey = van.status === 'on_the_way' ? 'status.job.onTheWay' : van.status === 'on_site' ? 'status.job.onSite' : 'board.map.van.betweenWord';
  return (
    <div className="vancard" data-ctl="CTL-OFC-02-13">
      <div className="top">
        <span className="av">{van.initials}</span>
        <div><b>{van.van ? t('board.map.card.title', { name: van.name, van: van.van }) : van.name}</b><span className="s">{skill}</span></div>
        <span className={`chip ${chip}`}><span className="dot" />{t(word)}</span>
      </div>
      {job ? (
        <div className="eta">
          {t(van.status === 'on_site' ? 'board.map.card.at' : 'board.map.card.to')} <b>{job.customerName}</b>, {job.area} - {service}<br />
          {t(van.status === 'on_site' ? 'board.map.card.arrived' : 'board.map.card.arriving')} <b>{eta}</b> {t('board.map.card.window', { window })}
        </div>
      ) : van.jobNumber !== null && eta ? (
        // F-838: the shown board does not hold the van's job (another day, or API-20 failed); API-21's own facts still print.
        <div className="eta">{t(van.status === 'on_site' ? 'board.map.card.arrived' : 'board.map.card.arriving')} <b>{eta}</b></div>
      ) : null}
      <div className="acts">
        {van.jobNumber !== null ? <a className="btn sm" href={`/office/jobs/${van.jobNumber}`} data-ctl="CTL-OFC-02-14"><Icon name="note" />{t('board.map.card.open')}</a> : null}
        {van.phone ? <CallButton name={firstName(van.name)} fullName={van.name} number={van.phone} /> : null}
      </div>
    </div>
  );
}

/** CTL-OFC-02-29: window, arrival, customer and area, service, technician and the status word. */
function JobRows({ jobs, board }: { jobs: readonly BoardJob[]; board: Board }) {
  const t = useT();
  const names = new Map(board.technicians.map((x) => [x.id, x.name]));
  if (jobs.length === 0) return <div className="att"><p className="r1-note bw-att-none">{t('board.map.noRows')}</p></div>;
  return (
    <div className="att">
      {jobs.map((j) => {
        const service = t(j.serviceLabelKey as MessageKey);
        const technician = (j.technicianId && shortName(names.get(j.technicianId) ?? null)) ?? '';
        const eta = j.eta ? timeText(j.eta) : '';
        const cls = jobClass(j);
        return (
          <a key={j.jobNumber} className="row jrow" data-ctl="CTL-OFC-02-29" href={`/office/jobs/${j.jobNumber}`}>
            <span className="w">{shortWindow(j.window.start, j.window.end)}</span>
            <div className="tx"><b>{j.customerName}</b> - {j.area}
              <small>{!j.technicianId ? t('board.list.noTech', { service })
                : j.status === 'on_site' ? t('board.list.onSite', { service, eta, technician })
                  : j.status === 'done' || j.status === 'no_one_home' ? t('board.list.ended', { service, eta, technician })
                    : t('board.list.eta', { service, eta, technician })}</small>
            </div>
            <span className={`chip ${cls}`}><span className="dot" />{t(timingKey(j) && j.status !== 'on_site' ? (timingKey(j) as MessageKey) : statusKey(j))}</span>
          </a>
        );
      })}
    </div>
  );
}
