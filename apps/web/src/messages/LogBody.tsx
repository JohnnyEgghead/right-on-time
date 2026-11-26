// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-08 Messages: text log, its body (frame mockups/pages/office-messages.html, DK-93): the page header with Export to spreadsheet,
// the tabs, the day's tiles, the filter bar, the log table with its footer and the text detail panel (CTL-OFC-08-01 to CTL-OFC-08-27;
// FR-TEXT-15, FR-TEXT-24). It draws what it is given (the live screen and the preview states both pass data), so every state of the
// frame is one input. Every word is the catalog's; the status words are @bw/i18n text-rows, which the CSV export (API-146) shares.
import '../../styles/app/messages.css';
import {
  contextLine, handlingChip, handlingNote, languageText, reasonText, shortName, statusChip, statusNote, typeText, type ChipTone, type MessageKey,
} from '@bw/i18n';
import Link from 'next/link';
import { CallButton } from '../shell/CallButton.tsx';
import { Icon } from '../shell/Icon.tsx';
import { useT, type ClientT } from '../shell/intl.tsx';
import { ErrorPanel, LiveIndicator, type LiveState } from '../shell/Panels.tsx';
import {
  dayText, filtersSet, firstName, isToday, logRows, statusFactsOf, timeWords, TYPE_ICON, zoneAbbr, type DetailData, type LogData, type LogFilters, type LogRow, type ReplyRowData,
  type TextRowData,
} from './model.ts';

type LogStatus = 'loading' | 'error' | 'ready';

/** What the detail panel shows for the picked row. */
export interface DetailView {
  state: 'loading' | 'error' | 'ready';
  data: DetailData | null;
  /** Try now was pressed: its button is busy, then the panel shows the new try. */
  trying: boolean;
  /** The try that was made (Try now answered): its number, when it started and when it waits for. */
  tried: { number: number; startedAt: string | null; heldUntil: string | null } | null;
  adding: boolean;
  /** Add to call list answered: who put the customer on the call list and when. */
  added: { by: string | null; at: string } | null;
  /** A write's refusal or failure, shown in the panel. */
  message: string | null;
}

export interface LogBodyProps {
  status: LogStatus;
  data: LogData | null;
  /** The shown day and the demo clock's today (null until known). */
  date: string;
  today: string | null;
  branch: string;
  branchName: string;
  branchZone: string;
  filters: LogFilters;
  /** The count on the Call list tab (CTL-OFC-08-02); null when its read failed: no count. */
  callCount: number | null;
  live: LiveState;
  /** The key of the picked row (`text:<id>` or `reply:<id>`), and the rows that just changed (the Live row state). */
  picked: string | null;
  fresh?: ReadonlySet<string>;
  detail: DetailView | null;
  exporting: boolean;
  exportFailed: boolean;
  onDate?: (date: string) => void;
  onFilter?: (name: keyof LogFilters, value: string) => void;
  onClear?: () => void;
  onPick?: (key: string) => void;
  onNewer?: () => void;
  onOlder?: () => void;
  onTryNow?: () => void;
  onAddToCallList?: () => void;
  onExport?: () => void;
  onRetry?: () => Promise<unknown> | unknown;
  onRefresh?: () => void;
}

const TYPE_OPTIONS = ['confirmation', 'reminder', 'on_the_way', 'late', 'r_reply', 'office', 'replies'] as const;
const STATUS_OPTIONS = ['queued', 'delivered', 'held', 'retrying', 'gave_up', 'canceled', 'confirmed', 'reschedule_sent', 'not_understood'] as const;

const Spin = () => <span className="r1-spin" />;

function Chip({ tone, label }: { tone: ChipTone; label: string }) {
  if (tone === 'held') {
    return (
      <span className="chip held">
        <Icon name="clock" />
        {label}
      </span>
    );
  }
  return (
    <span className={`chip ${tone}`}>
      <span className="dot" />
      {label}
    </span>
  );
}

