// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-16 Admin: system health (frame mockups/pages/admin-health.html, DK-102; FR-HLTH-1 to FR-HLTH-4, FR-TEXT-16, FR-TEXT-12, FR-BILL-2,
// NFR-07, NFR-10). The view takes the page's data and its interaction state, so the preview routes draw each state the frame shows with
// the frame's data and the screen (HealthScreen.tsx) feeds it the live ones. Markup and classes are the frame's, so its page-local sheet
// (styles/page-admin-health.css, a byte copy) styles it.
import '../shell/css/office.ts';
import '../../styles/page-admin-health.css';
import '../../styles/app/health.css';
import type { MessageKey } from '@bw/i18n';
import { Fragment, type KeyboardEvent, type ReactNode } from 'react';
import { alertText, alertTitle, alertTypeName } from '../shell/alert-words.ts';
import { AdminFrame } from '../shell/Frames.tsx';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { ErrorPanel } from '../shell/Panels.tsx';
import { ToastView } from '../shell/Announcer.tsx';
import type { FrameData } from '../shell/frame-data.ts';
import type { Me, OfficeTopBarProps } from '../shell/OfficeTopBar.tsx';
import { waitingReasonText } from '@bw/i18n';
import {
  alertWhen, canApply, demoClock, demoClockZone, heldClock, locationWords, nightLabel, overallText, realWhen, seconds, simInForce, sizeText, sparkPoints, zoneWord, N_MAX, SIM_MODES,
  type Health, type Picked, type SimMode,
} from './model.ts';

export type HealthState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: Health };

export interface HealthUi {
  checking: boolean;
  applying: boolean;
  pick: Picked;
  /** The customer field's text and the matches under it (CTL-OFC-16-03). */
  customerText: string;
  matches: { id: string; name: string }[];
  /** The field message shown by a control (CTL-OFC-16-04), else null. */
  fieldMsg: 'n' | 'customer' | null;
  delayAsTable: boolean;
  show: 'all' | 'emailed';
  toast: string | null;
  /** A refused or failed write's message by its control. */
  message: { where: 'check' | 'apply' | 'switch'; text: string } | null;
}

export const IDLE_UI: HealthUi = {
  checking: false, applying: false, pick: { mode: 'up', customerId: null, n: '' }, customerText: '', matches: [], fieldMsg: null, delayAsTable: false,
  show: 'all', toast: null, message: null,
};

export interface HealthHandlers {
  onCheck?: () => void;
  onPickMode?: (mode: SimMode) => void;
  onCustomerText?: (text: string) => void;
  onPickCustomer?: (c: { id: string; name: string }) => void;
  onN?: (n: string) => void;
  onApply?: () => void;
  onTable?: () => void;
  onShow?: (show: 'all' | 'emailed') => void;
  onSwitch?: (type: string, which: 'bell' | 'managersEmail', value: boolean) => void;
  /** Open this manager's copy of an alert's email (F-660). */
  onEmail?: (alertId: string) => void;
  /** Dismiss an alert (API-176, CTL-OFC-16-28). */
  onDismiss?: (alertId: string) => void;
  onRetry?: () => void;
}

const chipOf = (cls: string, text: ReactNode) => (
  <span className={`chip ${cls}`}>
    <span className="dot" />
    {text}
  </span>
);

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="bw-health-skel" role="status">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="r1-skel" />
      ))}
    </div>
  );
}

/** The delay chart: one point per minute, the goal line at 5 s (CTL-OFC-16-16); the table is its screen-reader twin (CTL-OFC-16-17). */
function Spark({ d, asOf }: { d: Health['delay']; asOf: string }) {
  const t = useT();
  const pts = sparkPoints(d.samples, asOf);
  const W = 350, H = 92, top = 8, bot = 16, max = Math.max(6, Math.ceil((d.slowestMs ?? 0) / 1000) + 1);
  const x = (ago: number) => 30 + ((W - 34) * (60 - ago)) / 60;
  const y = (v: number) => top + (H - top - bot) * (1 - v / max);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ago).toFixed(1)} ${y(p.ms / 1000).toFixed(1)}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('health.delay.chart')} data-ctl="CTL-OFC-16-16">
      {[0, 5].map((v) => (
        <text key={v} x="24" y={y(v) + 4} textAnchor="end" fontSize="11" fill="#4b5563">{`${v} s`}</text>
      ))}
      <line x1="30" x2={W} y1={y(0)} y2={y(0)} stroke="#d1d5db" />
      <line x1="30" x2={W} y1={y(5)} y2={y(5)} stroke="#111827" strokeWidth="1.2" strokeDasharray="4 3" />
      <text x={W - 2} y={y(5) - 4} textAnchor="end" fontSize="11" fontWeight="650" fill="#111827">{t('health.delay.goal')}</text>
      {pts.length > 0 ? (
        <>
          <path d={`M${x(pts[0]!.ago)} ${y(0)} ${pts.map((p) => `L${x(p.ago).toFixed(1)} ${y(p.ms / 1000).toFixed(1)}`).join(' ')} L${x(pts[pts.length - 1]!.ago)} ${y(0)} Z`} fill="rgba(18,115,139,.12)" />
          <path d={line} fill="none" stroke="#12738b" strokeWidth="1.8" strokeLinejoin="round" />
        </>
      ) : null}
    </svg>
  );
}

