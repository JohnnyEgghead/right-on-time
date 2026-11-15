// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-CUS-06 Change your visit time (frame mockups/pages/customer-reschedule.html, DK-125): the customer's own page at `/r/{token}`.
// The view takes the read and the page's own state; RescheduleScreen is the live wrapper. The markup is the frame's own, in its order,
// so the page rules (styles/page-customer-reschedule.css, a byte copy) apply as they do there. Every state of the frame is a state
// of this one view: Loading, Choosing, No other time, Saving, Changed, Kept, Ended and Not valid (and the Window just filled notice).
import type { MessageKey } from '@bw/i18n';
import type { ReactNode } from 'react';
import { DemoStrip } from '../shell/DemoStrip.tsx';
import type { ClockAnswer } from '../shell/clock.ts';
import type { AppInfo } from '../shell/Footer.tsx';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { Screen } from '../shell/Surface.tsx';
import { visitText, weekdayOf, windowLabel, type MovedVisit, type RescheduleData, type RescheduleDay } from './api.ts';
import { BrandRow, Notice, PhoneFoot, SegLang } from './PhoneParts.tsx';
// The page's own rules load after the kit sheets PhoneParts brings, as the frame page orders its sheets.
import '../../styles/page-customer-reschedule.css';

export type RescheduleState = 'loading' | 'choosing' | 'saving' | 'changed' | 'kept' | 'ended' | 'not_valid' | 'failed';
/** What the last confirm answered when it did not move the visit: the window filled, or the day or window is closed to online booking. */
export type RescheduleNotice = 'window_full' | 'closed' | 'failed' | null;

export interface RescheduleViewProps {
  state: RescheduleState;
  data: RescheduleData | null;
  /** The phone of the office: the read's, or the ended answer's. */
  phone: string;
  pickedDay: string | null;
  pickedWindow: string | null;
  /** The windows the server answered window_full for since the read: they show Full. */
  filled?: ReadonlySet<string>;
  notice?: RescheduleNotice;
  moved?: MovedVisit | null;
  onPickDay?: (date: string) => void;
  onPickWindow?: (windowId: string) => void;
  onConfirm?: () => void;
  onKeep?: () => void;
  onRetry?: () => void;
  clock?: ClockAnswer | null;
  appInfo?: AppInfo | null;
  fixed?: boolean;
}

const keyed = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  fn();
};

