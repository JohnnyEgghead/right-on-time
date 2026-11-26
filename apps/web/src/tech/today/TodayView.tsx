// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-TEC-02 Today as DK-107 draws it (mockups/pages/tech-today.html; running late: tech-running-late.html): the header with the
// van and the day's progress, the done rows, the next job card and Later today (UI-SPECIFICATION 8, CTL-TEC-02-01 to -15). A pure
// view: the container (TodayScreen.tsx) reads the day and the item engine; a preview route passes the same props fixed.
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import { fromWire, formatTime } from '@bw/time';
import { useRouter } from 'next/navigation';
import type { KeyboardEvent, ReactNode } from 'react';
import { dayLabel, windowWords as windowLabel } from '../../inbox/api.ts';
import { PhoneFoot } from '../../inbox/PhoneParts.tsx';
import { Icon } from '../../shell/Icon.tsx';
import type { IconName } from '../../shell/icon-paths.ts';
import { useT, type ClientT } from '../../shell/intl.tsx';
import { lastTryOf, TechErrorPanel } from '../TechErrorPanel.tsx';
import { NoSignalCard, OldItemsBanner, WaitingCount } from '../SyncStrip.tsx';
import type { OutboxState } from '../engine.ts';
import { canStartWay, ENDED, firstName, nextJob, progress, surname, type LocalJob } from './model.ts';
import type { TodayAnswer } from '@bw/api';
import { DemoStrip } from '../../shell/DemoStrip.tsx';
import type { ClockAnswer } from '../../shell/clock.ts';
import type { AppInfo } from '../../shell/Footer.tsx';

export type SheetKind = 'omw' | 'arrived' | 'noh';

export interface TodayViewProps {
  /** The day to draw; null with `loading` set shows the skeleton, null otherwise the offline-with-nothing-saved state. */
  day: TodayAnswer | null;
  jobs: LocalJob[];
  loading: boolean;
  online: boolean;
  /** When the saved list was read (offline: "Last updated"); wire time. */
  savedAt: string | null;
  /** A read failed: CMP-12 above the saved list, or alone when the phone has signal and nothing is saved (F-1019). */
  failed: boolean;
  /** When the failed read ended (the phone's stamp, ms): the panel's Last try time (F-1777). */
  failedAt?: number | null;
  notice: string | null;
  fixed?: OutboxState;
  clock?: ClockAnswer | null;
  info?: AppInfo | null;
  /** New day (F-1135): the date changed since the last list; draws the date heading, the jobs as Later rows and a skeleton row. */
  newDay?: boolean;
  /** CTL-TEC-02-03: the drive minutes of the next job's route (API-104); null: not known (offline, or the route is approximate), and the button says only Directions. */
  driveMinutes?: number | null;
  /** The jobs whose finish waits for its signature: each draws the Finish link back to the finish screen (CTL-TEC-02-06). */
  owedSignatures?: ReadonlySet<number>;
  onRefresh?: () => void;
  onOpen?: (kind: SheetKind, job: LocalJob) => void;
}

const EQUIPMENT_TYPES: ReadonlySet<string> = new Set(['furnace', 'air_conditioner', 'thermostat', 'water_heater']);
const SERVICE_ICON = (key: string): IconName => (/ac_|air|cool/.test(key) ? 'snow' : /plumb|water|drain/.test(key) ? 'drop' : 'flame');

/** "gas furnace, 2014": the equipment's kind in the person's words, then its year. */
function equipmentText(e: NonNullable<LocalJob['equipment']>, t: ClientT): string {
  const label = (EQUIPMENT_TYPES.has(e.type) ? t(`customers.equipment.${e.type}` as MessageKey) : e.type.replace(/_/g, ' ')).toLowerCase();
  return e.year ? `${label}, ${e.year}` : label;
}

