// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-12 Admin: arrival windows and its dialog SCR-OFC-24 Switch a day's windows (frame mockups/pages/admin-windows.html, DK-97;
// FR-BOOK-2, FR-BOOK-8, FR-BOOK-17, FR-BOOK-18, UC-13). The view takes API-90's data and the interaction state, so the preview routes
// draw each state the frame shows with the frame's data and the screen (WindowsScreen.tsx) feeds it the live ones. Markup and classes are
// the frame's, so its page-local sheet (styles/page-admin-windows.css, a byte copy) styles it.
import '../shell/css/office.ts';
import '../../styles/page-admin-windows.css';
import '../../styles/app/windows.css';
import type { MessageKey } from '@bw/i18n';
import type { KeyboardEvent, ReactNode } from 'react';
import { BusyLabel, Dialog, Fill } from '../import/ui.tsx';
import { AdminFrame } from '../shell/Frames.tsx';
import { ToastView } from '../shell/Announcer.tsx';
import { BRANCHES, branchById } from '../shell/branches.ts';
import type { FrameData } from '../shell/frame-data.ts';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import type { Me, OfficeTopBarProps } from '../shell/OfficeTopBar.tsx';
import { shortName } from '../shell/OfficeTopBar.tsx';
import { ErrorPanel } from '../shell/Panels.tsx';
import {
  dayShort, dayText, draftState, joinItems, joinSpans, LIMIT_MAX, otherSwitched, pickedOf, spanLabel, switchBar, timeText, weeksOf, whenText,
  type Settings, type SettingsDay, type SettingsWindow,
} from './model.ts';
import { dateNumbers, timeParts, windowLabel } from '../week/week-model.ts';

export type WindowsState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: Settings };

/** SCR-OFC-24's own state: what is being switched, the typed reason, and whether the write is running. */
export interface DialogUi {
  mode: 'four_hour' | 'two_hour';
  date: string;
  reason: string;
  /** The reason field was edited, so an empty one shows its message. */
  touched: boolean;
  switching: boolean;
  /** A refused or failed write's message. */
  message: string | null;
}

export interface WindowsUi {
  /** The typed limits, by window id. */
  draft: Record<string, string>;
  saving: boolean;
  /** CTL-OFC-12-06 `capacity_below_bookings`: the field that holds the reason, with its text. */
  refused: { windowId: string; text: string } | null;
  /** A save that failed for any other reason. */
  saveMessage: string | null;
  /** The picked day (CTL-OFC-12-11); null: today. */
  picked: string | null;
  /** The panel's Reason field (CTL-OFC-12-13), carried into the dialog. */
  reason: string;
  dialog: DialogUi | null;
  toast: string | null;
  /** Drawn inside a states tile instead of over the page (the look comparator's previews). */
  inline?: boolean;
}

export const IDLE_UI: WindowsUi = { draft: {}, saving: false, refused: null, saveMessage: null, picked: null, reason: '', dialog: null, toast: null };

export interface WindowsHandlers {
  onBranch?: (id: string) => void;
  onLimit?: (windowId: string, text: string) => void;
  onSave?: () => void;
  onDiscard?: () => void;
  onPick?: (date: string) => void;
  onReason?: (text: string) => void;
  onAsk?: (mode: 'four_hour' | 'two_hour') => void;
  onDialogReason?: (text: string) => void;
  onCancel?: () => void;
  onSwitch?: () => void;
  onRetry?: () => Promise<unknown> | unknown;
}

type Frame = Omit<FrameData, 'screen' | 'children'> & { me?: Me; bar?: Omit<OfficeTopBarProps, 'me'> };

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="bw-win-skel" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className={i === 0 ? 'r1-skel bw-w-40' : 'r1-skel'} />
      ))}
    </div>
  );
}

const keyOf = (e: KeyboardEvent<HTMLElement>, fire: () => void) => {
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    fire();
  }
};