function Switch({ on, label, ctl, onChange, disabled }: { on: boolean; label: string; ctl: string; onChange?: (v: boolean) => void; disabled?: boolean }) {
  const key = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onChange?.(!on);
    }
  };
  return (
    <span className={on ? 'sw on' : 'sw'} role="switch" aria-checked={on} aria-label={label} aria-disabled={disabled || undefined} tabIndex={0} data-ctl={ctl} onClick={() => onChange?.(!on)} onKeyDown={key} />
  );
}

export function HealthBody({ state, ui, on }: { state: HealthState; ui: HealthUi; on: HealthHandlers }) {
  const t = useT();
  const head = (d: Health | null) => (
    <div className="ah">
      <div>
        <h1>{t('health.title')}</h1>
        <p>{t('health.sub')}</p>
      </div>
      <div className="acts">
        {d ? (
          <span data-ctl="CTL-OFC-16-11">
            <span className="chk">{d.lastCheck ? t('health.lastCheck', { time: demoClock(d.lastCheck, t.lang) }) : t('health.lastCheck.never')}</span>{' '}
            {chipOf('site', overallText(d.overall, t))}
          </span>
        ) : null}
        <button type="button" className={ui.checking ? 'btn busy primary' : 'btn'} data-ctl="CTL-OFC-16-12" aria-busy={ui.checking || undefined} aria-disabled={ui.checking || undefined} onClick={ui.checking ? undefined : on.onCheck}>
          {ui.checking ? <span className="r1-spin" /> : <Icon name="refresh" />}
          {ui.checking ? t('health.checking') : t('health.checkNow')}
        </button>
        {ui.message?.where === 'check' ? (
          <span className="r1-fmsg" role="alert">
            {ui.message.text}
          </span>
        ) : null}
      </div>
    </div>
  );

  if (state.kind !== 'ready') {
    return (
      <div className="main">
        {head(null)}
        <div className="body">
          {state.kind === 'loading' ? (
            <Skeleton rows={6} />
          ) : (
            <ErrorPanel title={t('health.error.title')} hint={t('health.error.hint')} onRetry={() => on.onRetry?.()} />
          )}
        </div>
      </div>
    );
  }
  const d = state.data;
  const sim = simInForce(d.textSimulator, t);
  const picked = ui.pick;
  const ok = (r: string) => chipOf(r === 'passed' ? 'site' : 'late', r === 'passed' ? t('health.restore.passed') : t('health.restore.failed'));
  const shownAlerts = d.alerts.filter((a) => ui.show === 'all' || a.emailed);
  const billingChip = d.billing.mode === null ? chipOf('late', t('health.billing.unknown')) : d.billing.mode === 'up' ? chipOf('site', t('health.billing.up')) : chipOf('late', t('health.billing.down'));
  const delayOver = d.delay.typicalMs !== null && d.delay.typicalMs > d.delay.goalMs;
  const textsOk = d.textSimulator.mode === 'up' && d.outbox.notSentToday === 0;

  return (
    <div className="main">
      {head(d)}
      <div className="body">
        <div className="cards">
          <section className="panel hc">
            <div className="ph">
              <Icon name="cloud" />
              <h3>{t('health.backup.title')}</h3>
              {d.backup ? chipOf(d.backup.result === 'passed' ? 'site' : 'late', d.backup.result === 'passed' ? t('health.backup.ok') : t('health.backup.failed')) : null}
            </div>
            <div className="in" data-ctl="CTL-OFC-16-13">
              {!d.backupSetUp ? (
                <p className="r1-note bw-note0">{t('health.backup.none')}</p>
              ) : !d.backup ? (
                <p className="r1-note bw-note0">{t('health.backup.noRecord')}</p>
              ) : (
                <>
                  <span className="big">{t('health.backup.last', { when: realWhen(d.backup.at, t.lang, t, false) })}</span>
                  <span className="sub">
                    {t('health.backup.finished', {
                      time: d.backup.finishedAt ? demoClock(d.backup.finishedAt, t.lang) : '-',
                      size: d.backup.sizeBytes === null ? '-' : sizeText(d.backup.sizeBytes),
                      nights: d.backup.nightsKept ?? 0,
                    })}
                    <br />
                    {t('health.backup.copies', { where: d.backup.copiesAt })}
                  </span>
                  <div className="nights" data-ctl="CTL-OFC-16-24">
                    {d.backups.map((n) => (
                      <div key={n.night} className={n.result === 'failed' ? 'bad' : n.result === null ? 'none' : undefined}>
                        <b>{nightLabel(n.night, t)}</b>
                        {n.result === null ? t('health.night.none') : n.result === 'passed' ? t('health.night.ok') : t('health.night.failed')}
                      </div>
                    ))}
                  </div>
                  <div className="foot">
                    <Icon name="clock" className="bw-ic15" />
                    {t('health.backup.next', { when: realWhen(d.backup.nextAt, t.lang, t) })}
                  </div>
                </>
              )}
            </div>
          </section>

          <section className="panel hc">
            <div className="ph">
              <Icon name="refresh" />
              <h3>{t('health.restore.title')}</h3>
              {d.restoreTests[0] ? ok(d.restoreTests[0].result) : null}
            </div>
            <div className="in" data-ctl="CTL-OFC-16-14">
              {d.restoreTests.length === 0 ? (
                <p className="r1-note bw-note0">{t('health.restore.none')}</p>
              ) : (
                <>
                  <span className="big">{t('health.restore.last', { when: realWhen(d.restoreTests[0]!.at, t.lang, t, false) })}</span>
                  <span className="sub">
                    {d.restoreTests[0]!.result === 'passed' ? `${t('health.restore.checked')} ` : ''}
                    {d.restoreTests[0]!.minutes !== null ? <span data-ctl="CTL-OFC-16-25">{`${t('health.restore.minutes', { count: d.restoreTests[0]!.minutes })}.`}</span> : null}
                  </span>
                  <div className="hist">
                    {d.restoreTests.slice(1).map((r) => (
                      <div key={r.at}>
                        {realWhen(r.at, t.lang, t)}
                        {r.first ? (
                          <>
                            {' - '}
                            <span data-ctl="CTL-OFC-16-25">{t('health.restore.first')}</span>
                          </>
                        ) : null}
                        {ok(r.result)}
                      </div>
                    ))}
                  </div>
                  {d.restoreNextAt ? (
                    <div className="foot" data-ctl="CTL-OFC-16-25">
                      <Icon name="clock" className="bw-ic15" />
                      {t('health.restore.next', { when: realWhen(d.restoreNextAt, t.lang, t) })}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </section>

          <section className="panel hc">
            <div className="ph">
              <Icon name="sheet" />
              <h3>{t('health.billing.title')}</h3>
              {billingChip}
            </div>
            <div className="in" data-ctl="CTL-OFC-16-08">
              <span className="big" data-ctl="CTL-OFC-16-26">{t('health.billing.done', { inBilling: d.billing.inBillingToday, finished: d.billing.finishedToday })}</span>
              <span className="sub">
                {d.billing.lastSentAt
                  ? t('health.billing.mode', { mode: d.billing.mode === null ? t('health.billing.unknown') : t(`pbs.mode.${d.billing.mode}` as MessageKey), time: demoClock(d.billing.lastSentAt, t.lang) })
                  : t('health.billing.modeNone', { mode: d.billing.mode === null ? t('health.billing.unknown') : t(`pbs.mode.${d.billing.mode}` as MessageKey) })}{' '}
                <a className="r1-link" href="/billing-system" data-ctl="CTL-OFC-16-10">{t('health.billing.openSystem')}</a>
              </span>
              {d.billing.listed.length > 0 ? (
                <div className="warn" data-ctl="CTL-OFC-16-26">
                  <b>{t('health.billing.listed', { count: d.billing.listed.length })}</b>{' '}
                  {d.billing.listed.map((j) => `${t('health.billing.listedRow', { job: j.jobNumber, customer: j.customer, service: t(`service.${j.service}.text` as MessageKey), reason: waitingReasonText(j, t) })} `).join('')}
                  {t('health.billing.never')}
                </div>
              ) : null}
              <div className="foot">
                {t('health.billing.notIn', { count: d.billing.waiting })}
                <a className="btn sm" href="/office/billing" data-ctl="CTL-OFC-16-09">{t('health.billing.openList')}</a>
              </div>
            </div>
          </section>

          <section className="panel hc">
            <div className="ph">
              <Icon name="message" />
              <h3>{t('health.texts.title')}</h3>
              {textsOk ? chipOf('site', t('health.texts.working')) : chipOf('late', t('health.texts.attention'))}
            </div>
            <div className="in">
              <span className="sub" data-ctl="CTL-OFC-16-06">
                {t('health.texts.counts', { today: d.outbox.today, delivered: d.outbox.delivered, held: d.outbox.held, retrying: d.outbox.retrying, notSent: d.outbox.notSentToday, callList: d.outbox.callList })}
              </span>
              <div className="rq" data-ctl="CTL-OFC-16-27">
                <h5>{t('health.texts.retryQueue')}</h5>
                {d.outbox.retryingTexts.length === 0 ? <small>{t('health.texts.none')}</small> : null}
                {d.outbox.retryingTexts.map((r) => (
                  <Fragment key={r.textId}>
                    <div>
                      <b>{r.customer}</b> - {t(`health.kind.${r.kind}` as MessageKey)}
                      {chipOf('late', t('health.texts.retryChip'))}
                    </div>
                    <small>{t('health.texts.attempt', { n: r.tries, time: r.nextTryAt ? demoClock(r.nextTryAt, t.lang) : '-' })}</small>
                  </Fragment>
                ))}
                <h5>{t('health.texts.heldQueue')}</h5>
                {d.outbox.heldTexts.length === 0 ? <small>{t('health.texts.none')}</small> : null}
                {d.outbox.heldTexts.map((h) => (
                  <Fragment key={h.textId}>
                    <div>
                      <b>{h.customer}</b> - {t(`health.kind.${h.kind}` as MessageKey)}
                      <span className="chip held">{t('health.texts.heldChip', { time: heldClock(h.heldUntil, t.lang) })}</span>
                    </div>
                    <small>{t('health.texts.heldLine', { theirs: heldClock(h.heldUntil, t.lang), zone: zoneWord(h.heldUntil.slice(h.heldUntil.indexOf('[') + 1, -1), t), ours: demoClockZone(h.heldUntilBranch, t.lang) })}</small>
                  </Fragment>
                ))}
              </div>
              <div className="simc">
                <div className="cur" data-ctl="CTL-OFC-16-05">
                  {t('health.sim.inForce')} <b>{sim.mode}</b>
                  {t('health.sim.setBy', { who: sim.by })}
                </div>
                <div className="rads2" role="radiogroup" aria-label={t('health.sim.group')} data-ctl="CTL-OFC-16-01">
                  {SIM_MODES.map((m) => (
                    <span
                      key={m}
                      className={picked.mode === m ? 'on' : undefined}
                      role="radio"
                      aria-checked={picked.mode === m}
                      tabIndex={picked.mode === m ? 0 : -1}
                      onClick={() => on.onPickMode?.(m)}
                      onKeyDown={(e) => {
                        if (e.key === ' ' || e.key === 'Enter') {
                          e.preventDefault();
                          on.onPickMode?.(m);
                        } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                          e.preventDefault();
                          const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : SIM_MODES.length - 1;
                          const next = SIM_MODES[(SIM_MODES.indexOf(m) + step) % SIM_MODES.length]!;
                          on.onPickMode?.(next);
                          (e.currentTarget.parentElement?.querySelectorAll('[role="radio"]')[SIM_MODES.indexOf(next)] as HTMLElement | undefined)?.focus();
                        }
                      }}
                    >
                      <i />
                      {t(`health.sim.mode.${m}` as MessageKey)}
                    </span>
                  ))}
                </div>
                {picked.mode === 'fail_customer' ? (
                  <div className="row bw-simfield">
                    <span className="r1-field" data-ctl="CTL-OFC-16-03">
                      <label htmlFor="bw-sim-customer">{t('health.sim.customer')}</label>
                      <input id="bw-sim-customer" className="r1-input" type="search" autoComplete="off" placeholder={t('health.sim.customerHint')} value={ui.customerText} aria-invalid={ui.fieldMsg === 'customer' || undefined} onChange={(e) => on.onCustomerText?.(e.target.value)} />
                    </span>
                    {ui.matches.length > 0 ? (
                      <span className="bw-matches" role="listbox">
                        {ui.matches.map((m) => (
                          <button key={m.id} type="button" role="option" aria-selected={picked.customerId === m.id} className="bw-btn-reset" onClick={() => on.onPickCustomer?.(m)}>
                            {m.name}
                          </button>
                        ))}
                      </span>
                    ) : null}
                    {ui.fieldMsg === 'customer' ? <span className="r1-fmsg" role="alert">{t('health.sim.pickCustomer')}</span> : null}
                  </div>
                ) : null}
                {picked.mode === 'fail_next_n' ? (
                  <div className="row bw-simfield">
                    <span className="r1-field" data-ctl="CTL-OFC-16-04">
                      <label htmlFor="bw-sim-n">{t('health.sim.n')}</label>
                      <input id="bw-sim-n" className="r1-input bw-n80" inputMode="numeric" min={1} max={N_MAX} value={picked.n} aria-invalid={ui.fieldMsg === 'n' || undefined} onChange={(e) => on.onN?.(e.target.value)} />
                    </span>
                    {ui.fieldMsg === 'n' ? <span className="r1-fmsg" role="alert">{t('health.sim.nRange')}</span> : null}
                  </div>
                ) : null}
              </div>
              <div className="foot">
                <button
                  type="button"
                  className={ui.applying ? 'btn busy primary' : `btn sm primary${canApply(picked, d.textSimulator) ? '' : ' dis'}`}
                  aria-disabled={!canApply(picked, d.textSimulator) || ui.applying || undefined}
                  aria-busy={ui.applying || undefined}
                  data-ctl="CTL-OFC-16-02"
                  onClick={() => (canApply(picked, d.textSimulator) && !ui.applying ? on.onApply?.() : undefined)}
                >
                  {ui.applying ? <span className="r1-spin" /> : null}
                  {ui.applying ? t('health.sim.applying') : t('health.sim.apply')}
                </button>
                {ui.message?.where === 'apply' ? <span className="r1-fmsg" role="alert">{ui.message.text}</span> : null}
                <a className="r1-link bw-lm" href="/office/messages" data-ctl="CTL-OFC-16-07">{t('health.texts.openMessages')}</a>
              </div>
            </div>
          </section>

          <section className="panel hc">
            <div className="ph">
              <Icon name="globe" />
              <h3>{t('health.loc.title')}</h3>
              <span className="chip us">
                <span className="dot" />
                {t('health.loc.chip')}
              </span>
            </div>
            <div className="in" data-ctl="CTL-OFC-16-15">
              <div className="loc">
                <div><span>{t('health.loc.app')}</span><b>{locationWords(t, d.locations.app)}</b></div>
                <div><span>{t('health.loc.backups')}</span><b>{locationWords(t, d.locations.backups)}</b></div>
                <div><span>{t('health.loc.texts')}</span><b>{locationWords(t, d.locations.texts)}</b></div>
                <div><span>{t('health.loc.maps')}</span><b>{locationWords(t, d.locations.maps)}</b></div>
              </div>
              <div className="foot">
                <Icon name="lock" className="bw-ic15" />
                {t('health.loc.statement')}
              </div>
            </div>
          </section>

          <section className="panel hc">
            <div className="ph">
              <Icon name="gauge" />
              <h3>{t('health.delay.title')}</h3>
              {d.delay.typicalMs === null ? null : chipOf(delayOver ? 'late' : 'site', t(delayOver ? 'health.delay.over' : 'health.delay.under'))}
            </div>
            <div className="in">
              {d.delay.typicalMs === null ? (
                <p className="r1-note bw-note0" data-ctl="CTL-OFC-16-16">{t('health.delay.none')}</p>
              ) : (
                <>
                  <span className="big">
                    {t('health.delay.typical', { seconds: seconds(d.delay.typicalMs) })}{' '}
                    <span className="sub bw-sub500">{t('health.delay.slowest', { seconds: seconds(d.delay.slowestMs ?? d.delay.typicalMs) })}</span>
                  </span>
                  {ui.delayAsTable ? (
                    <table className="q bw-delay-table" data-ctl="CTL-OFC-16-16">
                      <thead>
                        <tr><th>{t('health.delay.colTime')}</th><th>{t('health.delay.colDelay')}</th></tr>
                      </thead>
                      <tbody>
                        {d.delay.samples.slice(-12).map((s) => (
                          <tr key={`${s.at}${s.ms}`}><td>{demoClock(s.at, t.lang)}</td><td>{`${seconds(s.ms)} s`}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <Spark d={d.delay} asOf={d.asOf} />
                  )}
                  <div className="foot bw-foot5">
                    {t('health.delay.foot')}
                    <button type="button" className="tbt bw-btn-reset" aria-pressed={ui.delayAsTable} data-ctl="CTL-OFC-16-17" onClick={on.onTable}>
                      {ui.delayAsTable ? t('health.delay.showChart') : t('health.delay.showTable')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>

        <section className="panel alerts">
          <div className="ph bw-ph10">
            <h3>{t('health.alerts.title')}</h3>
            <span className="shw" data-ctl="CTL-OFC-16-19">
              {t('health.alerts.show')} <b>{t(ui.show === 'all' ? 'health.alerts.showAll' : 'health.alerts.showEmailed')}</b>
              <Icon name="chevDown" />
              <select className="bw-shw-select" aria-label={t('health.alerts.show')} value={ui.show} onChange={(e) => on.onShow?.(e.target.value as 'all' | 'emailed')}>
                <option value="all">{t('health.alerts.showAll')}</option>
                <option value="emailed">{t('health.alerts.showEmailed')}</option>
              </select>
            </span>
          </div>
          <div id="alerts" data-ctl="CTL-OFC-16-18">
            {shownAlerts.length === 0 ? <p className="r1-note bw-alerts-none">{t('health.alerts.none')}</p> : null}
            {shownAlerts.map((a) => (
              <div key={a.id} className="al">
                <b>{alertTitle(t, a)}</b>
                <span className={`chip ${a.state === 'open' ? 'open' : a.state === 'resolved' ? 'res' : 'inf'}`}>
                  <span className="dot" />
                  {t(`health.alerts.${a.state}` as MessageKey)}
                </span>
                <p>{alertText(t, a)}</p>
                <time>{alertWhen(a.at, d.asOf, t.lang, t)}</time>
                {a.emailWaiting ? <a className="r1-link sm" href="#" role="button" data-ctl="CTL-OFC-16-23" onClick={(ev) => (ev.preventDefault(), on.onEmail?.(a.id))}>{t('health.alerts.email')}</a> : null}
                {a.emailOpened ? <span className="used" data-ctl="CTL-OFC-16-23">{t('health.alerts.emailUsed')}</span> : null}
                {a.dismissible && a.state === 'open' ? <span><button type="button" className="btn sm" data-ctl="CTL-OFC-16-28" onClick={() => on.onDismiss?.(a.id)}>{t('health.alerts.dismiss')}</button></span> : null}
              </div>
            ))}
          </div>
          <div className="ast">
            <h4>{t('health.alerts.settings')}</h4>
            <table data-ctl="CTL-OFC-16-20">
              <thead>
                <tr><th>{t('health.alerts.colAlert')}</th><th>{t('health.alerts.colBell')}</th><th>{t('health.alerts.colEmail')}</th></tr>
              </thead>
              <tbody>
                {d.alertSettings.map((s) => (
                  <tr key={s.type}>
                    <td>{alertTypeName(t, s.type)}</td>
                    <td><Switch on={s.bell} label={t('health.alerts.switchBell', { type: alertTypeName(t, s.type) })} ctl="CTL-OFC-16-21" onChange={(v) => on.onSwitch?.(s.type, 'bell', v)} /></td>
                    <td><Switch on={s.managersEmail} label={t('health.alerts.switchEmail', { type: alertTypeName(t, s.type) })} ctl="CTL-OFC-16-22" onChange={(v) => on.onSwitch?.(s.type, 'managersEmail', v)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ui.message?.where === 'switch' ? <p className="r1-fmsg" role="alert">{ui.message.text}</p> : null}
          </div>
        </section>
      </div>
      {ui.toast ? <ToastView text={ui.toast} /> : null}
    </div>
  );
}

/** The admin frame around the body: demo strip, top bar, the admin menu, the footer. `frame` is a preview's fixed chrome. */
export function HealthView({ state, ui, on, frame }: { state: HealthState; ui: HealthUi; on: HealthHandlers; frame?: Omit<FrameData, 'screen' | 'children'> & { me?: Me; bar?: Omit<OfficeTopBarProps, 'me'> } }) {
  return (
    <AdminFrame screen="SCR-OFC-16" currentPath="/office/admin/health" {...(frame ?? {})}>
      <HealthBody state={state} ui={ui} on={on} />
    </AdminFrame>
  );
}
