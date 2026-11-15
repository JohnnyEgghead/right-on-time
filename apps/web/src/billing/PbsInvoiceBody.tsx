// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-PBS-02 Pretend billing: invoice, its body (frame r1-pbs-a-invoice, option A, DK-64, DK-65): the meta panel and the lines billing
// received (CTL-PBS-02-01, -02): 1 line per part with 1 name each (D5a-4), the SD-20 total, Work done, and the note that no signature is
// sent. A job marked fixed shows Entered by hand with its reason, who and when in place of the lines.
import '../../styles/app/billing.css';
import type { pbsInvoice, z } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { ErrorPanel } from '../shell/Panels.tsx';
import { fullText, money, shortName } from './format.ts';

export type PbsInvoiceView = z.infer<typeof pbsInvoice.response>;
type Line = PbsInvoiceView['lines'][number];

export interface PbsInvoiceBodyProps {
  jobNumber: number;
  invoice: 'loading' | 'error' | PbsInvoiceView;
  onReload: () => Promise<unknown> | unknown;
}

const GROUPS: { kind: Line['kind']; key: MessageKey }[] = [
  { kind: 'service', key: 'pbs.group.service' },
  { kind: 'part', key: 'pbs.group.parts' },
  { kind: 'labor', key: 'pbs.group.labor' },
];

const num = (n: number | null): string => (n === null ? '' : String(n));

export function PbsInvoiceBody({ jobNumber, invoice, onReload }: PbsInvoiceBodyProps) {
  const t = useT();
  const lang = t.lang;
  const view = typeof invoice === 'string' ? null : invoice;
  return (
    <>
      <div className="ah">
        <a className="back" data-ctl="CTL-PBS-02-01" href="/billing-system">
          <Icon name="back" />
          {t('pbs.invoice.back')}
        </a>
        <div className="t1">
          <h1>{t('pbs.invoice.title', { job: jobNumber })}</h1>
          <p>{t('pbs.invoice.sub')}</p>
        </div>
        <span className="chip test pbtag">{t('pbs.tag')}</span>
      </div>
      <div className="grid2 invg">
        <section className="panel pad">
          {view ? (
            <dl className="meta">
              <dt>{t('pbs.col.job')}</dt>
              <dd className="n">{view.jobNumber}</dd>
              <dt>{t('billing.col.customer')}</dt>
              <dd translate="no">{view.customer}</dd>
              <dt>{t('pbs.meta.technician')}</dt>
              <dd translate="no">{view.technician ?? ''}</dd>
              <dt>{t('billing.col.doneAt')}</dt>
              <dd>{fullText(view.doneAt, lang, t)}</dd>
              <dt>{t('pbs.col.received')}</dt>
              <dd>{fullText(view.receivedAt, lang, t)}</dd>
              <dt>{t('pbs.meta.calls')}</dt>
              <dd>{t('pbs.calls', { calls: view.callsReceived })}</dd>
            </dl>
          ) : (
            <Skeleton />
          )}
        </section>
        <section className="panel pad">
          {invoice === 'error' ? (
            <ErrorPanel title={t('pbs.invoice.error')} hint={t('shell.error.checkConnection')} onRetry={onReload} />
          ) : view === null ? (
            <Skeleton />
          ) : view.enteredByHand ? (
            <div className="hand" data-ctl="CTL-PBS-02-02">
              <span className="chip warn">
                <span className="dot" />
                {t('pbs.how.entered_by_hand')}
              </span>
              <p>
                <b>{t('pbs.hand.reason')}</b> {view.enteredByHand.reason}
              </p>
              <p className="by">{`${view.enteredByHand.by ? `${shortName(view.enteredByHand.by)}, ` : ''}${fullText(view.enteredByHand.at, lang, t)}`}</p>
            </div>
          ) : (
            <Lines view={view} />
          )}
        </section>
      </div>
    </>
  );
}