/** The 2-hour windows table (CTL-OFC-12-01): the number field per window, the booked meter, the refusal on its field. */
function WindowsTable({ data, ui, on }: { data: Settings; ui: WindowsUi; on: WindowsHandlers }) {
  const t = useT();
  const d = draftState(data.windows, ui.draft);
  const row = (w: SettingsWindow) => {
    const label = spanLabel(w);
    const text = ui.draft[w.windowId] ?? String(w.limit);
    const bad = d.invalid.has(w.windowId);
    const refused = ui.refused?.windowId === w.windowId;
    const full = w.bookedToday >= w.limit;
    const cls = `step${d.changedIds.has(w.windowId) && !bad && !refused ? ' chg' : ''}${bad || refused ? ' bad' : ''}`;
    const nudge = (by: number) => {
      const n = Number(text);
      const base = Number.isInteger(n) && n >= 0 ? n : w.limit;
      on.onLimit?.(w.windowId, String(Math.min(LIMIT_MAX, Math.max(0, base + by))));
    };
    return (
      <tr key={w.windowId}>
        <td><b>{label}</b></td>
        <td className="r tnum">{w.technicians}</td>
        <td>
          <span className={cls}>
            <span aria-hidden="true" onClick={() => nudge(-1)}>-</span>
            <input
              className="bw-step-in"
              inputMode="numeric"
              autoComplete="off"
              aria-label={t('windows.limit.label', { window: label })}
              aria-invalid={bad || refused || undefined}
              value={text}
              onChange={(e) => on.onLimit?.(w.windowId, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  nudge(e.key === 'ArrowUp' ? 1 : -1);
                }
              }}
            />
            <span aria-hidden="true" onClick={() => nudge(1)}>+</span>
          </span>
          {bad ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{t('windows.limit.invalid', { max: LIMIT_MAX })}</div> : null}
          {refused && ui.refused ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{ui.refused.text}</div> : null}
        </td>
        <td>
          <span className="fill">
            <span className={full ? 'meter full' : 'meter'}><Fill width={`${w.limit > 0 ? Math.round((100 * w.bookedToday) / w.limit) : 100}%`} /></span>
            {t('windows.booked.of', { booked: w.bookedToday, limit: w.limit })}
            {full ? <> <span className="chip full"><span className="dot" />{t('windows.full')}</span></> : null}
          </span>
        </td>
      </tr>
    );
  };
  return (
    <table className="w" data-ctl="CTL-OFC-12-01">
      <thead>
        <tr><th>{t('windows.col.window')}</th><th className="r">{t('windows.col.technicians')}</th><th>{t('windows.col.limit')}</th><th>{t('windows.col.booked')}</th></tr>
      </thead>
      <tbody>{data.windows.map(row)}</tbody>
    </table>
  );
}

/** CTL-OFC-12-02: the fixed rules, in words. */
function Rules({ data }: { data: Settings }) {
  const t = useT();
  const r = data.rules;
  const quiet = windowLabel(timeParts(r.quietFrom), timeParts(r.quietTo));
  const lock = (text: string) => <span className="val lock"><Icon name="lock" />{text}</span>;
  return (
    <div data-ctl="CTL-OFC-12-02">
      <div className="set">
        <div className="l"><b>{t('windows.rules.cutoff.t')}</b><small>{t('windows.rules.cutoff.d')}</small></div>
        {lock(t('windows.rules.cutoff.v', { time: timeText(r.onlineCutoff) }))}
      </div>
      <div className="set">
        <div className="l"><b>{t('windows.rules.capacity.t')}</b><small>{t('windows.rules.capacity.d')}</small></div>
        {lock(t('windows.rules.capacity.v', { two: r.capacities.twoHour, four: r.capacities.fourHour, sat: r.capacities.saturday }))}
      </div>
      <div className="set">
        <div className="l"><b>{t('windows.rules.reminder.t')}</b><small>{t('windows.rules.reminder.d')}</small></div>
        {lock(t('windows.rules.reminder.v', { time: timeText(r.reminder) }))}
      </div>
      <div className="set">
        <div className="l"><b>{t('windows.rules.quiet.t')}</b><small>{t('windows.rules.quiet.d', { time: timeText(r.quietTo).replace(':00', '') })}</small></div>
        {lock(quiet)}
      </div>
    </div>
  );
}

/** One calendar day button (CTL-OFC-12-11). */
function DayButton({ day, today, picked, on }: { day: SettingsDay; today: string; picked: boolean; on: WindowsHandlers }) {
  const t = useT();
  const four = day.mode === 'four_hour';
  const closed = day.mode === 'closed';
  const cls = ['day', day.date < today ? 'past' : '', day.date === today ? 'today' : '', four ? 'peak' : '', closed ? 'closed' : '', picked ? 'picked' : ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} aria-pressed={picked} onClick={() => on.onPick?.(day.date)}>
      <span className="d"><span className="bw-wd">{t(`time.weekday.${dateNumbers(day.date).weekday}` as MessageKey)}</span>{dayShort(t, day.date)}</span>
      <span className={closed ? 'pill off' : four ? 'pill four' : 'pill two'}>{t(closed ? 'windows.pill.off' : four ? 'windows.pill.four' : 'windows.pill.two')}</span>
      {day.date === today ? <span className="tt">{t('windows.today')}</span> : null}
      {four && day.reason ? <span className="why">{day.reason}</span> : null}
      {closed ? null : <span className="m">{t('windows.day.of', { booked: day.booked, capacity: day.capacity })}</span>}
    </button>
  );
}

