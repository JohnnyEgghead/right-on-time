// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-TEC-08 Directions (UI-SPECIFICATION v0.15 2.3; DK-113 mockups/pages/tech-map.html, the Directions frames, kit 0.9; FR-TECH-5, FR-TECH-13,
// FR-MAP-1, FR-MAP-3): one tap from Today, the job or the Map tab to the route to the next job on the app's own street map, with the destination
// in words, the drive time (the minutes the Directions button shows), the Next turn card and the turn-by-turn Steps (P6-WEB-STEPS, F-1233: "I have
// never heard of an app that does not include turn-by-turn instructions as a primary component of directions."). The route is read again with each
// read round of the day (GAP-7); a re-read that is another route says Route updated, and a new next turn is announced by the card's live region.
// The last route read for this destination is kept on the phone (section 4.5 rule 11), so with no signal the steps of that read still show. The
// Back link opens Today, as CTL-TEC-04-01 does (OI-56). The rules (states, step rows, Route updated) are steps.ts, the native app's equal.
import '../shell/css/phone.ts';
import '../../styles/page-tech-map.css';
import { windowLabelOfWire, clockOfWire } from '@bw/i18n';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { MapView } from '../map/MapView.tsx';
import { isBranchId, type MapMarker, type MapRoute } from '../map/map-model.ts';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { techReads, useTechData, type TechData } from './data.ts';
import { realNow } from '@bw/time';
import { lastTryOf, TechErrorPanel } from './TechErrorPanel.tsx';
import type { OutboxState } from './engine.ts';
import { isRestOf, nextTurn, stepRows, stepsPhase, streetOf, type RouteRead, type ShownRoute, type StepRow } from './steps.ts';
import { NoSignalCard } from './SyncStrip.tsx';
import { TechAppFrame } from './TechAppFrame.tsx';
import { useOutbox } from './useOutbox.ts';
import type { Destination } from './view-model.ts';

export interface TechDirectionsScreenProps {
  jobNumber: number;
  /** The job the route starts from (Directions on the job after it, CTL-TEC-04-04); unset: from the last finished stop, else the depot. */
  from?: number;
  /** A preview's fixed reads, engine state and route. */
  fixedData?: TechData;
  fixedOutbox?: OutboxState;
  fixedRoute?: RouteRead | null;
  /** A preview of Route updated (CTL-TEC-08-08): the announcement already showing. */
  fixedUpdated?: boolean;
}

/** The keys that press a control made of a span (the frames draw the Back link and the steps as spans with a role). */
const pressed = (e: KeyboardEvent, go: () => void): void => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    go();
  }
};