const Skeleton = () => (
  <>
    <span className="r1-skel bw-w-40" />
    <span className="r1-skel" />
    <span className="r1-skel" />
    <span className="r1-skel" />
  </>
);

/**
 * A line's words in the page's language: the service, labor and discount lines from the facts they were composed from (API-66 `words`;
 * F-593, as the Spanish frame says them); a part name, a work-done text, or a label the link did not compose, as billing received it.
 */
function labelOf(l: Line, t: ReturnType<typeof useT>): string {
  const w = l.words;
  if (w === null) return l.label;
  if ('service' in w) return t(`pbs.service.${w.service}` as MessageKey);
  if ('ratePercent' in w) return t('pbs.line.discount', { rate: w.ratePercent });
  const h = Math.floor(w.laborMinutes / 60);
  const m = w.laborMinutes % 60;
  return h === 0 ? t('pbs.line.labor.m', { m }) : m === 0 ? t('pbs.line.labor.h', { h }) : t('pbs.line.labor.hm', { h, m });
}

function Lines({ view }: { view: PbsInvoiceView }) {
  const t = useT();
  const discounts = view.lines.filter((l) => l.kind === 'discount');
  const work = view.lines.filter((l) => l.kind === 'work_done');
  return (
    <>
      <table className="t lines" data-ctl="CTL-PBS-02-02">
        <thead>
          <tr>
            <th>{t('pbs.line.line')}</th>
            <th>{t('pbs.line.code')}</th>
            <th className="r">{t('pbs.line.quantity')}</th>
            <th className="r">{t('pbs.line.list')}</th>
            <th className="r">{t('pbs.line.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {GROUPS.flatMap((g) => {
            const rows = view.lines.filter((l) => l.kind === g.kind);
            // CTL-PBS-02-02: a job with no parts shows the Parts group with a No parts used line at $0.00 (F-598).
            if (rows.length === 0 && !(g.kind === 'part' && view.noPartsUsed)) return [];
            return [
              <tr key={`g-${g.kind}`} className="grp">
                <td colSpan={5}>{t(g.key)}</td>
              </tr>,
              ...(rows.length === 0
                ? [
                    <tr key="no-parts">
                      <td colSpan={4}>{t('pbs.line.noParts')}</td>
                      <td className="r">{money(0)}</td>
                    </tr>,
                  ]
                : []),
              ...rows.map((l, i) => (
                <tr key={`${g.kind}-${i}`}>
                  <td>{g.kind === 'service' ? <b>{labelOf(l, t)}</b> : labelOf(l, t)}</td>
                  <td className={l.code ? 'n' : undefined} translate={l.code ? 'no' : undefined}>
                    {l.code ?? ''}
                  </td>
                  <td className="r">{num(l.quantity)}</td>
                  <td className="r">{l.unitCents === null ? '' : money(l.unitCents)}</td>
                  <td className="r">{l.amountCents === null ? '' : money(l.amountCents)}</td>
                </tr>
              )),
            ];
          })}
          {discounts.map((l, i) => (
            <tr key={`d-${i}`} className="disc">
              <td>{labelOf(l, t)}</td>
              <td />
              <td />
              <td className="r">{l.words && 'ratePercent' in l.words ? `${l.words.ratePercent}%` : (/(\d+)%/.exec(l.label)?.[0] ?? '')}</td>
              <td className="r">{l.amountCents === null ? '' : money(l.amountCents)}</td>
            </tr>
          ))}
          <tr className="tot">
            <td colSpan={4}>{t('pbs.total')}</td>
            <td className="r">{money(view.totalCents)}</td>
          </tr>
        </tbody>
      </table>
      {work.length > 0 ? (
        <div className="work">
          <h4>{t('pbs.work')}</h4>
          <ul>
            {work.map((l, i) => (
              <li key={i}>{l.label}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="nosign">{t('pbs.nosign')}</p>
    </>
  );
}