/** CTL-OFC-12-12: the picked day, the switch, the reason and Switch back. */
function PickedDay({ data, day, ui, on }: { data: Settings; day: SettingsDay; ui: WindowsUi; on: WindowsHandlers }) {
  const t = useT();
  const bar = switchBar(day, data.today);
  const four = day.mode === 'four_hour';
  const title = day.mode === 'closed' ? 'windows.panel.closed' : four ? 'windows.panel.four' : 'windows.panel.two';
  const others = otherSwitched(data.days, day.date);
  const sat = bar === 'saturday';
  const off = bar !== null;
  // While the confirm is open for this day the switch shows the position it asks for (the frame's Asking tile draws it on, the day still 2-hour).
  const pending = ui.dialog && ui.dialog.date === day.date ? ui.dialog.mode : null;
  const on_ = pending ? pending === 'four_hour' : four;
  return (
    <div className="dayset" data-ctl="CTL-OFC-12-12">
      <div>
        <h4>{t(title as MessageKey, { day: dayText(t, day.date) })}</h4>
        <div className="wins">{day.windows.map((w) => <span key={w.start}>{spanLabel(w)}</span>)}</div>
        {four ? (
          <div className="kv">
            {t('windows.kv.reason')} <b>{day.reason}</b>
            <br />
            {day.switchedBy && day.switchedAt ? t('windows.kv.switched', { name: shortName(day.switchedBy), when: whenText(t, day.switchedAt) }) : null}
            {others.length > 0 ? ` ${t('windows.kv.others', { days: joinItems(t, others.map((d) => dayText(t, d))), count: others.length })}` : null}
            {day.bookedCount > 0 ? <><br />{t('windows.kv.kept', { count: day.bookedCount })}</> : null}
          </div>
        ) : null}
      </div>
      <div className="acts">
        <span
          className={on_ ? 'tog' : 'tog off'}
          role="switch"
          aria-checked={on_}
          aria-disabled={off || undefined}
          tabIndex={0}
          data-ctl="CTL-OFC-12-04"
          onClick={() => (off ? undefined : on.onAsk?.(four ? 'two_hour' : 'four_hour'))}
          onKeyDown={(e) => keyOf(e, () => (off ? undefined : on.onAsk?.(four ? 'two_hour' : 'four_hour')))}
        >
          <span className="sw" />
          {t('windows.toggle')}
        </span>
        {four ? (
          <span className="reason" data-ctl="CTL-OFC-12-13">
            <span className="k">{t('windows.reason.k')}</span>
            {day.reason}
          </span>
        ) : (
          <label className="reason" data-ctl="CTL-OFC-12-13">
            <span className="k">{t('windows.reason.k')}</span>
            <input
              className="bw-reason-in"
              value={ui.reason}
              disabled={off}
              maxLength={120}
              placeholder={t('windows.reason.ph')}
              aria-describedby={sat ? 'bw-win-sat' : undefined}
              onChange={(e) => on.onReason?.(e.target.value)}
            />
          </label>
        )}
        <button
          type="button"
          className={four && bar !== 'past' ? 'btn sm' : 'btn sm dis'}
          aria-disabled={!(four && bar !== 'past') || undefined}
          data-ctl="CTL-OFC-12-05"
          onClick={() => (four && bar !== 'past' ? on.onAsk?.('two_hour') : undefined)}
        >
          {t('windows.back')}
        </button>
        {sat ? <span id="bw-win-sat" className="r1-note bw-win-sat">{t('windows.sat')}</span> : null}
      </div>
    </div>
  );
}

