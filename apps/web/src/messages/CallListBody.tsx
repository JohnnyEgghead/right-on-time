// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-09 Messages: call list, its body (frame mockups/pages/office-call-list.html, DK-94): the reminder calls for tomorrow with their
// outcome buttons (Mark confirmed, Reschedule, No answer, Change), the texts that could not be sent, the progress line, and beside them
// What to say in both languages, Tomorrow's reminders and Who is on this list (CTL-OFC-09-01 to CTL-OFC-09-15; FR-TEXT-13, FR-TEXT-25).
// It draws what it is given (the live screen and the preview states both pass data), so every state of the frame is one input.
import '../../styles/app/messages.css';
import { languageText, shortName, typeText, type MessageKey } from '@bw/i18n';
import { formatterFor } from '@bw/i18n/src/format.ts';
import Link from 'next/link';
import { Fragment } from 'react';
import { Fill } from '../import/ui.tsx';
import { Icon } from '../shell/Icon.tsx';
import { useT, type ClientT } from '../shell/intl.tsx';
import { ErrorPanel, LiveIndicator, type LiveState } from '../shell/Panels.tsx';
import { formatPhone } from '../shell/phone.ts';
import { dayText, outcomeRules, scriptParts, showsButtons, timeWords, zoneAbbr, type CallData, type CallOutcome, type FailedText, type ReminderCall } from './model.ts';

export type CallStatus = 'loading' | 'error' | 'ready';

export interface CallListBodyProps {
  status: CallStatus;
  data: CallData | null;
  /** The day the calls are made, and the branch (its name for Tomorrow's reminders). */
  date: string;
  branch: string;
  branchName: string;
  branchZone: string;
  live: LiveState;
  /** The row whose script shows, and the script's language (starts at the row's text language). */
  selected: string | null;
  scriptLang: 'en' | 'es' | null;
  /** The rows whose Change is open, and the row/outcome being recorded (its button is busy). */
  changing: ReadonlySet<string>;
  recording: { entryId: string; outcome: CallOutcome } | null;
  message: string | null;
  onDate?: (date: string) => void;
  onSelect?: (entryId: string) => void;
  onScriptLang?: (lang: 'en' | 'es') => void;
  onOutcome?: (row: ReminderCall | FailedText, outcome: CallOutcome) => void;
  /** CTL-OFC-09-05: opens the Reschedule dialog (SCR-OFC-20) on this page for the row's visit. */
  onReschedule?: (row: ReminderCall | FailedText) => void;
  onChange?: (entryId: string) => void;
  onPrint?: () => void;
  onRetry?: () => Promise<unknown> | unknown;
  onRefresh?: () => void;
}

const Spin = ({ dark = false }: { dark?: boolean }) => <span className={dark ? 'r1-spin dark' : 'r1-spin'} />;

const OUT_CLASS = { confirmed: 'conf', reschedule: 'resch', no_answer: 'noans' } as const;

