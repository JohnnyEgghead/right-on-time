// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-TEC-15 Map (UI-SPECIFICATION 2.3; DK-113 mockups/pages/tech-map.html; FR-TECH-10, FR-TECH-11, FR-TECH-13, FR-MAP-1, FR-MAP-3): today's
// route on the app's own street map (CMP-05), the stops numbered in the day's order and marked Done, Next or Later, the next stop's card
// with its drive time and Directions, and the Stops list under the map (the map's text alternative, kept with no signal from the saved day).
// The kit slices before the page's own sheet, in the frame's order (its own rules last).
import '../shell/css/phone.ts';
import '../../styles/page-tech-map.css';
import { clockOfWire, windowLabelOfWire, type MessageKey } from '@bw/i18n';
import { useRouter } from 'next/navigation';
import { useRef, useState, type KeyboardEvent } from 'react';
import { MapView } from '../map/MapView.tsx';
import { isBranchId } from '../map/map-model.ts';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { useTechData, type TechData } from './data.ts';
import type { OutboxState } from './engine.ts';
import { legTo, type RouteData, type Stop } from './model.ts';
import { NoSignalCard, WaitingCount } from './SyncStrip.tsx';
import { TechAppFrame } from './TechAppFrame.tsx';
import { useOutbox } from './useOutbox.ts';
import { distText, mapLayers, mapPhase, STATE_KEY } from './view-model.ts';

function StopRow({ s }: { s: Stop }) {
  const t = useT();
  const router = useRouter();
  const href = `/tech/jobs/${s.jobNumber}`;
  const open = () => router.push(href);
  return (
    <div className="stop" role="link" tabIndex={0} data-job={s.jobNumber} data-state={s.state} onClick={open} onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') open(); }}>
      <span className={s.state === 'done' ? 'num done' : s.state === 'next' ? 'num next' : 'num'}>{s.number}</span>
      <div className="tx">
        <b>{s.customer}</b>
        <small>{t('tech.map.stopLine', { area: s.area, service: t(s.serviceLabelKey as MessageKey) })}</small>
      </div>
      <span className="w">
        {windowLabelOfWire(s.window)}
        <small>{t(STATE_KEY[s.state])}</small>
      </span>
    </div>
  );
}

function NextCard({ route, stop }: { route: RouteData; stop: Stop }) {
  const t = useT();
  const router = useRouter();
  const leg = legTo(route, stop.jobNumber);
  return (
    <div className="stopcard" data-ctl="CTL-TEC-15-03">
      <div className="lab">
        <span className="num">{stop.number}</span>
        {t('tech.map.nextStop')}
        <span className="win">{windowLabelOfWire(stop.window)}</span>
      </div>
      <h2>{stop.customer}</h2>
      <div className="addr">{stop.address}</div>
      {leg ? (
        <div className="dist" data-ctl="CTL-TEC-15-09">
          <Icon name="truck" />
          {distText(t, leg, stop.serviceLabelKey)}
        </div>
      ) : null}
      <div className="row2">
        <span className="dir" role="button" tabIndex={0} data-ctl="CTL-TEC-15-04" onClick={() => router.push(`/tech/jobs/${stop.jobNumber}/directions`)}
          onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') router.push(`/tech/jobs/${stop.jobNumber}/directions`); }}>
          <Icon name="nav" />
          {t('tech.map.directions')}
          {leg ? <small>{t('tech.map.directionsMin', { n: leg.minutes })}</small> : null}
        </span>
        <span className="open" role="link" tabIndex={0} data-ctl="CTL-TEC-15-10" onClick={() => router.push(`/tech/jobs/${stop.jobNumber}`)}
          onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') router.push(`/tech/jobs/${stop.jobNumber}`); }}>
          {t('tech.map.openJob')}
          <Icon name="chevRight" />
        </span>
      </div>
    </div>
  );
}

/** The legend over the map (CTL-TEC-15-07): Done, Next, Later, each with its marker. */
function Legend() {
  const t = useT();
  return (
    <div className="legend" data-ctl="CTL-TEC-15-07">
      <span><i className="d done" />{t('tech.map.state.done')}</span>
      <span><i className="d next" />{t('tech.map.state.next')}</span>
      <span><i className="d later" />{t('tech.map.state.later')}</span>
    </div>
  );
}

export interface TechMapScreenProps {
  /** A preview's fixed reads and engine state; the page leaves them unset and the app reads. */
  fixedData?: TechData;
  fixedOutbox?: OutboxState;
}

