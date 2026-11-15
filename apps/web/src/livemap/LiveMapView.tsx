// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-CUS-04 Live map: on the way and SCR-CUS-05 Live map: ended, as views of 1 state (UI-SPECIFICATION 2.3; mockups/pages/customer-live-map.html and
// customer-live-map-ended.html, DK-123 and DK-124). The page body is the frame's `.pg`: the demo bar, the brand row (CMP-14), the heading,
// the map (CMP-05), the trip progress, the technician card, the privacy line, Call Brightwater (CMP-16) and the footer. The ended page draws no
// map and holds no coordinate (FR-TEXT-4, NFR-04): nothing of the van's place is a prop of the ended views.
import '../shell/css/public.ts';
import '../../styles/page-customer-live-map.css';
import '../../styles/page-customer-live-map-ended.css';
import '../../styles/app/livemap.css';
import type { ClockAnswer } from '../shell/clock.ts';
import { DemoStrip } from '../shell/DemoStrip.tsx';
import { CallButton } from '../shell/CallButton.tsx';
import type { AppInfo } from '../shell/Footer.tsx';
import { Icon, Mark } from '../shell/Icon.tsx';
import type { MessageKey } from '@bw/i18n';
import { useT } from '../shell/intl.tsx';
import { LanguageSwitch } from '../shell/LanguageSwitch.tsx';
import type { Reader } from '../shell/reads.ts';
import { timeText } from '../board/model.ts';
import { windowZoned } from '../booking/model.ts';
import { formatPhone } from '../customers/model.ts';
import { isBranchId, type BranchId, type MapMarker, type MapRoute } from '../map/map-model.ts';
import { MapView } from '../map/MapView.tsx';
import { arrivedInside, endedVariant, firstName, heroLine, longDay, progressPercent, techLine, visitLine, type EndedDetail, type LiveData, type LiveState } from './model.ts';

/** What a preview or a test fixes in the frame: the clock, the footer's facts and no reads of its own. */
export interface Fixed {
  clock?: ClockAnswer | null;
  appInfo?: AppInfo | null;
  reader?: Reader | false;
}

const SCREEN = (screen: string, children: React.ReactNode, f: Fixed, title: string) => (
  <div className="r1-screen bw-screen r1p lm" data-screen={screen} data-surface="SURF-CUS">
    <title>{title}</title>
    <div className="pg">
      <DemoStrip variant="phone" {...(f.clock !== undefined ? { initial: f.clock } : {})} {...(f.reader !== undefined ? { reader: f.reader } : {})} />
      {children}
      <Foot f={f} />
    </div>
  </div>
);

/** CMP-14 on the phone: the brand, the branch's office phone and the language switch. The phone is known once a read has answered. */
function BrandRow({ phone }: { phone: string | null }) {
  const t = useT();
  return (
    <div className="brandrow" data-ctl="CTL-CMP-14-01" data-cmp="CMP-14">
      <span className="brand">
        <Mark />
        <span className="word">{t('brand.name')}</span>
      </span>
      {phone ? <span className="tel14">{formatPhone(phone)}</span> : null}
      <LanguageSwitch className="lang" />
    </div>
  );
}

/** CMP-04 on the phone (the frame's .r1p-foot): the source link, the sample-data notice and the demo mode marker. */
function Foot({ f }: { f: Fixed }) {
  const t = useT();
  const info = f.appInfo ?? null;
  return (
    <div className="r1p-foot" data-cmp="CMP-04">
      {info ? (
        <>
          <a href={info.sourceUrl} data-ctl="CTL-CMP-04-01">
            {t('shell.footer.source')} {info.sourceCommit.slice(0, 7)}
          </a>
          {' - '}
        </>
      ) : null}
      <span data-ctl="CTL-CMP-04-02">{t('shell.footer.sample')}</span>
      {info?.demoMode ? (
        <>
          <br />
          <span className="demo" data-ctl="CTL-CMP-04-03">
            {t('shell.footer.demo')}
          </span>
        </>
      ) : null}
    </div>
  );
}

/** CMP-16 Call Brightwater: a tel: link on a phone, the number shown on a computer. `withNumber` prints the number on the button (SCR-CUS-05). */
function CallBrightwater({ phone, ctl, withNumber }: { phone: string; ctl: string; withNumber: boolean }) {
  const t = useT();
  const shown = formatPhone(phone);
  return (
    <div className="bw-callbox" data-ctl={ctl}>
      <CallButton name={t('brand.name')} fullName={t('brand.name')} number={shown} className="call">
        <Icon name="phone" />
        {t('livemap.call')}
        {withNumber ? <small>{shown}</small> : null}
      </CallButton>
    </div>
  );
}