/** SCR-OFC-24: the confirm for 1 day (DK-34): Cancel has the first focus, Escape cancels; a switch to 4-hour windows needs its reason. */
export function SwitchDialog({ data, dlg, on, inline }: { data: Settings; dlg: DialogUi; on: WindowsHandlers; inline?: boolean }) {
  const t = useT();
  const four = dlg.mode === 'four_hour';
  const day = dayText(t, dlg.date);
  const windows = joinSpans(t, four ? data.fourHourWindows : data.twoHourWindows);
  const booked = data.days.find((d) => d.date === dlg.date)?.bookedCount ?? 0;
  const empty = dlg.reason.trim() === '';
  const blocked = dlg.switching || (four && empty);
  const msg = `${t(four ? 'windows.dlg.msg.four' : 'windows.dlg.msg.two', { day, windows })}${booked > 0 ? ` ${t('windows.kv.kept', { count: booked })}` : ''}`;
  return (
    <Dialog
      screen="SCR-OFC-24"
      {...(inline ? { inline: true } : {})}
      title={t(four ? 'windows.dlg.title.four' : 'windows.dlg.title.two', { day })}
      // F-778: the close x and the Cancel button both carry CTL-OFC-24-03 on purpose; the frame (docs/design/kit.json) puts the one id on both, and both do "Closes with no change"
      closeCtl="CTL-OFC-24-03"
      onClose={dlg.switching ? () => {} : () => on.onCancel?.()}
      body={
        <>
          <p data-ctl="CTL-OFC-24-01">{msg}</p>
          {four ? (
            <div className="r1-field" data-ctl="CTL-OFC-24-04">
              <label htmlFor="bw-dlg-reason">{t('windows.dlg.reason')}</label>
              <input
                id="bw-dlg-reason"
                className="r1-input"
                autoComplete="off"
                maxLength={120}
                placeholder={t('windows.reason.ph')}
                value={dlg.reason}
                aria-invalid={(dlg.touched && empty) || undefined}
                onChange={(e) => on.onDialogReason?.(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !blocked) on.onSwitch?.();
                }}
              />
              {dlg.touched && empty ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{t('windows.dlg.reason.empty')}</div> : null}
            </div>
          ) : null}
          {dlg.message ? <p className="r1-fmsg" role="alert"><Icon name="alert" />{dlg.message}</p> : null}
        </>
      }
      foot={
        <>
          <button type="button" className={dlg.switching ? 'btn dis' : 'btn'} aria-disabled={dlg.switching || undefined} data-initial data-ctl="CTL-OFC-24-03" onClick={dlg.switching ? undefined : () => on.onCancel?.()}>
            {t('windows.dlg.cancel')}
          </button>
          <button
            type="button"
            className={dlg.switching ? 'btn busy primary' : blocked ? 'btn primary dis' : 'btn primary'}
            aria-busy={dlg.switching || undefined}
            aria-disabled={(blocked && !dlg.switching) || undefined}
            data-ctl="CTL-OFC-24-02"
            onClick={blocked ? undefined : () => on.onSwitch?.()}
          >
            {dlg.switching ? <BusyLabel>{t('windows.dlg.switching')}</BusyLabel> : t('windows.dlg.switch')}
          </button>
        </>
      }
    />
  );
}

export function PickedBody({ data, ui, on }: { data: Settings; ui: WindowsUi; on: WindowsHandlers }) {
  const day = pickedOf(data.days, ui.picked, data.today);
  return day ? <PickedDay data={data} day={day} ui={ui} on={on} /> : null;
}