function Outcome({ row, p, t }: { row: ReminderCall | FailedText; p: CallListBodyProps; t: ClientT }) {
  const changing = p.changing.has(row.entryId);
  const rules = outcomeRules(row);
  const busy = p.recording?.entryId === row.entryId ? p.recording.outcome : null;
  const anyBusy = busy !== null;
  const o = row.outcome;
  const w = timeWords(t, t.lang, p.branchZone);
  const buttons = (
    <>
      <div className="outs">
        {busy === 'confirmed' ? (
          <button type="button" className="ob c busy" aria-busy="true" data-ctl="CTL-OFC-09-04">
            <Spin dark />
            {t('calls.btn.confirm')}
          </button>
        ) : (
          <button type="button" className="ob c" data-ctl="CTL-OFC-09-04" disabled={!rules.confirm || anyBusy} onClick={() => p.onOutcome?.(row, 'confirmed')}>
            <Icon name="check" />
            {t('calls.btn.confirm')}
          </button>
        )}
        <button type="button" className="ob r" disabled={!rules.reschedule || anyBusy} data-ctl="CTL-OFC-09-05" onClick={() => p.onReschedule?.(row)}>
          <Icon name="calendar" />
          {t('calls.btn.reschedule')}
        </button>
        {busy === 'no_answer' ? (
          <button type="button" className="ob n busy" aria-busy="true" data-ctl="CTL-OFC-09-07">
            <Spin dark />
            {t('calls.btn.noAnswer')}
          </button>
        ) : (
          <button type="button" className="ob n" data-ctl="CTL-OFC-09-07" disabled={!rules.noAnswer || anyBusy} onClick={() => p.onOutcome?.(row, 'no_answer')}>
            <Icon name="phone" />
            {t('calls.btn.noAnswer')}
          </button>
        )}
      </div>
      {!rules.noAnswer ? <small>{`${t('calls.btn.noAnswer')}: ${t('calls.btn.alreadyReached')}`}</small> : null}
    </>
  );
  if (o === null) return buttons;
  const when = `${o.by ? shortName(o.by) : ''}`;
  return (
    <>
      <div className="done">
        <span className={`chip ${OUT_CLASS[o.kind]}`}>
          <span className="dot" />
          {t(`calls.out.${o.kind}` as MessageKey)}
        </span>
        <small>{o.kind === 'reschedule' ? t('calls.out.reschedNow', { who: when, day: dayText(t, row.visit.day) }) : t('calls.out.by', { who: when, time: w.clock(o.at) })}</small>
        <a
          className="chg"
          role="button"
          tabIndex={0}
          aria-expanded={changing}
          data-ctl="CTL-OFC-09-15"
          onClick={() => p.onChange?.(row.entryId)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              p.onChange?.(row.entryId);
            }
          }}
        >
          {t('calls.btn.change')}
        </a>
      </div>
      {showsButtons(o, changing) && changing ? buttons : null}
    </>
  );
}