const Skeleton = () => (
  <>
    <div className="skl" data-ctl="CTL-CUS-04-02">
      <span className="r1-skel w70 tall" />
      <span className="r1-skel w90" />
    </div>
    <div className="mapw" data-ctl="CTL-CUS-04-01">
      <span className="r1-skel fill" />
    </div>
  </>
);

/** The live map, drawn from API-116's data; with `failed` the van and its route are removed (NFR-04), the rest stays. */
function LiveBody({ data, now, failed }: { data: LiveData; now: string; failed: boolean }) {
  const t = useT();
  const name = firstName(data.technician.name);
  const hero = heroLine(t, data.minutesAway, data.eta);
  const pct = progressPercent(data.leftAt, data.eta, now);
  const markers: MapMarker[] = [
    ...(data.van && !failed
      ? [{ id: 'van', kind: 'van' as const, state: 'way' as const, at: [data.van.lon, data.van.lat] as const, text: data.technician.initials, words: t('job.way.vanWords', { name: data.technician.name }) }]
      : []),
    { id: 'home', kind: 'house' as const, at: [data.destination.lon, data.destination.lat] as const, words: t('livemap.map.home') },
  ];
  const routes: MapRoute[] = failed ? [] : [{ id: 'leg', from: [data.route.from.lon, data.route.from.lat], to: [data.route.to.lon, data.route.to.lat], track: data.route.track }];
  const branch: BranchId = isBranchId(data.branch) ? data.branch : 'columbus';
  const arriving = data.eta ? timeText(data.eta) : '';
  const value = data.minutesAway !== null ? t('livemap.eta.value', { left: timeText(data.leftAt), arriving, n: data.minutesAway }) : t('livemap.eta.valueNoMin', { left: timeText(data.leftAt), arriving });
  return (
    <>
      <BrandRow phone={data.officePhone} />
      <div className="hero" role="status" aria-live="polite" data-ctl="CTL-CUS-04-02">
        <h1>{t('livemap.hero.title', { name })}</h1>
        {hero ? (
          <p>
            {hero.lead}
            <b>{hero.time}</b>
          </p>
        ) : null}
      </div>
      <div className={failed ? 'mapw short' : 'mapw'} data-ctl="CTL-CUS-04-01">
        <MapView branch={branch} variant="card" fit markers={markers} routes={routes} />
      </div>
      {failed ? (
        <div className="msgc warn" role="status">
          <Icon name="alert" />
          <span>{t('livemap.failed')}</span>
        </div>
      ) : (
        <div className={`eta pct${pct}`} role="progressbar" aria-label={t('livemap.eta.label')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={value} data-ctl="CTL-CUS-04-05">
          <span>{t('livemap.eta.left', { time: timeText(data.leftAt) })}</span>
          <span className="track">
            <i />
            <b />
          </span>
          <span>{arriving}</span>
        </div>
      )}
      <div className="who" data-ctl="CTL-CUS-04-03">
        <span className="av">{data.technician.initials}</span>
        <div>
          <b>{data.technician.name}</b>
          <span className="s">
            {techLine(t, data.technician.van)}
            <br />
            {visitLine(t, data.visit, data.leftAt)}
          </span>
        </div>
      </div>
      <div className="stop" data-ctl="CTL-CUS-04-04">
        <Icon name="lock" />
        <div>{t('livemap.stop', { name })}</div>
      </div>
      <CallBrightwater phone={data.officePhone} ctl="CTL-CUS-04-06" withNumber={false} />
    </>
  );
}

/**
 * CTL-CUS-04-06 before any read has answered (F-1134, manager ruling on F-950 item 4): the page carries the office number from its first
 * load, so Call shows in Loading and in a first read that failed. Not valid shows its message only, as its frame draws it.
 */
const callIf = (phone: string | null) => (phone ? <CallBrightwater phone={phone} ctl="CTL-CUS-04-06" withNumber={false} /> : null);

/** SCR-CUS-04 in each state its frame shows. */
export function LiveMapView({ state, fixed = {}, officePhone = null }: { state: LiveState; fixed?: Fixed; officePhone?: string | null }) {
  const t = useT();
  if (state.kind === 'ended') return <EndedView detail={state.detail} fixed={fixed} />;
  let body: React.ReactNode;
  switch (state.kind) {
    case 'loading':
      body = (
        <>
          <BrandRow phone={officePhone} />
          <Skeleton />
          {callIf(officePhone)}
        </>
      );
      break;
    case 'not_found':
      body = (
        <>
          <BrandRow phone={null} />
          <div className="msgc" role="status" data-ctl="CTL-CUS-04-02">
            <Icon name="alert" />
            <span>{t('livemap.notValid')}</span>
          </div>
        </>
      );
      break;
    case 'failed':
      body = (
        <>
          <BrandRow phone={officePhone} />
          <div className="msgc warn" role="status">
            <Icon name="alert" />
            <span>{t('livemap.failed')}</span>
          </div>
          {callIf(officePhone)}
        </>
      );
      break;
    default:
      body = <LiveBody data={state.data} now={state.now} failed={state.failed} />;
  }
  return SCREEN('SCR-CUS-04', body, fixed, t('livemap.doc'));
}

/** SCR-CUS-05: no map is drawn and no coordinate is on the page (FR-TEXT-4, NFR-04). */
export function EndedView({ detail, fixed = {} }: { detail: EndedDetail; fixed?: Fixed }) {
  const t = useT();
  const variant = endedVariant(detail);
  const tech = detail.technician;
  const visit = detail.visit;
  const name = tech ? firstName(tech.name) : '';
  const phone = detail.officePhone;
  const message = (
    <div className="ended" data-ctl="CTL-CUS-05-02">
      <span className="badge">
        <Icon name="map" />
      </span>
      <p>{variant === 'arrived' ? t('livemap.ended.msgArrived', { name }) : t('livemap.ended.msg')}</p>
    </div>
  );
  let body: React.ReactNode;
  if (variant === 'changed') {
    body = (
      <>
        <BrandRow phone={phone} />
        <div className="hero">
          <div data-ctl="CTL-CUS-05-01">
            <h1>{t('livemap.ended.changed')}</h1>
          </div>
        </div>
        {message}
        {phone ? <CallBrightwater phone={phone} ctl="CTL-CUS-05-04" withNumber /> : null}
      </>
    );
  } else {
    const arrived = variant === 'arrived' && detail.arrivedAt && visit;
    body = (
      <>
        <BrandRow phone={phone} />
        <div className="hero">
          {arrived ? (
            <span className="chip site">
              <span className="dot" />
              {t('livemap.ended.chipArrived')}
            </span>
          ) : (
            <span className="chip done">
              <span className="dot" />
              {t('livemap.ended.chipEnded')}
            </span>
          )}
          {arrived ? (
            <div data-ctl="CTL-CUS-05-01">
              <h1>{t('livemap.ended.arrived', { name })}</h1>
              <p>
                {t('livemap.ended.at')}
                <b>{timeText(detail.arrivedAt!)}</b>
                {t(arrivedInside(detail.arrivedAt!, visit.window) ? 'livemap.ended.inside' : 'livemap.ended.outside', { window: windowZoned(visit.window.start, visit.window.end) })}
              </p>
            </div>
          ) : null}
        </div>
        {message}
        {visit ? (
          <div className="card2" data-ctl="CTL-CUS-05-03">
            {tech ? (
              <div className="who" data-ctl="CTL-CUS-05-06">
                <span className="av">{tech.initials}</span>
                <div>
                  <b>{tech.name}</b>
                  <span className="s">{techLine(t, tech.van)}</span>
                </div>
              </div>
            ) : null}
            <div className="li">
              <span>{t('livemap.ended.visit')}</span>
              <b>{t(visit.serviceLabelKey as MessageKey)}</b>
            </div>
            <div className="li">
              <span>{t('livemap.ended.day')}</span>
              <b>{longDay(t, visit.day)}</b>
            </div>
            <div className="li">
              <span>{t('livemap.ended.window')}</span>
              <b>{windowZoned(visit.window.start, visit.window.end)}</b>
            </div>
            {arrived ? (
              <div className="li">
                <span>{t('livemap.ended.arrivedLine')}</span>
                <b>{timeText(detail.arrivedAt!)}</b>
              </div>
            ) : null}
          </div>
        ) : null}
        {variant === 'arrived' ? (
          <div className="priv" data-ctl="CTL-CUS-05-05">
            <Icon name="lock" />
            <div>{t('livemap.ended.privacy')}</div>
          </div>
        ) : null}
        {phone ? <CallBrightwater phone={phone} ctl="CTL-CUS-05-04" withNumber /> : null}
      </>
    );
  }
  return SCREEN('SCR-CUS-05', body, fixed, t('livemap.doc'));
}
