// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-PBS-01 Pretend billing: invoices and mode, its body (frame r1-pbs-a-list, option A, DK-64, DK-65): the Mode panel (CTL-PBS-01-02
// to -05) and the Invoices received table (CTL-PBS-01-06 to -08). It is a stand-in, labeled so (OA-77, FR-BILL-4, FR-BILL-5). It draws
// what it is given; the live screen and the preview states both pass data.
import '../../styles/app/billing.css';
import type { pbsInvoices, pbsMode, z } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { ErrorPanel } from '../shell/Panels.tsx';
import { clockText, fullText, money } from './format.ts';
import { Spinner } from './BillingBody.tsx';

export type PbsInvoices = z.infer<typeof pbsInvoices.response>;
export type PbsModeView = z.infer<typeof pbsMode.response>;
const MODES = ['up', 'not_answering', 'down', 'reject_next_n'] as const;
export type Mode = (typeof MODES)[number];

export interface PbsListBodyProps {
  invoices: 'loading' | 'error' | PbsInvoices;
  mode: PbsModeView | null;
  /** The pick in the radios, and N as typed. */
  pick: Mode;
  nText: string;
  nBad?: boolean;
  applying?: boolean;
  message?: string | null;
  moreBusy?: boolean;
  onPick: (m: Mode) => void;
  onN: (text: string) => void;
  onApply: () => void;
  onMore: () => void;
  onReload: () => Promise<unknown> | unknown;
}

const chipOf = (m: Mode) => (m === 'up' ? 'chip ok' : 'chip bad');