export function TechMapScreen({ fixedData, fixedOutbox }: TechMapScreenProps) {
  const t = useT();
  const data = useTechData(fixedData);
  const outbox = useOutbox(fixedOutbox);
  const route = data.route?.data ?? null;
  const phase = mapPhase(route, !outbox.online || !data.online, data.settled);
  const [fitKey, setFitKey] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const fixed = fixedOutbox ? { fixed: fixedOutbox } : {};
  const stops = route?.stops ?? [];
  const done = stops.filter((s) => s.state === 'done').length;
  const summary = phase === 'loading' || phase === 'none' ? t('tech.map.summaryOpen', { stops: stops.length }) : t('tech.map.summary', { stops: stops.length, done });
  const nextStop = route && route.next !== null ? stops.find((s) => s.jobNumber === route.next) : undefined;
  const layers = route ? mapLayers(t, route) : null;
  const branch = route && isBranchId(route.branch) ? route.branch : 'columbus';

  // CTL-TEC-15-06: scroll to the Stops list and move focus to its first stop.
  const showList = () => {
    list.current?.scrollIntoView({ block: 'start' });
    list.current?.querySelector<HTMLElement>('.stop')?.focus();
  };

  const saved = data.route ? clockOfWire(data.route.at) : '';
  return (
    <TechAppFrame
      screen="SCR-TEC-15"
      tab="map"
      {...(fixedData ? { data: fixedData } : {})}
      {...(fixedOutbox ? { fixed: fixedOutbox } : {})}
      {...(fixedOutbox ? { reader: false as const, clock: null } : {})}
      header={(
        <div className="apphead">
          <div className="r">
            <div>
              <h1>{t('tech.tab.map')}</h1>
              <div className="d" data-ctl="CTL-TEC-15-08">{summary}</div>
            </div>
            <WaitingCount variant="today" {...fixed} />
          </div>
        </div>
      )}
    >
      <div className="scrollv">
        {phase === 'offline' ? <div className="bw-tech-pad"><NoSignalCard {...fixed} /></div> : null}
        {phase === 'route' && layers && nextStop && route ? (
          <div className="mapw" data-ctl="CTL-TEC-15-01">
            <MapView branch={branch} markers={layers.markers} routes={layers.routes} fit fitKey={fitKey} variant="card" />
            <Legend />
            <span className="fab a" role="button" tabIndex={0} aria-label={t('tech.map.fit')} data-ctl="CTL-TEC-15-05" onClick={() => setFitKey((k) => k + 1)}
              onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') setFitKey((k) => k + 1); }}>
              <Icon name="nav" />
            </span>
            <span className="fab b" role="button" tabIndex={0} aria-label={t('tech.map.list')} data-ctl="CTL-TEC-15-06" onClick={showList}
              onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') showList(); }}>
              <Icon name="list" />
            </span>
            <NextCard route={route} stop={nextStop} />
          </div>
        ) : null}
        {phase === 'alldone' && layers ? (
          <div className="tmap" data-ctl="CTL-TEC-15-01">
            <MapView branch={branch} markers={layers.markers} routes={[]} fit variant="card" />
          </div>
        ) : null}
        {phase === 'loading' ? <div className="tmap" role="application" aria-label={t('tech.map.label')} data-ctl="CTL-TEC-15-01"><span className="skel" /></div> : null}
        {phase === 'offline' ? (
          <div className="tmap" role="application" aria-label={t('tech.map.label')} data-ctl="CTL-TEC-15-01">
            <div className="need"><Icon name="signal" /><span>{t('tech.map.needSignal')}</span></div>
          </div>
        ) : null}
        <div className="below" ref={list}>
          {phase === 'none' ? (
            <div className="r1p-empty"><Icon name="map" /><span>{t('tech.map.noJobs')}</span></div>
          ) : (
            <>
              <h3>{phase === 'offline' && saved ? t('tech.map.stopsSaved', { time: saved }) : t('tech.map.stops')}</h3>
              {phase === 'alldone' ? (
                <div className="r1p-empty"><Icon name="check" /><span>{t('tech.map.allDone')}</span></div>
              ) : route ? (
                <div data-ctl="CTL-TEC-15-02">{stops.map((s) => <StopRow key={s.jobNumber} s={s} />)}</div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </TechAppFrame>
  );
}