export function CalendarBody({ data, ui, on }: { data: Settings; ui: WindowsUi; on: WindowsHandlers }) {
  const t = useT();
  const picked = pickedOf(data.days, ui.picked, data.today);
  const dows = [1, 2, 3, 4, 5, 6, 7];
  return (
    <div className="cal" data-ctl="CTL-OFC-12-03">
      <div className="dow">{dows.map((n) => <span key={n}>{t(`time.weekday.${n}` as MessageKey)}</span>)}</div>
      <div role="group" aria-label={t('windows.cal.label')} data-ctl="CTL-OFC-12-11">
        {weeksOf(data.days).map((w) => (
          <div key={w[0]!.date} className="wk">
            {w.map((d) => <DayButton key={d.date} day={d} today={data.today} picked={picked?.date === d.date} on={on} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The page below the admin menu: the header with the branch tabs, Discard and Save changes, then the 3 panels. */
export function WindowsBody({ state, ui, on, branch }: { state: WindowsState; ui: WindowsUi; on: WindowsHandlers; branch: string }) {
  const t = useT();
  const ready = state.kind === 'ready' ? state.data : null;
  const d = ready ? draftState(ready.windows, ui.draft) : null;
  const canSave = Boolean(d?.canSave) && !ui.saving;
  const name = branchById(branch).name;
  const head = (
    <div className="ah">
      <div>
        <h1>{t('windows.title')}</h1>
        <p>{t('windows.sub')}</p>
      </div>
      <div className="acts">
        <div className="seg" role="tablist" aria-label={t('windows.branch.label')} data-ctl="CTL-OFC-12-08">
          {BRANCHES.map((b) => (
            <span
              key={b.id}
              className={b.id === branch ? 'on' : undefined}
              role="tab"
              aria-selected={b.id === branch}
              tabIndex={b.id === branch ? 0 : -1}
              onClick={() => (b.id === branch ? undefined : on.onBranch?.(b.id))}
              onKeyDown={(e) => keyOf(e, () => (b.id === branch ? undefined : on.onBranch?.(b.id)))}
            >
              {b.name}
            </span>
          ))}
        </div>
        {d?.changed && !ui.saving ? <span className="unsaved"><Icon name="alert" />{t('windows.unsaved')}</span> : null}
        <button type="button" className={d?.changed && !ui.saving ? 'btn' : 'btn dis'} aria-disabled={!d?.changed || ui.saving || undefined} data-ctl="CTL-OFC-12-07" onClick={d?.changed && !ui.saving ? on.onDiscard : undefined}>
          {t('windows.discard')}
        </button>
        <button
          type="button"
          className={ui.saving ? 'btn busy primary' : canSave ? 'btn primary' : 'btn primary dis'}
          aria-busy={ui.saving || undefined}
          aria-disabled={!canSave || undefined}
          data-ctl="CTL-OFC-12-06"
          onClick={canSave ? on.onSave : undefined}
        >
          {ui.saving ? <span className="r1-spin" /> : <Icon name="check" />}
          {ui.saving ? t('windows.saving') : t('windows.save')}
        </button>
        {ui.saveMessage ? <span className="r1-fmsg" role="alert">{ui.saveMessage}</span> : null}
      </div>
    </div>
  );

  if (!ready) {
    return (
      <div className="main">
        {head}
        <div className="body">
          {state.kind === 'loading' ? <Skeleton rows={5} /> : <ErrorPanel title={t('windows.error.title')} hint={t('shell.error.checkConnection')} onRetry={() => on.onRetry?.()} />}
        </div>
      </div>
    );
  }
  return (
    <div className="main">
      {head}
      <div className="body">
        <section className="panel">
          <div className="ph"><h3>{t('windows.two.title', { branch: name })}</h3><span className="s">{t('windows.two.sub')}</span></div>
          <WindowsTable data={ready} ui={ui} on={on} />
          <div className="note" data-ctl="CTL-OFC-12-09"><Icon name="info" /><span>{t('windows.note')}</span></div>
        </section>
        <section className="panel">
          <div className="ph"><h3>{t('windows.rules.title')}</h3><span className="s">{t('windows.rules.sub')}</span></div>
          <Rules data={ready} />
        </section>
        <section className="panel wide">
          <div className="ph">
            <h3>{t('windows.peak.title')}</h3>
            <span className="s">{t('windows.peak.sub')}</span>
            <div className="legend2" data-ctl="CTL-OFC-12-10">
              <span><i className="bw-lg-two" />{t('windows.legend.two')}</span>
              <span><i className="bw-lg-four" />{t('windows.legend.four')}</span>
              <span><i className="bw-lg-off" />{t('windows.legend.closed')}</span>
            </div>
          </div>
          <div className="peakin">
            <CalendarBody data={ready} ui={ui} on={on} />
            <PickedBody data={ready} ui={ui} on={on} />
          </div>
        </section>
      </div>
      {ui.toast ? <ToastView text={ui.toast} /> : null}
      {ui.dialog ? <SwitchDialog data={ready} dlg={ui.dialog} on={on} /> : null}
    </div>
  );
}

/** The admin frame around the body: demo strip, top bar, the admin menu, the footer. `frame` is a preview's fixed chrome. */
export function WindowsView({ state, ui, on, branch, frame }: { state: WindowsState; ui: WindowsUi; on: WindowsHandlers; branch: string; frame?: Frame }): ReactNode {
  return (
    <AdminFrame screen="SCR-OFC-12" currentPath="/office/admin/windows" {...(frame ?? {})}>
      <WindowsBody state={state} ui={ui} on={on} branch={branch} />
    </AdminFrame>
  );
}