function ReminderTable({ p, t }: { p: CallListBodyProps; t: ClientT }) {
  const w = timeWords(t, t.lang, p.branchZone);
  const rows = p.data?.reminderCalls ?? [];
  return (
    <table className="cl" data-ctl="CTL-OFC-09-02">
      <colgroup>
        <col className="bw-c168" />
        <col className="bw-c140" />
        <col className="bw-c244" />
        <col className="bw-c86" />
        <col />
      </colgroup>
      <thead>
        <tr>
          <th>{t('calls.col.customer')}</th>
          <th>{t('calls.col.phone')}</th>
          <th>{t('calls.col.visit')}</th>
          <th>{t('calls.col.language')}</th>
          <th>{t('calls.col.outcome')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.entryId}
            {...(r.outcome && !p.changing.has(r.entryId) ? { className: 'called' } : {})}
            data-selected={p.selected === r.entryId || undefined}
            onClick={() => p.onSelect?.(r.entryId)}
            onFocusCapture={() => p.selected !== r.entryId && p.onSelect?.(r.entryId)}
          >
            <td>
              <b>{r.customer}</b>
              <small>{r.area}</small>
            </td>
            <td>
              <span className="bw-ph">{formatPhone(r.phone)}</span>
              <small>{t(`calls.reason.${r.reason}` as MessageKey)}</small>
            </td>
            <td>
              <span className="win">{w.windowLabel(r.visit.window)}</span>
              <small>
                <Link className="jlk" aria-label={`${t(`service.${r.visit.service}.screen` as MessageKey)}: ${t('calls.btn.openJob')}`} href={`/office/jobs/${r.visit.jobNumber}`} data-ctl="CTL-OFC-09-06">
                  {t(`service.${r.visit.service}.screen` as MessageKey)}
                </Link>
                {r.visit.technician ? ` - ${r.visit.technician}` : ''}
              </small>
            </td>
            <td>
              <span className={r.language === 'es' ? 'lang es' : 'lang'}>{languageText(r.language, t)}</span>
            </td>
            <td>
              <Outcome row={r} p={p} t={t} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Progress({ data, t }: { data: CallData; t: ClientT }) {
  const g = data.progress;
  const pct = (n: number) => `${g.total === 0 ? 0 : (n / g.total) * 100}%`;
  return (
    <div className="prog" data-ctl="CTL-OFC-09-11">
      <b>{t('calls.progress', { called: g.called, total: g.total })}</b>
      <span className="bar">
        <Fill width={pct(g.confirmed)} className="bw-cl-site" />
        <Fill width={pct(g.reschedule)} className="bw-cl-orange" />
        <Fill width={pct(g.noAnswer)} className="bw-cl-ink" />
      </span>
      <span className="k">
        <i className="bw-cl-site" />
        {t('calls.legend.confirmed', { count: g.confirmed })}
      </span>
      <span className="k">
        <i className="bw-cl-orange" />
        {t('calls.legend.reschedule', { count: g.reschedule })}
      </span>
      <span className="k">
        <i className="bw-cl-ink" />
        {t('calls.legend.noAnswer', { count: g.noAnswer })}
      </span>
      <span className="k bw-cl-sorted">{t('calls.sorted')}</span>
    </div>
  );
}

function Script({ p, t, row }: { p: CallListBodyProps; t: ClientT; row: ReminderCall | FailedText | null }) {
  const lang = p.scriptLang ?? row?.language ?? t.lang;
  const sayT = formatterFor(lang);
  return (
    <section className="panel" data-ctl="CTL-OFC-09-09">
      <h3>{t('calls.say.title')}</h3>
      {row ? (
        <>
          <div className="seg" role="radiogroup" aria-label={t('calls.say.lang')} data-ctl="CTL-OFC-09-10">
            {(['en', 'es'] as const).map((l) => (
              <span
                key={l}
                role="radio"
                tabIndex={0}
                aria-checked={lang === l}
                {...(lang === l ? { className: 'on' } : {})}
                lang={l}
                onClick={() => p.onScriptLang?.(l)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    p.onScriptLang?.(l);
                  }
                }}
              >
                {t(`language.name.${l}` as MessageKey)}
              </span>
            ))}
          </div>
          <div className="script" lang={lang}>
            {scriptParts(row, sayT, p.date).map((part, i) => (part.bold ? <b key={i}>{part.text}</b> : <Fragment key={i}>{part.text}</Fragment>))}
          </div>
        </>
      ) : (
        <div className="bw-pm-hint">{t('calls.say.pick')}</div>
      )}
      <div className="rules bw-cl-rules">
        <div>
          <Icon name="check" />
          <span>
            <b>{t('calls.say.yes.k')}:</b> {t('calls.say.yes.v')}
          </span>
        </div>
        <div>
          <Icon name="calendar" />
          <span>
            <b>{t('calls.say.no.k')}:</b> {t('calls.say.no.v')}
          </span>
        </div>
        <div>
          <Icon name="phone" />
          <span>
            <b>{t('calls.say.noans.k')}:</b> {t('calls.say.noans.v')}
          </span>
        </div>
      </div>
    </section>
  );
}