export function PbsListBody(p: PbsListBodyProps) {
  const t = useT();
  const lang = t.lang;
  const inForce = p.mode;
  const same = inForce !== null && inForce.mode === p.pick && p.pick !== 'reject_next_n';
  const nValue = Number(p.nText);
  const nOk = p.pick !== 'reject_next_n' || (Number.isInteger(nValue) && nValue >= 1 && nValue <= 20 && p.nText.trim() !== '');
  const invoices = p.invoices;
  return (
    <>
      <div className="ah">
        <a className="back" data-ctl="CTL-PBS-01-01" href="/office/billing">
          <Icon name="back" />
          {t('pbs.back')}
        </a>
        <div className="t1">
          <h1>{t('pbs.title')}</h1>
          <p>{t('pbs.what')}</p>
        </div>
        <span className="chip test pbtag">{t('pbs.tag')}</span>
      </div>
      <div className="grid2">
        <section className="panel modep" data-ctl="CTL-PBS-01-02">
          <div className="ph">
            <h3>{t('pbs.mode.title')}</h3>
          </div>
          {inForce ? (
            <div className="cur" data-ctl="CTL-PBS-01-05">
              <span className="k">{t('pbs.cur.k')}</span>
              <span className={chipOf(inForce.mode)}>
                <span className="dot" />
                {t(`pbs.mode.${inForce.mode}` as MessageKey)}
              </span>
              <span className="s">{inForce.nLeft && inForce.nLeft > 0 ? t('pbs.cur.left', { n: inForce.nLeft }) : t('pbs.cur.none')}</span>
            </div>
          ) : (
            <div className="cur" data-ctl="CTL-PBS-01-05">
              <span className="s">{t('pbs.modeError')}</span>
            </div>
          )}
          <div className="radios" role="radiogroup">
            {MODES.map((m) => (
              <label key={m} className={`radio${p.pick === m ? ' sel' : ''}`}>
                <input type="radio" className="bw-vh" name="pbs-mode" value={m} checked={p.pick === m} disabled={p.applying} onChange={() => p.onPick(m)} />
                <span className="dotr" />
                <span className="rt">
                  <b>{t(`pbs.mode.${m}` as MessageKey)}</b>
                  <small>{t(`pbs.mode.${m}.desc` as MessageKey)}</small>
                  {m === 'reject_next_n' && p.pick === m ? (
                    <span className="nfield" data-ctl="CTL-PBS-01-04">
                      <label htmlFor="pbs-n">{t('pbs.n')}</label>
                      <input
                        id="pbs-n"
                        className={`r1-input small bw-field-input${p.nBad || !nOk ? ' bad' : ''}`}
                        inputMode="numeric"
                        value={p.nText}
                        disabled={p.applying}
                        aria-invalid={!nOk || undefined}
                        onChange={(e) => p.onN(e.target.value)}
                      />
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
          {!nOk ? (
            <div className="r1-fmsg" role="alert">
              <Icon name="alert" />
              {t('pbs.n.bad')}
            </div>
          ) : null}
          <div className="ap">
            {p.applying ? (
              <button type="button" className="btn primary lg busy" aria-busy="true" data-ctl="CTL-PBS-01-03">
                <Spinner />
                {t('pbs.applying')}
              </button>
            ) : (
              <button
                type="button"
                className={`btn primary lg${same || !nOk ? ' dis' : ''}`}
                aria-disabled={same || !nOk || undefined}
                data-ctl="CTL-PBS-01-03"
                onClick={() => !same && nOk && p.onApply()}
              >
                {t('pbs.apply')}
              </button>
            )}
            <p className="applyn">{same && inForce ? t('pbs.same', { mode: t(`pbs.mode.${inForce.mode}` as MessageKey) }) : p.message ?? t('pbs.applyNote')}</p>
          </div>
        </section>
        <section className="panel">
          <div className="ph">
            <h3>{t('pbs.inv.title')}</h3>
            <span className="s">{t('pbs.inv.sub')}</span>
          </div>
          {invoices === 'loading' ? (
            <div className="pad">
              <span className="r1-skel bw-w-40" />
              <span className="r1-skel" />
              <span className="r1-skel" />
              <span className="r1-skel" />
            </div>
          ) : invoices === 'error' ? (
            <ErrorPanel title={t('pbs.loadError.title')} hint={t('pbs.loadError.hint')} onRetry={p.onReload} />
          ) : invoices.invoices.length === 0 ? (
            <div className="emptyb">
              <Icon name="sheet" />
              <span>{t('pbs.empty')}</span>
            </div>
          ) : (
            <>
              <table className="t inv" data-ctl="CTL-PBS-01-06">
                <thead>
                  <tr>
                    <th>{t('pbs.col.job')}</th>
                    <th>{t('billing.col.customer')}</th>
                    <th>{t('billing.col.doneAt')}</th>
                    <th>{t('pbs.col.received')}</th>
                    <th>{t('pbs.col.how')}</th>
                    <th className="r">{t('pbs.col.total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.invoices.map((r) => (
                    <tr key={r.jobNumber}>
                      <td>
                        <a className="jl" data-ctl="CTL-PBS-01-07" href={`/billing-system/invoices/${r.jobNumber}`}>
                          {r.jobNumber}
                        </a>
                      </td>
                      <td translate="no">{r.customer}</td>
                      <td className="n">{fullText(r.doneAt, lang, t)}</td>
                      <td className="n">{clockText(r.receivedAt, lang)}</td>
                      <td>
                        <span className={r.how === 'received' ? 'chip ok' : 'chip warn'}>
                          <span className="dot" />
                          {t(`pbs.how.${r.how}` as MessageKey)}
                        </span>
                      </td>
                      <td className="r">
                        <b>{money(r.totalCents)}</b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="more">
                <span>{t('pbs.shown', { shown: invoices.invoices.length, total: invoices.total })}</span>
                {invoices.next ? (
                  p.moreBusy ? (
                    <button type="button" className="btn sm busy" aria-busy="true" data-ctl="CTL-PBS-01-08">
                      <Spinner dark />
                      {t('pbs.showMore')}
                    </button>
                  ) : (
                    <button type="button" className="btn sm" data-ctl="CTL-PBS-01-08" onClick={p.onMore}>
                      {t('pbs.showMore')}
                    </button>
                  )
                ) : null}
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
