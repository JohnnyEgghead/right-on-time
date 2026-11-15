// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-10 Jobs not in billing, its body (frame mockups/pages/office-billing.html, DK-95): the page header with Retry all and Export
// to spreadsheet, the link card (CTL-OFC-10-01, -02, -12, -13), the waiting table (CTL-OFC-10-03 to -09, -14) and the Fixed in the last
// 7 days table (CTL-OFC-10-10). It draws what it is given (the live screen and the preview states both pass data), so every state of the
// frame is one input.
import '../../styles/app/billing.css';
import type { billingQueue, z } from '@bw/api';
import { leftChipText, leftHowText, leftReasonText, waitingReasonText, type MessageKey } from '@bw/i18n';
import { fromWire } from '@bw/time';
import type { ReactNode } from 'react';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { ErrorPanel, LiveIndicator, type LiveState } from '../shell/Panels.tsx';
import { capitalFirst, clockText, dayTimeText, fullText, sameDay } from './format.ts';

export type Queue = z.infer<typeof billingQueue.response>;
type Item = Queue['items'][number];
type Left = Queue['leftLast7Days'][number];

export type RowBusy = 'retry' | 'resend';

export interface BillingBodyProps {
  /** `loading`: the first read; `error`: it failed; `ready`: `data` is set. */
  status: 'loading' | 'error' | 'ready';
  data?: Queue | null;
  branchName: string;
  live: LiveState;
  rowBusy?: Readonly<Record<number, RowBusy>>;
  /** The id of a row that just arrived in the Fixed table (the Live row frame). */
  arrived?: number | null;
  /** A row shown selected (the frame's first row). */
  selected?: number | null;
  retryAllBusy?: boolean;
  exporting?: boolean;
  /** A write's refusal or failure, shown above the waiting table. */
  message?: string | null;
  onRetryAll?: () => void;
  onExport?: () => void;
  onRetryNow?: (jobNumber: number) => void;
  onSendAgain?: (jobNumber: number) => void;
  onCorrect?: (jobNumber: number) => void;
  onMarkFixed?: (jobNumber: number) => void;
  onReload?: () => Promise<unknown> | unknown;
  onRefresh?: () => void;
}

export const Spinner = ({ dark = false }: { dark?: boolean }) => <span className={dark ? 'r1-spin dark' : 'r1-spin'} />;

function Busy({ label, size, primary, ctl }: { label: string; size?: 'sm'; primary?: boolean; ctl: string }) {
  return (
    <button type="button" className={`btn busy${size ? ` ${size}` : ''}${primary ? ' primary' : ''}`} aria-busy="true" data-ctl={ctl}>
      <Spinner dark={!primary} />
      {label}
    </button>
  );
}

const Skeleton = () => (
  <>
    <span className="r1-skel bw-w-35" />
    <span className="r1-skel" />
    <span className="r1-skel" />
    <span className="r1-skel" />
    <span className="r1-skel" />
  </>
);

const epoch = (wire: string): number => fromWire(wire).epochMilliseconds;