const typeOptionLabel = (t: ClientT, kind: (typeof TYPE_OPTIONS)[number]): string =>
  kind === 'office' || kind === 'replies' ? t(`msg.typeOpt.${kind}` as MessageKey) : typeText(kind, t);
const statusOptionLabel = (t: ClientT, s: (typeof STATUS_OPTIONS)[number]): string =>
  s === 'held' ? t('msg.statusOpt.held') : s === 'queued' ? t('msg.status.sent') : s === 'delivered' || s === 'retrying' || s === 'gave_up' || s === 'canceled' ? t(`msg.status.${s}` as MessageKey) : t(`msg.handling.${s}` as MessageKey);

/** A filter select: the frame's .fsel (label, current word, chevron) with the real select laid invisibly over it. */
function Select({ ctl, label, current, value, options, onChange }: { ctl: string; label: string; current: string; value: string; options: { value: string; label: string }[]; onChange?: (v: string) => void }) {
  return (
    <label className="fsel" data-ctl={ctl}>
      <span className="k">{label}</span>
      <b>{current}</b>
      <Icon name="chevDown" />
      <select className="bw-pm-sel" aria-label={label} value={value} onChange={(e) => onChange?.(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function FilterBar({ p, t }: { p: LogBodyProps; t: ClientT }) {
  const f = p.filters;
  const all = t('msg.filter.all');
  const typeOpts = [{ value: '', label: all }, ...TYPE_OPTIONS.map((k) => ({ value: k, label: typeOptionLabel(t, k) }))];
  const statusOpts = [{ value: '', label: all }, ...STATUS_OPTIONS.map((s) => ({ value: s, label: statusOptionLabel(t, s) }))];
  const langOpts = [{ value: '', label: all }, { value: 'en', label: languageText('en', t) }, { value: 'es', label: languageText('es', t) }];
  const day = isToday(p.date, p.today) ? t('msg.day.today', { day: dayText(t, p.date) }) : dayText(t, p.date);
  return (
    <div className="fbar">
      <label className="fsel" data-ctl="CTL-OFC-08-03">
        <Icon name="calendar" />
        <b>{day}</b>
        <Icon name="chevDown" />
        <input type="date" className="bw-pm-sel" aria-label={t('msg.filter.day')} value={p.date} onChange={(e) => e.target.value && p.onDate?.(e.target.value)} />
      </label>
      <Select ctl="CTL-OFC-08-04" label={t('msg.filter.type')} current={typeOpts.find((o) => o.value === f.type)?.label ?? all} value={f.type} options={typeOpts} onChange={(v) => p.onFilter?.('type', v)} />
      <Select ctl="CTL-OFC-08-05" label={t('msg.filter.status')} current={statusOpts.find((o) => o.value === f.status)?.label ?? all} value={f.status} options={statusOpts} onChange={(v) => p.onFilter?.('status', v)} />
      <Select ctl="CTL-OFC-08-06" label={t('msg.filter.language')} current={langOpts.find((o) => o.value === f.language)?.label ?? all} value={f.language} options={langOpts} onChange={(v) => p.onFilter?.('language', v)} />
      <label className="fsel find" data-ctl="CTL-OFC-08-07">
        <Icon name="search" />
        <input className="bw-pm-find" type="search" aria-label={t('msg.filter.find')} placeholder={t('msg.filter.find')} value={f.customer} onChange={(e) => p.onFilter?.('customer', e.target.value)} />
      </label>
      {filtersSet(f) ? (
        <button type="button" className="btn sm" data-ctl="CTL-OFC-08-08" onClick={p.onClear}>
          {t('msg.filter.clear')}
        </button>
      ) : null}
    </div>
  );
}

function Tiles({ data, today, t }: { data: LogData; today: boolean; t: ClientT }) {
  const c = data.counts;
  const when = t(today ? 'msg.when.today' : 'msg.when.thatDay');
  const allOnTime = c.confirmationsOnTime === c.confirmations;
  return (
    <div className="tiles" data-ctl="CTL-OFC-08-09">
      <div className="tile">
        <span className="num">{c.texts}</span>
        <span className="lb">
          {t('msg.tile.texts', { when })}
          <small>{t('msg.tile.texts.sub', { count: c.delivered })}</small>
        </span>
      </div>
      <div className="tile">
        <span className="num bw-pm-teal">{c.notSent}</span>
        <span className="lb">
          {t('msg.tile.notSent')}
          <small>{t('msg.tile.notSent.sub')}</small>
        </span>
      </div>
      <div className="tile" data-ctl="CTL-OFC-08-22">
        <span className="num bw-pm-teal">{c.confirmations}</span>
        <span className="lb">
          {t('msg.tile.confirmations')}
          <small>{allOnTime ? t('msg.tile.confirmations.all') : t('msg.tile.confirmations.some', { onTime: c.confirmationsOnTime, total: c.confirmations })}</small>
        </span>
      </div>
      <div className="tile" data-ctl="CTL-OFC-08-22">
        <span className="num">{c.replies}</span>
        <span className="lb">
          {t('msg.tile.replies')}
          <small>{t('msg.tile.replies.sub', { confirmed: c.repliesConfirmed, reschedule: c.repliesReschedule })}</small>
        </span>
      </div>
      <div className="tile held">
        <span className="num">{c.held}</span>
        <span className="lb">
          {t('msg.tile.held')}
          <small>{t('msg.tile.held.sub')}</small>
        </span>
      </div>
      <div className="tile fail">
        <span className="num">{c.failedRetrying}</span>
        <span className="lb">
          {t('msg.tile.failed')}
          <small data-ctl="CTL-OFC-08-22">{t('msg.tile.failed.sub', { count: c.gaveUp, when })}</small>
        </span>
      </div>
    </div>
  );
}

const Skeleton = () => (
  <div className="bw-pm-skel">
    <span className="r1-skel bw-w-30" />
    <span className="r1-skel" />
    <span className="r1-skel" />
    <span className="r1-skel" />
    <span className="r1-skel" />
    <span className="r1-skel" />
  </div>
);

function Row({ r, p, t }: { r: LogRow; p: LogBodyProps; t: ClientT }) {
  const w = timeWords(t, t.lang, p.branchZone);
  const picked = p.picked === r.key;
  const fresh = p.fresh?.has(r.key) ?? false;
  const cls = picked ? 'pick' : fresh ? 'live' : undefined;
  const pick = () => p.onPick?.(r.key);
  let icon: keyof typeof TYPE_ICON;
  let typeWord: string;
  let lang: 'en' | 'es';
  let body: string;
  let chip: { tone: ChipTone; label: string };
  let note = '';
  let ctx: string;
  if (r.kind === 'text') {
    const x: TextRowData = r.row;
    icon = x.type;
    typeWord = typeText(x.type, t);
    lang = x.language;
    body = x.body;
    const facts = statusFactsOf(x, p.branchZone);
    chip = statusChip(facts, t, w);
    note = statusNote(facts, t, w);
    ctx = contextLine(x.context, x.type === 'confirmation' && x.context.bookedAt ? 'held_confirmation' : 'text', t, { ...w, dayWord: () => '' });
  } else {
    const x: ReplyRowData = r.row;
    icon = 'replies';
    typeWord = typeText('replies', t);
    lang = x.language;
    body = x.body;
    chip = handlingChip(x.handling, t);
    note = handlingNote(x.handling, x.at, t);
    ctx = contextLine(x.context, 'reply', t, { ...w, dayWord: (d) => (isToday(d, p.today) ? t('msg.ctx.today') : dayText(t, d)) });
  }
  return (
    <tr
      role="button"
      tabIndex={0}
      aria-pressed={picked}
      data-ctl="CTL-OFC-08-11"
      {...(cls ? { className: cls } : {})}
      onClick={pick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick();
        }
      }}
    >
      <td className="tm">{w.clock(r.at)}</td>
      <td className="cu">
        <b>{r.row.customer}</b>
        <small data-ctl="CTL-OFC-08-24">{ctx}</small>
      </td>
      <td>
        <span className="ty">
          <Icon name={TYPE_ICON[icon]} />
          {typeWord}
        </span>
      </td>
      <td>
        <span className={lang === 'es' ? 'lang es' : 'lang'}>{languageText(lang, t)}</span>
      </td>
      <td className="tx" data-ctl="CTL-OFC-08-23" lang={lang} title={body}>
        {body}
      </td>
      <td>
        <div className="stc">
          <Chip {...chip} />
          {note !== '' ? <small>{note}</small> : null}
        </div>
      </td>
    </tr>
  );
}

function Detail({ p, t }: { p: LogBodyProps; t: ClientT }) {
  const d = p.detail;
  const w = timeWords(t, t.lang, p.branchZone);
  const row = p.data ? logRows(p.data).find((r) => r.key === p.picked) : undefined;
  if (!row || !d) {
    return (
      <aside className="panel detp" data-ctl="CTL-OFC-08-12">
        <div className="bw-pm-hint">{t('msg.detail.hint')}</div>
      </aside>
    );
  }
  if (row.kind === 'reply') {
    const x = row.row;
    const h = handlingChip(x.handling, t);
    return (
      <aside className="panel detp" data-ctl="CTL-OFC-08-12">
        <div className="dh">
          <div className="t1">
            <h2>{t('msg.detail.titleReply', { customer: x.customer })}</h2>
          </div>
          <div className="bw-pm-chiprow">
            <Chip {...h} />
          </div>
        </div>
        <div className="bubble" lang={x.language}>{x.body}</div>
        <div className="meta">{languageText(x.language, t)}</div>
        <div className="vis">
          {x.jobNumber !== null ? (
            <Link className="r1-link" href={`/office/jobs/${x.jobNumber}`} data-ctl="CTL-OFC-08-13">
              {t('msg.detail.openJob')}
            </Link>
          ) : null}
          {x.jobNumber !== null ? ' ' : null}
          <Link className="r1-link" href={`/office/customers/${x.customerId}`} data-ctl="CTL-OFC-08-14">
            {t('msg.detail.openCustomer')}
          </Link>
        </div>
      </aside>
    );
  }
  const x = row.row;
  if (d.state === 'loading' || d.state === 'error' || !d.data) {
    return (
      <aside className="panel detp" data-ctl="CTL-OFC-08-12">
        {d.state === 'error' ? <div className="bw-pm-hint" role="alert">{t('msg.detail.error')}</div> : <Skeleton />}
      </aside>
    );
  }
  const x2 = d.data;
  const facts = { ...statusFactsOf(x, p.branchZone), tries: x2.attempts.length };
  const chip = statusChip(facts, t, w);
  const retrying = x2.status === 'retrying';
  const nextNumber = x2.attempts.length + 1;
  const job = x2.job;
  const booked = job
    ? job.bookedVia === 'office'
      ? job.bookedBy ? t('msg.detail.booked.office', { time: w.clock(job.bookedAt), who: shortName(job.bookedBy) }) : t('msg.detail.booked.officeNoWho', { time: w.clock(job.bookedAt) })
      : job.bookedVia === 'online' ? t('msg.detail.booked.online', { time: w.clock(job.bookedAt) }) : t('msg.detail.booked.seed', { time: w.clock(job.bookedAt) })
    : x2.sentBy ? t('msg.detail.sentBy', { who: shortName(x2.sentBy) }) : null;
  const recipient = x2.customerContact.mobileEnd
    ? t('msg.detail.recipient', { language: languageText(x2.language, t), end: x2.customerContact.mobileEnd })
    : t('msg.detail.noMobile', { language: languageText(x2.language, t) });
  const canCall = (x2.status === 'retrying' || x2.status === 'gave_up') && x2.customerContact.phone !== null;
  const onList = d.added ?? (x2.onCallList ? { by: x2.onCallList.by, at: x2.onCallList.at } : null);
  const tries = x2.plannedTries.map((q) => w.clock(q.at));
  const list = new Intl.ListFormat(t.lang, { style: 'long', type: 'conjunction' }).format(tries);
  const reason = x2.status === 'held' && x2.heldUntil
    ? t('msg.status.held.detail', { time: w.hourWord(x2.heldUntil), zone: w.zoneWord(facts.customerZone), branch: w.branchClock(x2.heldUntil) })
    : reasonText(x2.reasonKey, t);
  return (
    <aside className="panel detp" data-ctl="CTL-OFC-08-12">
      <div className="dh">
        <div className="t1">
          <h2>{t('msg.detail.title', { type: typeText(x2.type, t), customer: x2.customer })}</h2>
        </div>
        {booked ? (
          <div className="sub" data-ctl="CTL-OFC-08-26">
            {booked}
          </div>
        ) : null}
        <div className="bw-pm-chiprow">
          <Chip tone={chip.tone} label={retrying ? `${chip.label}, ${t('msg.detail.attemptOf', { n: x2.attempts.length })}` : chip.label} />
        </div>
      </div>
      <div className="bubble" lang={x2.language}>{x2.body}</div>
      <div className="meta" data-ctl="CTL-OFC-08-26">
        {recipient}
      </div>
      {reason !== '' && !retrying ? <div className="meta">{reason}</div> : null}
      {x2.attempts.length > 0 || retrying ? (
        <div className="tries">
          <h4>{t('msg.detail.attempts')}</h4>
          {x2.attempts.map((a) => (
            <div className="try" key={a.number}>
              <span className={a.result === 'failed' ? 'd x' : 'd ok'}>{a.number}</span>
              <div className="w">
                {t(a.result === 'failed' ? 'msg.detail.attempt.failed' : 'msg.detail.attempt.delivered', { time: w.clock(a.at) })}
                {a.reasonKey ? <small>{t(a.reasonKey as MessageKey)}</small> : null}
              </div>
            </div>
          ))}
          {d.tried ? (
            <div className="try">
              <span className="d n">{d.tried.number}</span>
              <div className="w">
                <b>{t('msg.act.tryingNow', { n: d.tried.number })}</b>
                <small>{d.tried.heldUntil ? t('msg.act.heldTry', { time: w.hourWord(d.tried.heldUntil), zone: w.zoneWord(facts.customerZone) }) : d.tried.startedAt ? t('msg.act.started', { time: w.clock(d.tried.startedAt) }) : ''}</small>
              </div>
            </div>
          ) : retrying && x2.nextTryAt ? (
            <div className="try" data-ctl="CTL-OFC-08-27">
              <span className="d n">{nextNumber}</span>
              <div className="w">
                <b>{t('msg.detail.nextTry', { time: w.clock(x2.nextTryAt), n: nextNumber })}</b>
                {tries.length > 0 ? <small>{t('msg.detail.thenTries', { times: list })}</small> : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {retrying ? (
        <div className="never" data-ctl="CTL-OFC-08-27">
          <Icon name="info" />
          <div>{t('msg.detail.never', { customer: x2.customer })}</div>
        </div>
      ) : null}
      {job ? (
        <div className="vis">
          <h4>{t('msg.detail.visit')}</h4>
          {t('msg.detail.visitLine', { job: job.jobNumber, service: t(`service.${job.service}.screen` as MessageKey), area: job.area })}
          <br />
          {isToday(job.day, p.today) ? t('msg.ctx.today') : dayText(t, job.day)}, {w.windowLabel(job.window)} - <b>{job.technician ?? t('msg.ctx.unassigned')}</b>
          <br />
          <Link className="r1-link" href={`/office/jobs/${job.jobNumber}`} data-ctl="CTL-OFC-08-13">
            {t('msg.detail.openJob')}
          </Link>{' '}
          <Link className="r1-link" href={`/office/customers/${x2.customerId}`} data-ctl="CTL-OFC-08-14">
            {t('msg.detail.openCustomer')}
          </Link>
        </div>
      ) : (
        <div className="vis">
          <Link className="r1-link" href={`/office/customers/${x2.customerId}`} data-ctl="CTL-OFC-08-14">
            {t('msg.detail.openCustomer')}
          </Link>
        </div>
      )}
      {d.message ? (
        <div className="r1-fmsg bw-pm-msg" role="alert">
          <Icon name="alert" />
          {d.message}
        </div>
      ) : null}
      {onList ? (
        <div className="never bw-pm-added">
          <Icon name="check" />
          <div>{t('msg.act.added', { who: onList.by ? shortName(onList.by) : '', time: w.clock(onList.at) })}</div>
        </div>
      ) : null}
      {retrying || canCall || x2.status === 'gave_up' ? (
        <div className="dacts">
          {retrying ? (
            d.trying ? (
              <button type="button" className="btn busy primary sm" aria-busy="true" data-ctl="CTL-OFC-08-17">
                <Spin />
                {t('msg.act.tryNow.busy')}
              </button>
            ) : (
              <button type="button" className="btn sm primary" data-ctl="CTL-OFC-08-17" disabled={!x2.canTryNow} onClick={p.onTryNow}>
                <Icon name="refresh" />
                {t('msg.act.tryNow')}
              </button>
            )
          ) : null}
          {canCall && x2.customerContact.phone ? (
            <span data-ctl="CTL-OFC-08-18" className="bw-pm-call">
              <CallButton name={firstName(x2.customer)} fullName={x2.customer} number={x2.customerContact.phone} className="btn sm">
                <Icon name="phone" />
                {t('msg.act.call', { name: firstName(x2.customer) })}
              </CallButton>
            </span>
          ) : null}
          {job && (retrying || x2.status === 'gave_up') ? (
            onList ? (
              <button type="button" className="btn sm dis" aria-disabled="true" data-ctl="CTL-OFC-08-19">
                <Icon name="list" />
                {t('msg.act.addList')}
              </button>
            ) : (
              <button type="button" className="btn sm" data-ctl="CTL-OFC-08-19" aria-busy={d.adding || undefined} onClick={p.onAddToCallList}>
                <Icon name="list" />
                {t('msg.act.addList')}
              </button>
            )
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function Header({ p, t, zone }: { p: LogBodyProps; t: ClientT; zone: string }) {
  const q = new URLSearchParams({ branch: p.branch, date: p.date }).toString();
  return (
    <div className="mh">
      <div className="row">
        <div>
          <h1>{t('msg.title')}</h1>
          <p data-ctl="CTL-OFC-08-21">{t('msg.intro', { zone })}</p>
        </div>
        <div className="acts">
          <LiveIndicator state={p.live} {...(p.onRefresh ? { onRefresh: p.onRefresh } : {})} />
          {p.exporting ? (
            <button type="button" className="btn busy primary" aria-busy="true" data-ctl="CTL-OFC-08-20">
              <Spin />
              {t('msg.export.busy')}
            </button>
          ) : (
            <button type="button" className="btn" data-ctl="CTL-OFC-08-20" onClick={p.onExport} disabled={p.status !== 'ready' || (p.data?.total ?? 0) === 0}>
              <Icon name="download" />
              {t('msg.export')}
            </button>
          )}
        </div>
      </div>
      {p.exportFailed ? (
        <div className="r1-fmsg bw-pm-msg" role="alert">
          <Icon name="alert" />
          {t('msg.export.failed')}
        </div>
      ) : null}
      <div className="tabs">
        <Link className="on" href={`/office/messages?${q}`} aria-current="page" data-ctl="CTL-OFC-08-01">
          <Icon name="message" />
          {t('msg.tab.log')}
        </Link>
        <Link href={`/office/messages/call-list?${q}`} data-ctl="CTL-OFC-08-02">
          <Icon name="phone" />
          {t('msg.tab.calls')}
          {p.callCount !== null ? <span className="n">{p.callCount}</span> : null}
        </Link>
      </div>
    </div>
  );
}

export function LogBody(p: LogBodyProps) {
  const t = useT();
  const ready = p.status === 'ready' && p.data ? p.data : null;
  const rows = ready ? logRows(ready) : [];
  const empty = ready !== null && ready.total === 0;
  const q = ready?.nextReminders;
  const w = timeWords(t, t.lang, p.branchZone);
  const mode = ready?.simulatorMode ?? 'up';
  return (
    <>
      <Header p={p} t={t} zone={zoneAbbr(p.branchZone, p.data?.asOf)} />
      {ready ? <Tiles data={ready} today={isToday(p.date, p.today)} t={t} /> : null}
      {ready && mode !== 'up' ? (
        <div className="bw-pm-simwrap">
          <div className="simn" data-ctl="CTL-OFC-08-10">
            <Icon name="alert" />
            {t('msg.sim.notice', { mode: t(`msg.sim.${mode}` as MessageKey) })}
          </div>
        </div>
      ) : null}
      <div className="work">
        <section className="panel logp">
          <FilterBar p={p} t={t} />
          {p.status === 'error' ? (
            <div className="bw-pm-pad">
              <ErrorPanel title={t('msg.error.title')} hint={t('shell.error.checkConnection')} onRetry={p.onRetry ?? (() => undefined)} />
            </div>
          ) : null}
          {p.status === 'loading' ? <Skeleton /> : null}
          {empty ? (
            <p className="r1-note bw-pm-empty">{filtersSet(p.filters) ? t('msg.empty.filter') : t('msg.empty.day', { day: dayText(t, p.date) })}</p>
          ) : null}
          {ready && !empty ? (
            <table className="log">
              <colgroup>
                <col className="bw-c84" />
                <col className="bw-c226" />
                <col className="bw-c124" />
                <col className="bw-c82" />
                <col />
                <col className="bw-c214" />
              </colgroup>
              <thead>
                <tr>
                  <th>{t('msg.col.time')}</th>
                  <th>{t('msg.col.customer')}</th>
                  <th>{t('msg.col.type')}</th>
                  <th>{t('msg.col.language')}</th>
                  <th>{t('msg.col.text')}</th>
                  <th>{t('msg.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Row key={r.key} r={r} p={p} t={t} />
                ))}
              </tbody>
            </table>
          ) : null}
          {ready ? (
            <div className="foot">
              <span className="bw-nowrap">{t('msg.foot.count', { shown: rows.length, total: ready.total, when: t(isToday(p.date, p.today) ? 'msg.when.today' : 'msg.when.thatDay') })}</span>
              {q ? (
                <span className="bw-pm-next" data-ctl="CTL-OFC-08-25">
                  <Icon name="bell" />
                  {t('msg.foot.next', { count: q.reminderTexts, day: dayText(t, q.visitDay), time: w.clock(q.at), calls: q.callListCount })}
                </span>
              ) : null}
              <span className="pg">
                {ready.cursors.newer ? (
                  <button type="button" className="btn sm" data-ctl="CTL-OFC-08-15" onClick={p.onNewer}>
                    <Icon name="chevLeft" />
                    {t('msg.page.newer')}
                  </button>
                ) : (
                  <span className="btn sm dis" aria-disabled="true" data-ctl="CTL-OFC-08-15">
                    <Icon name="chevLeft" />
                    {t('msg.page.newer')}
                  </span>
                )}
                {ready.cursors.older ? (
                  <button type="button" className="btn sm" data-ctl="CTL-OFC-08-16" onClick={p.onOlder}>
                    {t('msg.page.older')}
                    <Icon name="chevRight" />
                  </button>
                ) : (
                  <span className="btn sm dis" aria-disabled="true" data-ctl="CTL-OFC-08-16">
                    {t('msg.page.older')}
                    <Icon name="chevRight" />
                  </span>
                )}
              </span>
            </div>
          ) : null}
        </section>
        <Detail p={p} t={t} />
      </div>
    </>
  );
}