function lastVisitDate(date: string, t: ClientT): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${t(`time.month.${m}` as MessageKey)} ${d}, ${y}`;
}

const timeOf = (wire: string, zone: string, lang: 'en' | 'es') => formatTime(fromWire(wire).toInstant(), zone, lang);

export function Waiting({ pending, sent = false }: { pending: boolean; sent?: boolean }) {
  const t = useT();
  if (!pending && !sent) return null;
  return (
    <span className={`r1p-wait${sent ? ' sent' : ''}`}>
      <Icon name={sent ? 'check' : 'clock'} sw={sent ? 2.6 : 2.2} />
      {t(sent ? 'tech.item.sent' : 'tech.item.waiting')}
    </span>
  );
}

/** A span acts as a button the way the frame draws it: a click or Enter or Space. */
export function press(fn: (() => void) | undefined) {
  if (!fn) return {};
  return {
    onClick: fn,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fn();
      }
    },
  };
}

function DoneRow({ j, zone, t, owesSignature }: { j: LocalJob; zone: string; t: ClientT; owesSignature: boolean }) {
  const stamp = j.endedAt ?? j.localAt;
  const at = stamp ? timeOf(stamp, zone, t.lang) : '';
  return (
    <div className="done" data-ctl="CTL-TEC-02-01" data-job={j.jobNumber}>
      <span className="num"><Icon name="check" sw={3} /></span>
      <div>
        <a className="rl" href={`/tech/jobs/${j.jobNumber}`}><span><b translate="no">{surname(j.customer.name)}</b> - {j.area}</span></a>
        {owesSignature ? <a className="lnk" href={`/tech/jobs/${j.jobNumber}/finish`} data-ctl="CTL-TEC-02-06">{t('tech.today.finish')}</a> : null}
      </div>
      <span className="t">
        {j.status === 'no_one_home' ? t('tech.today.noOneHomeAt', { time: at }) : t('tech.today.doneAt', { time: at })}
        {j.pending || j.sent ? <> <Waiting pending={j.pending} sent={j.sent} /></> : null}
      </span>
    </div>
  );
}

function LaterRow({ j, t }: { j: LocalJob; t: ClientT }) {
  return (
    <a className="later" href={`/tech/jobs/${j.jobNumber}`} data-ctl="CTL-TEC-02-01" data-job={j.jobNumber}>
      <span className="num">{j.position}</span>
      <div className="tx"><b translate="no">{surname(j.customer.name)}</b><small>{j.area} - {t(j.serviceLabelKey as MessageKey)}</small></div>
      <span className="w">{windowLabel(j.window.start, j.window.end)}<small>{t(`customers.status.${j.status}` as MessageKey)}</small>{j.pending ? <Waiting pending /> : null}</span>
    </a>
  );
}

function NextCard({ j, jobs, zone, t, onOpen, driveMinutes = null }: { j: LocalJob; jobs: LocalJob[]; zone: string; t: ClientT; onOpen: TodayViewProps['onOpen']; driveMinutes?: number | null }) {
  const late = j.lateText;
  const first = firstName(j.customer.name);
  const digits = j.customer.phone?.replace(/[^\d+]/g, '');
  const eta = late ? fromWire(late.eta).toInstant() : null;
  const was = late?.wasEta ? fromWire(late.wasEta).toInstant() : null;
  const minLate = eta && was ? Math.round((eta.epochMilliseconds - was.epochMilliseconds) / 60_000) : null;
  const wasWords = t('tech.today.was', { time: '\u0001' }).split('\u0001');
  const lateCard = late !== null && j.status === 'scheduled';
  const canWay = canStartWay(jobs, j);
  const open = (k: SheetKind) => () => onOpen?.(k, j);
  const router = useRouter();
  const go = (href: string) => router.push(href);
  const onSite = j.status === 'on_site';
  return (
    <div className={`next${lateCard ? ' is-late' : ''}`} data-ctl="CTL-TEC-02-02" data-job={j.jobNumber}>
      <div className="lab"><span className="num">{j.position}</span>{t(lateCard ? 'tech.today.nextLate' : 'tech.today.next')}<span className="win">{windowLabel(j.window.start, j.window.end)}</span></div>
      <h2 translate="no">{j.customer.name}</h2>
      <div className="addr">{j.address}</div>
      <div className="what">
        <Icon name={SERVICE_ICON(j.serviceLabelKey)} />
        <span><b>{t(j.serviceLabelKey as MessageKey)}</b>{j.equipment ? ` - ${equipmentText(j.equipment, t)}` : ''}</span>
      </div>
      {j.status !== 'scheduled' ? (
        <div className={onSite ? 'stl' : 'what'}>
          <span className={`chip ${onSite ? 'site' : 'way'}`}><span className="dot" />{t(`customers.status.${j.status}` as MessageKey)}</span>
          {' '}<Waiting pending={j.pending} sent={j.sent} />
        </div>
      ) : null}
      {late && lateCard ? (
        <>
          <div className="late" data-ctl="CTL-TEC-02-07">
            <Icon name="alert" sw={2.2} />
            <div data-ctl="CTL-TEC-02-15"><small className="k">{t('tech.today.newArrival')}</small><b>{t('tech.today.about', { time: timeOf(late.eta, zone, t.lang) })}</b></div>
            <span className="times" data-ctl="CTL-TEC-02-15">
              {minLate !== null && minLate > 0 ? <>{t('tech.today.minLate', { min: minLate })}<br /></> : null}
              {late.wasEta ? <>{wasWords[0]}<s>{timeOf(late.wasEta, zone, t.lang)}</s>{wasWords[1]}</> : null}
            </span>
          </div>
          <div className="texted" data-ctl="CTL-TEC-02-07">
            <Icon name="message" />
            <div><b>{t('tech.today.texted', { name: first })}</b>{t('tech.today.textedAt', { time: timeOf(late.sentAt, zone, t.lang) })}</div>
          </div>
        </>
      ) : j.lastVisit ? (
        <div className="what">
          <Icon name="clock" />
          <span>{t('tech.today.lastVisit', { date: lastVisitDate(j.lastVisit.date, t) })} - <a className="lnk" href={`/tech/jobs/${j.jobNumber}?history=1`} data-ctl="CTL-TEC-02-13">{t('tech.today.history')}</a></span>
        </div>
      ) : null}
      {j.customerNote && !lateCard ? <div className="notebox"><b>{t('tech.today.note')}</b>{j.customerNote}</div> : null}
      <div className="row2">
        <a className="pbtn" href={`/tech/jobs/${j.jobNumber}/directions`} role="button" data-ctl="CTL-TEC-02-03"><Icon name="nav" />{t('tech.today.directions')}{driveMinutes !== null ? <> <small>{t('tech.map.directionsMin', { n: driveMinutes })}</small></> : null}</a>
        {digits ? (
          <a className={`pbtn ${lateCard ? 'callc' : 'sq'}`} href={`tel:${digits}`} role="button" aria-label={t('tech.today.callAria', { name: first })} data-ctl="CTL-TEC-02-11">
            <Icon name="phone" />{lateCard ? t('tech.today.callName', { name: first }) : null}
          </a>
        ) : null}
        {lateCard ? null : <a className="pbtn sq" href={`/tech/jobs/${j.jobNumber}`} role="button" aria-label={t('tech.today.openJob')} data-ctl="CTL-TEC-02-12"><Icon name="note" /></a>}
      </div>
      {j.status === 'scheduled' ? (
        <>
          <div className={`omw${canWay ? '' : ' dis'}`} role="button" tabIndex={canWay ? 0 : -1} aria-disabled={!canWay || undefined} data-ctl="CTL-TEC-02-04" {...press(canWay ? open('omw') : undefined)}>
            <Icon name="truck" sw={2.2} />{t('tech.today.onMyWay')}
          </div>
          {lateCard ? null : <div className="omwnote">{t('tech.today.omwNote', { name: first })}</div>}
        </>
      ) : null}
      {onSite ? (
        <div className="acts3">
          <span className="pri" role="link" tabIndex={0} data-ctl="CTL-TEC-02-06" {...press(() => go(`/tech/jobs/${j.jobNumber}/finish`))}><Icon name="check" sw={2.6} />{t('tech.today.finish')}</span>
          <span role="button" tabIndex={0} data-ctl="CTL-TEC-02-09" {...press(open('noh'))}>{t('tech.today.noOneHome')}</span>
        </div>
      ) : (
        <>
          <div className="acts3">
            <span role="button" tabIndex={0} data-ctl="CTL-TEC-02-05" {...press(open('arrived'))}><Icon name="pin" />{t('tech.today.arrived')}</span>
            <span className="dis" aria-disabled="true" data-ctl="CTL-TEC-02-09">{t('tech.today.noOneHome')}</span>
            <span className="dis" aria-disabled="true" data-ctl="CTL-TEC-02-06">{t('tech.today.finish')}</span>
          </div>
          <div className="why3">{t(j.status === 'on_the_way' && j.pending ? 'tech.today.omwSaved' : 'tech.today.opensAfter')}</div>
        </>
      )}
    </div>
  );
}

/** The header (DK-107 .apphead): title, the date with the van and the progress, the waiting count (CMP-10), and the demo clock with Refresh. */
export function TodayHeader({ day, jobs, loading, online, fixed, clock, onRefresh, t }: Pick<TodayViewProps, 'day' | 'jobs' | 'loading' | 'online' | 'fixed' | 'clock' | 'onRefresh'> & { t: ClientT }) {
  const f = fixed ? { fixed } : {};
  const clk = <DemoStrip variant="header" offline={!online} {...(clock !== undefined ? { initial: clock } : {})} {...(fixed ? { reader: false as const } : {})} />;
  if (loading) {
    return (
      <div className="apphead">
        <div className="r"><div><h1>{t('tech.tab.today')}</h1><div className="d"><span className="r1-skel bw-w-190" /></div></div></div>
        {clk}
      </div>
    );
  }
  const p = progress(jobs);
  const parts = day
    ? [dayLabel(day.date, t), day.van ? t('tech.today.van', { van: day.van.number }) : null, jobs.length > 0 || online ? t('tech.today.progress', { done: p.done, total: p.total }) : null]
    : [];
  return (
    <div className="apphead">
      <div className="r">
        <div><h1>{t('tech.tab.today')}</h1><div className="d" data-ctl="CTL-TEC-02-10">{parts.filter(Boolean).join(' - ')}</div></div>
        <WaitingCount variant="today" {...f} />
      </div>
      <div className="clkrow">
        {clk}
        {online ? (
          <span className="rf" role="button" tabIndex={0} aria-label={t('tech.today.refresh')} data-ctl="CTL-TEC-02-08" {...press(onRefresh)}><Icon name="refresh" /></span>
        ) : null}
      </div>
    </div>
  );
}

function Empty({ icon, children }: { icon: IconName; children: ReactNode }) {
  return <div className="r1p-empty"><Icon name={icon} /><span>{children}</span></div>;
}

/** The list under the header, for every state SCR-TEC-02 shows. */
export function TodayList({ day, jobs, loading, online, savedAt, failed, failedAt, notice, fixed, info, driveMinutes, newDay, owedSignatures, onRefresh, onOpen }: TodayViewProps) {
  const t = useT();
  const f = fixed ? { fixed } : {};
  if (loading) {
    return (
      <div className="list">
        <div className="sec">{t('tech.tab.today')}</div>
        {[0, 1, 2, 3].map((i) => (
          <div className="later" key={i}><span className="num" /><div className="tx"><span className="r1-skel bw-w-55" /><span className="r1-skel bw-w-80" /></div></div>
        ))}
      </div>
    );
  }
  if (newDay && day) {
    return (
      <div className="list">
        <div className="sec">{t('tech.today.newDay', { date: dayLabel(day.date, t) })}</div>
        {jobs.map((j) => <LaterRow key={j.jobNumber} j={j} t={t} />)}
        <div className="later"><span className="num" /><div className="tx"><span className="r1-skel bw-w-55" /><span className="r1-skel bw-w-80" /></div></div>
        <PhoneFoot {...(info ? { info } : {})} {...(fixed ? { reader: false as const } : {})} brk />
      </div>
    );
  }
  const zone = day?.zone ?? 'America/New_York';
  const done = jobs.filter((j) => ENDED.has(j.status));
  const next = nextJob(jobs);
  const later = jobs.filter((j) => !ENDED.has(j.status) && j.jobNumber !== next?.jobNumber);
  return (
    <div className={`list${next?.lateText && next.status === 'scheduled' ? ' is-late-day' : ''}`}>
      <NoSignalCard {...f} />
      <OldItemsBanner {...f} />
      {notice ? <div className="r1p-notice" role="status" aria-live="polite"><Icon name="bell" /><span>{notice}</span></div> : null}
      {failed ? (
        <TechErrorPanel title={t('tech.today.error')} hint={savedAt ? t('tech.today.errorSaved', { time: timeOf(savedAt, zone, t.lang) }) : null} cmp={false}
          lastTry={lastTryOf(failedAt, zone, t.lang)} onRetry={() => onRefresh?.()} />
      ) : null}
      {!day && !failed ? <Empty icon="signal">{t('tech.today.noSaved')}</Empty> : null}
      {day && jobs.length === 0 ? <Empty icon="calendar">{t('tech.today.none')}</Empty> : null}
      {day && jobs.length > 0 && !next ? <Empty icon="check">{t('tech.today.allDone', { n: jobs.length })}</Empty> : null}
      {day && !online && savedAt ? <div className="sec">{t('tech.today.updated', { time: timeOf(savedAt, zone, t.lang) })}</div> : null}
      {done.map((j) => <DoneRow key={j.jobNumber} j={j} zone={zone} t={t} owesSignature={owedSignatures?.has(j.jobNumber) ?? false} />)}
      {next ? <NextCard j={next} jobs={jobs} zone={zone} t={t} onOpen={onOpen} driveMinutes={driveMinutes ?? null} /> : null}
      {later.length > 0 ? <div className="sec">{t('tech.today.later')}</div> : null}
      {later.map((j) => <LaterRow key={j.jobNumber} j={j} t={t} />)}
      <PhoneFoot {...(info ? { info } : {})} {...(fixed ? { reader: false as const } : {})} brk />
    </div>
  );
}