export function TechDirectionsScreen({ jobNumber, from, fixedData, fixedOutbox, fixedRoute, fixedUpdated = false }: TechDirectionsScreenProps) {
  const t = useT();
  const router = useRouter();
  const data = useTechData(fixedData);
  const outbox = useOutbox(fixedOutbox);
  const [read, setRead] = useState<RouteRead | null>(fixedRoute ?? null);
  const [updated, setUpdated] = useState(fixedUpdated);
  const [focus, setFocus] = useState<{ at: readonly [number, number]; key: number } | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [tries, setTries] = useState(0);
  const [failedAt, setFailedAt] = useState<number | null>(null); // F-1777: when the last route read failed, for the panel's Last try time
  const offline = !outbox.online || !data.online;
  const fixed = fixedOutbox ? { fixed: fixedOutbox } : {};

  // The destination in words comes from the day (saved on the phone), so it shows with no signal too.
  const job = data.day?.data.jobs.find((j) => j.jobNumber === jobNumber);
  const stop = data.route?.data.stops.find((s) => s.jobNumber === jobNumber);
  const dest: Destination | null = job
    ? { jobNumber, customer: job.customer.name, address: job.address, window: job.window }
    : stop ? { jobNumber, customer: stop.customer, address: stop.address, window: stop.window } : null;
  const address = dest?.address ?? '';
  const street = streetOf(address);

  // API-104 with signal: on open, after Try again, and with each read round of the day (GAP-7: on open, on focus, after a send, every 60 s).
  // The saved day is a new object with each answered round, so a round re-reads the route even while the demo clock holds still.
  const round = data.day;
  useEffect(() => {
    if (fixedRoute !== undefined || offline || jobNumber <= 0) return;
    let live = true;
    void techReads().leg(jobNumber, from).then((r) => {
      if (!live) return;
      if (r.kind === 'failed') setFailedAt(realNow('device_stamp').epochMilliseconds);
      setRead(r);
    });
    return () => {
      live = false;
    };
  }, [jobNumber, from, offline, fixedRoute, round, tries]);

  // CTL-TEC-08-08: a re-read that is another route redraws with Route updated (the live region below says it).
  const shown = useRef<ShownRoute | null>(null);
  useEffect(() => {
    if (read?.kind !== 'leg') return;
    const before = shown.current;
    shown.current = read;
    if (before !== null && !isRestOf(before, read)) {
      setUpdated(true);
      setFocus(null);
    }
  }, [read]);

  // The kept read of this destination, on the saved day (rule 11).
  const kept: ShownRoute | null = data.routes !== null && data.routes.date === data.day?.data.date ? data.routes.routes[String(jobNumber)] ?? null : null;
  const phase = stepsPhase(read, offline, kept !== null, jobNumber > 0);
  // What the screen draws: the live read with signal, the kept read of this destination with none.
  const route: ShownRoute | null = phase === 'offlineSaved' ? kept : read?.kind === 'leg' ? read : null;
  const live = phase === 'route' || phase === 'approximate';
  const rows = useMemo(() => (route && phase !== 'approximate' ? stepRows(route.steps, t, street, phase === 'route') : []), [route, phase, t, street]);
  const turn = useMemo(() => (route && phase === 'route' ? nextTurn(route.steps, t, street) : null), [route, phase, t, street]);

  const leg = live && route ? route.leg : null;
  const branch = route && isBranchId(route.branch) ? route.branch : 'columbus';
  const markers: MapMarker[] = useMemo(() => {
    const out: MapMarker[] = [];
    if (leg && dest) {
      out.push({
        id: 'to', kind: 'stop', state: 'next', at: [leg.to.lon, leg.to.lat], text: stop ? String(stop.number) : '',
        words: t('tech.map.stopWords', { n: stop?.number ?? 0, state: t('tech.map.state.next'), customer: dest.customer, area: dest.address }),
      });
    }
    // The map marker at the next turn, with its words (CTL-TEC-08-01).
    if (turn) out.push({ id: 'turn', kind: 'turn', at: [turn.at[0], turn.at[1]], icon: turn.icon, words: `${turn.lead} ${turn.words}` });
    return out;
  }, [leg, dest, stop, turn, t]);
  const routes: MapRoute[] = useMemo(() => (leg ? [{ id: 'leg', from: [leg.from.lon, leg.from.lat], to: [leg.to.lon, leg.to.lat], track: leg.track }] : []), [leg]);

  const back = () => router.push('/tech');
  const pick = (r: StepRow) => setFocus((f) => ({ at: r.at, key: (f?.key ?? 0) + 1 }));
  const fit = () => {
    setFocus(null);
    setFitKey((k) => k + 1);
  };
  const minutes = route && route.leg.track !== null && (phase === 'route' || phase === 'offlineSaved') ? route.leg.minutes : null;

  // Reading the phone (rule 12, F-1434; kit 0.12 57520d6c): the destination comes from the kept day, so until the page has read it the
  // name and address are skeletons, never an empty card.
  const destCard = data.reading === true && dest === null ? (
    <div className="dest" data-ctl="CTL-TEC-08-02" aria-busy="true">
      <div className="lab">{t('tech.dir.next')}</div>
      <span className="r1-skel bw-skel-name" />
      <span className="r1-skel bw-skel-80" />
      <a role="link" href={`/tech/jobs/${jobNumber}`} data-ctl="CTL-TEC-08-04">{t('tech.dir.openJob')}</a>
    </div>
  ) : (
    <div className="dest" data-ctl="CTL-TEC-08-02">
      <div className="lab">{t('tech.dir.next')}</div>
      <h2 translate="no">{dest?.customer ?? ''}</h2>
      <div className="addr">{dest ? t('tech.dir.where', { address: dest.address, window: windowLabelOfWire(dest.window) }) : ''}</div>
      {minutes !== null ? (
        <div className="dt" data-ctl="CTL-TEC-08-03">
          <Icon name="truck" />
          {t('tech.dir.about', { n: minutes })}
        </div>
      ) : null}
      <a role="link" href={`/tech/jobs/${jobNumber}`} data-ctl="CTL-TEC-08-04">{t('tech.dir.openJob')}</a>
    </div>
  );

  return (
    <TechAppFrame
      screen="SCR-TEC-08"
      tab="map"
      {...(fixedData ? { data: fixedData } : {})}
      {...(fixedOutbox ? { fixed: fixedOutbox, reader: false as const, clock: null } : {})}
      header={(
        <div className="dh">
          <div className="nav">
            <span role="link" tabIndex={0} onClick={back} onKeyDown={(e: KeyboardEvent) => pressed(e, back)}>
              <Icon name="back" />
              {t('tech.dir.back')}
            </span>
            <span />
          </div>
          <h1>{t('tech.dir.title')}</h1>
        </div>
      )}
    >
      {phase === 'offline' || phase === 'offlineSaved' ? <div className="bw-tech-pad"><NoSignalCard {...fixed} /></div> : null}
      {phase === 'failed' ? (
        <div className="bw-tech-pad10">
          <TechErrorPanel title={t('tech.dir.notLoaded')} hint={t('tech.dir.notLoadedBody')} btn="btn try" lastTry={lastTryOf(failedAt, data.day?.data.zone, t.lang)} onRetry={() => setTries((n) => n + 1)} />
        </div>
      ) : null}
      {phase === 'moved' ? <div className="moved"><div className="r1p-empty" role="alert"><Icon name="alert" /><span>{t('tech.dir.moved')}</span></div></div> : null}
      {phase === 'none' ? (
        <div className="below"><div className="r1p-empty"><Icon name="check" /><span>{t('tech.dir.noMore')}</span></div></div>
      ) : (
        <>
          {phase === 'failed' || phase === 'moved' ? null : (
            <div className="tmap" data-ctl="CTL-TEC-08-01">
              {phase === 'loading' ? <span className="skel" /> : null}
              {phase === 'offline' || phase === 'offlineSaved' ? (
                <div className="need" role="img" aria-label={t('tech.map.label')}>
                  <Icon name="signal" />
                  <span>{phase === 'offline' ? t('tech.dir.needSignal', { address }) : t('tech.map.needSignal')}</span>
                </div>
              ) : null}
              {live ? <MapView branch={branch} markers={markers} routes={routes} fit fitRoutes fitKey={fitKey} focus={focus} variant="card" /> : null}
              {/* CTL-TEC-08-07: back to the whole route as it first opened, after a step was picked. */}
              {live ? (
                <span className="fab" role="button" tabIndex={0} aria-label={t('tech.dir.fit')} data-ctl="CTL-TEC-08-07" onClick={fit} onKeyDown={(e: KeyboardEvent) => pressed(e, fit)}>
                  <Icon name="nav" />
                </span>
              ) : null}
            </div>
          )}
          {destCard}
          {phase === 'loading' ? (
            <div className="below">
              <h3>{t('tech.dir.steps')}</h3>
              <ol className="steps" aria-label={t('tech.dir.steps')} aria-busy="true">
                {[62, 74, 48].map((w) => (
                  <li key={w}><span className="sb"><span className="mv" /><span className={`r1-skel w${w}`} /></span></li>
                ))}
              </ol>
            </div>
          ) : null}
          {phase === 'approximate' || (phase === 'route' && rows.length === 0) ? (
            <div className="below">
              <h3>{t('tech.dir.steps')}</h3>
              <div className="noturn"><Icon name="info" /><span>{t('tech.dir.approximate', { address })}</span></div>
            </div>
          ) : null}
          {rows.length > 0 ? (
            <div className="below">
              {turn ? (
                <div className="nturn" role="status" aria-live="polite" data-ctl="CTL-TEC-08-05">
                  <span className="mv"><Icon name={turn.icon} /></span>
                  <span className="tx"><b>{turn.lead}</b><span>{turn.words}</span></span>
                </div>
              ) : null}
              <h3>{phase === 'offlineSaved' && route ? t('tech.dir.stepsFrom', { time: clockOfWire(route.at) }) : t('tech.dir.steps')}</h3>
              <ol className="steps" aria-label={t('tech.dir.steps')} data-ctl="CTL-TEC-08-06">
                {rows.map((r) => (
                  <li key={r.index} className={[r.arrive ? 'arrive' : '', r.now ? 'now' : ''].filter(Boolean).join(' ') || undefined}>
                    <span
                      className="sb"
                      role="button"
                      tabIndex={0}
                      {...(live ? { onClick: () => pick(r), onKeyDown: (e: KeyboardEvent) => pressed(e, () => pick(r)) } : {})}
                    >
                      <span className="mv"><Icon name={r.icon} /></span>
                      <span className="tx">
                        {r.now ? <span className="now-t">{t('tech.dir.now')}</span> : null}
                        <span>{r.words}</span>
                      </span>
                      {r.distance !== null ? <span className="w">{r.distance}</span> : null}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {/* CTL-TEC-08-08 (CMP-11): the live region is always in the page; Route updated shows in it when a re-read answers another route. */}
          <div className="bw-tech-upd" aria-live="polite">
            {updated && live ? (
              <div className="r1p-notice" role="status" data-ctl="CTL-TEC-08-08">
                <Icon name="bell" />
                <span>{t('tech.dir.routeUpdated')}</span>
              </div>
            ) : null}
          </div>
          <div className="bw-tech-gap" />
        </>
      )}
    </TechAppFrame>
  );
}