export function BillingBody(p: BillingBodyProps) {
  const t = useT();
  const { data } = p;
  const ready = p.status === 'ready' && data ? data : null;
  const lang = t.lang;
  const clock = (wire: string) => clockText(wire, lang);
  const oldest = ready && ready.items.length > 0 ? ready.items.reduce((a, b) => (epoch(a.doneAt) <= epoch(b.doneAt) ? a : b)) : null;
  const updated = ready ? clock(ready.asOf) : '';

  return (
    <>
      <div className="pgh">
        <div className="row">
          <div>
            <h1>{t('billing.title')}</h1>
            <p>{ready ? t('billing.sub', { branch: p.branchName, time: updated }) : p.branchName}</p>
          </div>
          <div className="acts">
            <LiveIndicator state={p.live} {...(p.onRefresh ? { onRefresh: p.onRefresh } : {})} />
            {p.retryAllBusy ? (
              <Busy label={t('billing.retryAll.busy')} ctl="CTL-OFC-10-08" />
            ) : (
              <button type="button" className="btn" data-ctl="CTL-OFC-10-08" onClick={p.onRetryAll}>
                <Icon name="refresh" />
                {t('billing.retryAll')}
              </button>
            )}
            {p.exporting ? (
              <Busy label={t('billing.export.busy')} ctl="CTL-OFC-10-11" />
            ) : (
              <button type="button" className="btn" data-ctl="CTL-OFC-10-11" onClick={p.onExport}>
                <Icon name="sheet" />
                {t('billing.export')}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="wrap">
        {p.status === 'error' ? (
          <ErrorPanel title={t('billing.loadError.title')} hint={t('shell.error.checkConnection')} onRetry={p.onReload ?? (() => undefined)} />
        ) : null}
        {p.status === 'loading' ? <Skeleton /> : null}
        {ready ? (
          <>
            <LinkCard data={ready} clock={clock} />
            <section className="card">
              <div className="card-h">
                <h3>{t('billing.waiting.title')}</h3>
                <span data-ctl="CTL-OFC-10-14">
                  {oldest ? t('billing.waiting.count', { count: ready.items.length, time: clock(oldest.doneAt) }) : t('billing.waiting.zero')}
                </span>
              </div>
              {p.message ? (
                <div className="r1-fmsg" role="alert">
                  <Icon name="alert" />
                  {p.message}
                </div>
              ) : null}
              {ready.items.length === 0 ? (
                <p className="r1-note">
                  <b>{t('billing.waiting.none')}</b>
                </p>
              ) : (
                <WaitingTable items={ready.items} asOf={ready.asOf} p={p} />
              )}
            </section>
            <div className="lower">
              <FixedCard left={ready.leftLast7Days} arrived={p.arrived ?? null} />
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

function LinkCard({ data, clock }: { data: Queue; clock: (wire: string) => string }) {
  const t = useT();
  const { link } = data;
  const known = link.mode !== null;
  const up = link.mode === 'up';
  const title = !known ? t('billing.link.unknown') : up ? t('billing.link.ok') : t('billing.link.bad');
  const chipClass = !known ? 'chip bill' : up ? 'chip site' : 'chip bad';
  const chipText = known ? t(`pbs.mode.${link.mode}` as MessageKey) : null;
  return (
    <div className="banner">
      <div className="ok" data-ctl="CTL-OFC-10-01">
        <span className="bi">
          <Icon name={up ? 'check' : 'alert'} />
        </span>
        <div>
          <b>
            {title}
            {chipText ? (
              <>
                {' '}
                <span className={chipClass}>
                  <span className="dot" />
                  {chipText}
                </span>
              </>
            ) : null}
          </b>
          <span className="s">
            {link.lastSentAt ? t('billing.link.last', { time: clock(link.lastSentAt) }) : t('billing.link.none')}{' '}
            <span data-ctl="CTL-OFC-10-12">{t('billing.link.note', { inBilling: link.inBillingToday, finished: link.finishedToday })}</span>{' '}
            <a className="r1-link" data-ctl="CTL-OFC-10-02" href="/billing-system">
              {t('billing.link.open')}
            </a>
          </span>
        </div>
      </div>
      <div className="keep" data-ctl="CTL-OFC-10-13">
        <span className="bi">
          <Icon name="lock" />
        </span>
        <div>
          <b>{t('billing.keep.title')}</b>
          <span className="s">{t('billing.keep.body')}</span>
        </div>
      </div>
    </div>
  );
}

function reasonOf(i: Item, t: ReturnType<typeof useT>): { main: string; hint: string } {
  // The main words are the export's too (FR-BILL-12): 1 composition, @bw/i18n billing-rows.
  const main = waitingReasonText(i, t);
  return { main, hint: i.reasonKind === null ? '' : t(`billing.reason.${i.reasonKind}.hint` as MessageKey) };
}

function WaitingTable({ items, asOf, p }: { items: Item[]; asOf: string; p: BillingBodyProps }) {
  const t = useT();
  const lang = t.lang;
  return (
    <table data-ctl="CTL-OFC-10-03">
      <thead>
        <tr>
          <th>{t('billing.col.job')}</th>
          <th>{t('billing.col.customer')}</th>
          <th>{t('billing.col.technician')}</th>
          <th>{t('billing.col.doneAt')}</th>
          <th>{t('billing.col.status')}</th>
          <th>{t('billing.col.tries')}</th>
          <th>{t('billing.col.lastNext')}</th>
          <th className="bw-right">{t('billing.col.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => {
          const busy = p.rowBusy?.[i.jobNumber];
          const reason = reasonOf(i, t);
          const waiting = i.state === 'waiting_person';
          const service = capitalFirst(t(`service.${i.service}.text` as MessageKey));
          return (
            <tr key={i.jobNumber} className={[busy ? 'busy' : '', p.selected === i.jobNumber ? 'sel' : ''].filter(Boolean).join(' ') || undefined}>
              <td className="jn">
                <a className="jl" data-ctl="CTL-OFC-10-04" href={`/office/jobs/${i.jobNumber}`}>
                  {i.jobNumber}
                </a>
              </td>
              <td>
                <div className="two">
                  <b>{i.customer}</b>
                  <small>{`${i.area} - ${service}`}</small>
                </div>
              </td>
              <td>{i.technician ?? ''}</td>
              <td className="num">
                <div className="two">
                  {clockText(i.doneAt, lang)}
                  <small>{sameDay(i.doneAt, asOf) ? t('billing.today') : fullText(i.doneAt, lang, t)}</small>
                </div>
              </td>
              <td className="rs">
                <div className="why">
                  {waiting ? (
                    <span className="chip bill">
                      <Icon name="alert" className="bw-ic13" />
                      {t('billing.status.waiting_person')}
                    </span>
                  ) : (
                    <span className="chip retry">
                      <span className="dot" />
                      {t(`billing.status.${i.state}` as MessageKey)}
                    </span>
                  )}
                  <div className="two">
                    <b>{reason.main}</b>
                    <small>{busy === 'retry' ? t('billing.tryingNow', { n: i.tries + 1 }) : reason.hint}</small>
                  </div>
                </div>
              </td>
              <td className="num">{i.tries}</td>
              <td className="num">
                <div className="two">
                  {i.lastTry ? clockText(i.lastTry, lang) : ''}
                  <small>{i.nextTry ? t('billing.nextTry', { time: clockText(i.nextTry, lang) }) : t('billing.noNext')}</small>
                </div>
              </td>
              <td>
                <div className="acts">
                  <Actions i={i} busy={busy} p={p} />
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Actions({ i, busy, p }: { i: Item; busy: RowBusy | undefined; p: BillingBodyProps }) {
  const t = useT();
  const n = i.jobNumber;
  const off = busy !== undefined;
  const markFixed = off ? (
    <button type="button" className="btn sm dis" aria-disabled="true" data-ctl="CTL-OFC-10-09">
      {t('billing.act.markFixed')}
    </button>
  ) : (
    <button type="button" className="btn sm" data-ctl="CTL-OFC-10-09" onClick={() => p.onMarkFixed?.(n)}>
      {t('billing.act.markFixed')}
    </button>
  );
  if (i.state === 'waiting_person') {
    return (
      <>
        {busy === 'resend' ? (
          <Busy label={t('billing.act.sendAgain.busy')} size="sm" ctl="CTL-OFC-10-05" />
        ) : (
          <button type="button" className={`btn sm${off ? ' dis' : ''}`} aria-disabled={off || undefined} data-ctl="CTL-OFC-10-05" onClick={() => !off && p.onSendAgain?.(n)}>
            {t('billing.act.sendAgain')}
          </button>
        )}
        <button type="button" className={`btn sm primary${off ? ' dis' : ''}`} aria-disabled={off || undefined} data-ctl="CTL-OFC-10-06" onClick={() => !off && p.onCorrect?.(n)}>
          {t('billing.act.correct')}
        </button>
        {markFixed}
      </>
    );
  }
  return (
    <>
      {busy === 'retry' ? (
        <Busy label={t('billing.act.retryNow.busy')} size="sm" ctl="CTL-OFC-10-07" />
      ) : (
        <button type="button" className="btn sm" data-ctl="CTL-OFC-10-07" onClick={() => p.onRetryNow?.(n)}>
          <Icon name="refresh" />
          {t('billing.act.retryNow')}
        </button>
      )}
      {markFixed}
    </>
  );
}

function FixedCard({ left, arrived }: { left: Left[]; arrived: number | null }) {
  const t = useT();
  const lang = t.lang;
  // The cells' words are the export's too (FR-BILL-12; F-591): 1 composition, @bw/i18n billing-rows. A Mark fixed row says the
  // reason the person typed and the person (FR-BILL-11).
  const how = (l: Left): ReactNode => (
    <>
      <span className={`chip ${l.how === 'marked_fixed' ? 'done' : 'site'}`}>
        <span className="dot" />
        {leftChipText(l, t)}
      </span>{' '}
      {leftHowText(l, t)}
    </>
  );
  const why = (l: Left): string => leftReasonText(l, t);
  return (
    <section className="card fixed" data-ctl="CTL-OFC-10-10">
      <div className="card-h">
        <h3>{t('billing.fixed.title')}</h3>
        <span data-ctl="CTL-OFC-10-14">{t('billing.fixed.count', { count: left.length })}</span>
      </div>
      {left.length === 0 ? (
        <p className="r1-note">{t('billing.fixed.none')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('billing.col.job')}</th>
              <th>{t('billing.fixed.col.reason')}</th>
              <th>{t('billing.fixed.col.how')}</th>
              <th>{t('billing.fixed.col.when')}</th>
            </tr>
          </thead>
          <tbody>
            {left.map((l) => (
              <tr key={l.jobNumber} className={arrived === l.jobNumber ? 'live' : undefined}>
                <td className="jn">{l.jobNumber}</td>
                <td>{why(l)}</td>
                <td>{how(l)}</td>
                <td className="num">{dayTimeText(l.at, lang, t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