export function RescheduleView(p: RescheduleViewProps) {
  const t = useT();
  const d = p.data;
  const day: RescheduleDay | null = d?.days.find((x) => x.date === p.pickedDay) ?? null;
  const windows = day?.windows ?? [];
  const picked = windows.find((w) => w.windowId === p.pickedWindow) ?? null;
  // The button says the weekday and the window (frame: "Confirm new time: Wed, 10 AM-2 PM").
  const whenPicked = day && picked ? `${t(`time.weekday.${weekdayOf(day.date)}` as MessageKey)}, ${windowLabel(picked.start, picked.end)}` : null;
  const current = d ? visitText(d.visit.day, d.visit.window.start, d.visit.window.end, t) : '';
  const phone = p.phone;
  const msg = (cls: string, icon: 'check' | 'clock' | 'alert' | 'calendar', text: ReactNode) => <Notice className={`msgc ${cls}`} icon={icon}>{text}</Notice>;

  const cur = d ? (
    <div className="cur" data-ctl="CTL-CUS-06-01">
      <span className="ico"><Icon name="gauge" /></span>
      <div>
        <small>{t('reschedule.current')}</small>
        <b>{t(d.visit.serviceLabelKey as MessageKey)}</b>
        <span className="s">{t('reschedule.currentNote', { when: current })}</span>
      </div>
    </div>
  ) : null;
  const keep = <div className="keep" role="button" tabIndex={0} data-ctl="CTL-CUS-06-05" onClick={() => p.onKeep?.()} onKeyDown={keyed(() => p.onKeep?.())}>{t('reschedule.keep')}</div>;
  const priv = <div className="priv" data-ctl="CTL-CUS-06-06"><Icon name="lock" /><div>{t('reschedule.privacy')}</div></div>;
  const noOther = Boolean(d && d.days.every((x) => x.state === 'full'));

  const top = (
    <>
      <DemoStrip variant="phone" {...(p.fixed ? { initial: p.clock ?? null, reader: false as const } : {})} />
      <BrandRow className="brandrow" phone={phone} lang={<SegLang />} />
      <h1>{t('reschedule.title')}</h1>
    </>
  );

  let body: ReactNode;
  let foot: ReactNode = null;
  switch (p.state) {
    case 'loading':
      body = (
        <>
          <div data-ctl="CTL-CUS-06-01"><span className="r1-skel bw-w-80 bw-h-18" /><span className="r1-skel" /></div>
          <div className="days" data-ctl="CTL-CUS-06-02">{[0, 1, 2, 3, 4].map((i) => <div className="day" key={i}><span className="r1-skel" /></div>)}</div>
        </>
      );
      break;
    case 'changed': {
      const v = p.moved?.visit;
      const when = v ? visitText(v.day, v.window.start, v.window.end, t) : '';
      body = msg('ok', 'check', <>{t('reschedule.changed', { when })}{p.moved?.outcome.textSent ? t('reschedule.changedText') : ''}</>);
      foot = priv;
      break;
    }
    case 'kept':
      body = msg('ok', 'check', t('reschedule.kept', { when: current }));
      foot = priv;
      break;
    case 'ended':
      body = msg('warn', 'clock', t('reschedule.ended', { phone }));
      break;
    case 'not_valid':
      body = msg('warn', 'alert', t('reschedule.notValid'));
      break;
    case 'failed':
      body = msg('warn', 'alert', <>{t('reschedule.loadFailed')} <span className="bw-retry" role="button" tabIndex={0} onClick={() => p.onRetry?.()} onKeyDown={keyed(() => p.onRetry?.())}>{t('shell.error.tryAgain')}</span></>);
      break;
    default: {
      // Choosing and Saving.
      const saving = p.state === 'saving';
      body = (
        <>
          {cur}
          {noOther ? msg('warn', 'calendar', t('reschedule.noOther', { phone })) : (
            <>
              <div className="lab">{t('reschedule.pickDay')}<small>{d?.days[0] ? monthYear(d.days[0].date, t) : ''}</small></div>
              <div className="days" role="radiogroup" aria-label={t('reschedule.pickDay')} data-ctl="CTL-CUS-06-02">
                {d?.days.map((x) => <DayTile key={x.date} day={x} current={d.visit.day === x.date} selected={p.pickedDay === x.date} onPick={() => p.onPickDay?.(x.date)} />)}
              </div>
              {day?.mode === 'four_hour' ? (
                <div className="busyb">
                  <Icon name="info" />
                  <div>
                    <b>{t('reschedule.busyTitle')}</b>
                    <span>{t.rich('reschedule.busyText', { day: dayText(day.date, t), n: (c) => <span className="bw-nowrap">{c}</span> })}</span>
                  </div>
                </div>
              ) : null}
              {day ? (
                <>
                  <div className="lab">{t('reschedule.pickWindow')}<small>{dayText(day.date, t)}</small></div>
                  <div className="wins" role="radiogroup" aria-label={t('reschedule.pickWindow')} data-ctl="CTL-CUS-06-03">
                    {windows.map((w) => {
                      const full = w.state === 'full' || Boolean(p.filled?.has(w.windowId));
                      const sel = p.pickedWindow === w.windowId && !full;
                      const word = full ? t('reschedule.winFull') : sel ? t('reschedule.winSelected') : w.placesLeft !== null ? t('reschedule.winLeft', { n: w.placesLeft }) : t('reschedule.winOpen');
                      return (
                        <div
                          key={w.windowId} className={`win${full ? ' full' : ''}${sel ? ' sel' : ''}${!full && !sel && w.placesLeft !== null ? ' few' : ''}`}
                          role="radio" aria-checked={sel} {...(full ? { 'aria-disabled': true } : {})} tabIndex={full ? -1 : 0}
                          onClick={() => { if (!full) p.onPickWindow?.(w.windowId); }} onKeyDown={keyed(() => { if (!full) p.onPickWindow?.(w.windowId); })}
                        >
                          <span className="radio" />
                          <span className="tx">{windowLabel(w.start, w.end)}<span className="r">{word}</span></span>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : null}
              {p.notice === 'window_full' ? msg('warn', 'alert', t('reschedule.windowFilled')) : null}
              {p.notice === 'closed' ? msg('warn', 'alert', t('reschedule.closed', { phone })) : null}
              {p.notice === 'failed' ? msg('warn', 'alert', t('reschedule.failed')) : null}
            </>
          )}
        </>
      );
      const ready = Boolean(picked) && !saving;
      foot = (
        <>
          {noOther ? null : saving ? (
            <div className="go busy" role="button" aria-busy="true" data-ctl="CTL-CUS-06-04"><span className="r1-spin" />{t('reschedule.saving')}</div>
          ) : (
            <div
              className={`go${ready ? '' : ' dis'}`} role="button" tabIndex={ready ? 0 : -1} {...(ready ? {} : { 'aria-disabled': true })}
              data-ctl="CTL-CUS-06-04" onClick={() => { if (ready) p.onConfirm?.(); }} onKeyDown={keyed(() => { if (ready) p.onConfirm?.(); })}
            >
              <Icon name="check" sw={2.6} />{whenPicked ? t('reschedule.confirm', { when: whenPicked }) : t('reschedule.confirmNone')}
            </div>
          )}
          {keep}
          {priv}
        </>
      );
    }
  }

  return (
    <Screen screen="SCR-CUS-06" surface="SURF-CUS" noClock footer={false} title={t('reschedule.doc')} className="bw-inb bw-resched">
      <div className="screen">
        <div className="pg">
          {top}
          {body}
          <PhoneFoot {...(p.appInfo !== undefined ? { info: p.appInfo } : {})} {...(p.fixed ? { reader: false as const } : {})} brk />
        </div>
        {foot ? <div className="foot">{foot}</div> : null}
      </div>
    </Screen>
  );
}

function dayText(date: string, t: (k: MessageKey, v?: Record<string, string | number>) => string): string {
  const [, m, d] = date.split('-').map(Number) as [number, number, number];
  return t('inbox.date', { weekday: t(`time.weekday.${weekdayOf(date)}` as MessageKey), month: t(`time.month.${m}` as MessageKey), day: d });
}

function monthYear(date: string, t: (k: MessageKey, v?: Record<string, string | number>) => string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return t('reschedule.monthYear', { month: t(`reschedule.monthLong.${m}` as MessageKey), year: y });
}

function DayTile({ day, current, selected, onPick }: { day: RescheduleDay; current: boolean; selected: boolean; onPick: () => void }) {
  const t = useT();
  const full = day.state === 'full';
  const [, , dd] = day.date.split('-').map(Number) as [number, number, number];
  const tag = current ? t('reschedule.dayCurrent') : full ? t('reschedule.dayFull') : day.mode === 'four_hour' ? t('reschedule.dayBusy') : t('reschedule.dayTwoHour');
  return (
    <div
      className={`day${current ? ' now' : ''}${selected ? ' sel' : ''}${day.mode === 'four_hour' ? ' busy' : ''}`}
      role="radio" aria-checked={selected} {...(full ? { 'aria-disabled': true } : {})} tabIndex={full ? -1 : 0}
      onClick={() => { if (!full) onPick(); }} onKeyDown={keyed(() => { if (!full) onPick(); })}
    >
      <small>{t(`time.weekday.${weekdayOf(day.date)}` as MessageKey)}</small>
      <b>{dd}</b>
      <em>{tag}</em>
    </div>
  );
}