function FailedList({ p, t }: { p: CallListBodyProps; t: ClientT }) {
  const w = timeWords(t, t.lang, p.branchZone);
  const rows = p.data?.failedTexts ?? [];
  return (
    <section className="panel">
      <h3>{t('calls.failed.title')}</h3>
      <div className="ftx" data-ctl="CTL-OFC-09-03">
        {rows.length === 0 ? (
          <p className="r1-note">{t('calls.empty', { day: dayText(t, p.date) })}</p>
        ) : (
          rows.map((r) => {
            const type = r.textType ? typeText(r.textType, t) : '';
            const day = dayText(t, r.visit.day);
            const line =
              r.reason === 'added_by_office' && r.addedAt
                ? t('calls.failed.added', { type, who: r.addedBy ? shortName(r.addedBy) : '', when: w.clock(r.addedAt) })
                : t('calls.failed.gaveUp', { type, when: r.failedAt ? w.clock(r.failedAt) : '' });
            return (
              <div className="fr" key={r.entryId} onClick={() => p.onSelect?.(r.entryId)} onFocusCapture={() => p.selected !== r.entryId && p.onSelect?.(r.entryId)}>
                <b>{r.customer}</b> <span className="bw-ph">{formatPhone(r.phone)}</span>
                <small>
                  {line}{' '}
                  <Link className="jlk" aria-label={`${t('calls.failed.visit', { day, window: w.windowLabel(r.visit.window) })}: ${t('calls.btn.openJob')}`} href={`/office/jobs/${r.visit.jobNumber}`} data-ctl="CTL-OFC-09-06">
                    {t('calls.failed.visit', { day, window: w.windowLabel(r.visit.window) })}
                  </Link>
                </small>
                <Outcome row={r} p={p} t={t} />
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

export function CallListBody(p: CallListBodyProps) {
  const t = useT();
  const ready = p.status === 'ready' && p.data ? p.data : null;
  const all: (ReminderCall | FailedText)[] = ready ? [...ready.reminderCalls, ...ready.failedTexts] : [];
  const selectedRow = all.find((r) => r.entryId === p.selected) ?? null;
  const q = new URLSearchParams({ branch: p.branch, date: p.date }).toString();
  const tomorrow = ready?.dayTotals.visitDay ?? p.date;
  const dt = ready?.dayTotals;
  // Who is on this list: the texts that failed 5 times, counted for tomorrow's visits (CTL-OFC-09-13).
  const failedForTomorrow = ready ? ready.failedTexts.filter((f) => f.reason === 'text_gave_up' && f.visit.day === tomorrow).length : 0;
  const w = timeWords(t, t.lang, p.branchZone);
  return (
    <>
      <div className="mh">
        <div className="row">
          <div>
            <h1>{t('msg.title')}</h1>
            <p data-ctl="CTL-OFC-08-21">{t('msg.intro', { zone: zoneAbbr(p.branchZone, ready?.asOf) })}</p>
          </div>
          <div className="acts">
            <LiveIndicator state={p.live} {...(p.onRefresh ? { onRefresh: p.onRefresh } : {})} />
          </div>
        </div>
        <div className="tabs">
          <Link href={`/office/messages?${q}`} data-ctl="CTL-OFC-08-01">
            <Icon name="message" />
            {t('msg.tab.log')}
          </Link>
          <Link className="on" href={`/office/messages/call-list?${q}`} aria-current="page" data-ctl="CTL-OFC-08-02">
            <Icon name="phone" />
            {t('msg.tab.calls')}
            {ready ? <span className="n">{ready.count}</span> : null}
          </Link>
        </div>
      </div>

      <div className="work">
        <section className="panel listp">
          <div className="lh">
            <div>
              <h2>{t('calls.title', { day: dayText(t, tomorrow) })}</h2>
              <div className="why" data-ctl="CTL-OFC-09-14">
                {t('calls.why')}
              </div>
            </div>
            <div className="acts">
              <label className="fsel" data-ctl="CTL-OFC-09-01">
                <span className="k">{t('calls.callsFor')}</span>
                <b>{dayText(t, p.date)}</b>
                <Icon name="chevDown" />
                <input type="date" className="bw-pm-sel" aria-label={t('calls.callsFor')} value={p.date} onChange={(e) => e.target.value && p.onDate?.(e.target.value)} />
              </label>
              <button type="button" className="btn primary bw-cl-print" data-ctl="CTL-OFC-09-08" disabled={!ready || ready.progress.total === 0} onClick={p.onPrint}>
                <Icon name="note" />
                {t('calls.print')}
              </button>
            </div>
          </div>
          {ready ? <Progress data={ready} t={t} /> : null}
          {p.message ? (
            <div className="r1-fmsg bw-pm-msg" role="alert">
              <Icon name="alert" />
              {p.message}
            </div>
          ) : null}
          {p.status === 'error' ? (
            <div className="bw-pm-pad">
              <ErrorPanel title={t('calls.error.title')} hint={t('shell.error.checkConnection')} onRetry={p.onRetry ?? (() => undefined)} />
            </div>
          ) : null}
          {p.status === 'loading' ? (
            <div className="bw-pm-skel">
              <span className="r1-skel bw-w-40" />
              <span className="r1-skel" />
              <span className="r1-skel" />
              <span className="r1-skel" />
            </div>
          ) : null}
          {ready && ready.reminderCalls.length === 0 ? (
            <div data-ctl="CTL-OFC-09-02">
              <p className="r1-note bw-pm-empty">{t('calls.empty', { day: dayText(t, tomorrow) })}</p>
            </div>
          ) : null}
          {ready && ready.reminderCalls.length > 0 ? <ReminderTable p={p} t={t} /> : null}
        </section>

        <aside className="bw-cl-side">
          <Script p={p} t={t} row={selectedRow} />
          {dt ? (
            <section className="panel" data-ctl="CTL-OFC-09-12">
              <h3>{t('calls.tom.title')}</h3>
              <div className="rules">
                <div>
                  <Icon name="calendar" />
                  <span>
                    <b>{t('calls.tom.visits.head', { count: dt.visits })}</b> {t('calls.tom.visits.rest', { day: dayText(t, dt.visitDay), branch: p.branchName })}
                  </span>
                </div>
                <div>
                  <Icon name="message" />
                  <span>
                    <b>{t('calls.tom.texts.head', { count: dt.reminderTexts })}</b> {t('calls.tom.texts.rest')}
                  </span>
                </div>
                <div>
                  <Icon name="phone" />
                  <span>
                    <b>{t('calls.tom.calls.head', { count: dt.callListCount })}</b> {t('calls.tom.calls.rest')}
                  </span>
                </div>
              </div>
            </section>
          ) : null}
          <section className="panel" data-ctl="CTL-OFC-09-13">
            <h3>{t('calls.who.title')}</h3>
            <div className="rules">
              <div>
                <Icon name="phone" />
                <span>{t('calls.who.noMobile')}</span>
              </div>
              <div>
                <Icon name="message" />
                <span>{t('calls.who.off')}</span>
              </div>
              <div>
                <Icon name="alert" />
                <span>
                  {t('calls.who.failed')}{' '}
                  {failedForTomorrow > 0 ? t('calls.who.failed.count', { count: failedForTomorrow }) : t('calls.who.failed.none')}
                </span>
              </div>
            </div>
          </section>
          <FailedList p={p} t={t} />
        </aside>
      </div>
      {ready ? <PrintSheet data={ready} date={p.date} branchZone={p.branchZone} t={t} w={w} /> : null}
    </>
  );
}

/** Print call list (CTL-OFC-09-08): the day's rows as a page of their own; the page's print style shows only this. */
function PrintSheet({ data, date, t, w }: { data: CallData; date: string; branchZone: string; t: ClientT; w: ReturnType<typeof timeWords> }) {
  const rows = [...data.reminderCalls, ...data.failedTexts];
  return (
    <section className="bw-print" aria-hidden="true">
      <h2>{t('calls.print.title', { day: dayText(t, date) })}</h2>
      <table>
        <thead>
          <tr>
            <th>{t('calls.col.customer')}</th>
            <th>{t('calls.col.phone')}</th>
            <th>{t('calls.col.visit')}</th>
            <th>{t('calls.print.technician')}</th>
            <th>{t('calls.col.language')}</th>
            <th>{t('calls.print.outcome')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.entryId}>
              <td>{r.customer}</td>
              <td>{formatPhone(r.phone)}</td>
              <td>{`${dayText(t, r.visit.day)}, ${w.windowLabel(r.visit.window)}`}</td>
              <td>{r.visit.technician ?? t('msg.ctx.unassigned')}</td>
              <td>{languageText(r.language, t)}</td>
              <td className="bw-print-box">{r.outcome ? t(`calls.out.${r.outcome.kind}` as MessageKey) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
