// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-17 Admin: demo clock, and SCR-OFC-27 Reset the demo world (frame mockups/pages/r1-admin-clock.html, DK-103): the shared clock
// (API-10), a jump to a typed time or a preset (API-11, API-12; FR-DEMO-5), Pause and Resume (API-13), the replay's progress, and Reset
// the demo world with its confirm step and cool-down (API-14; UC-10, FR-DEMO-6). Managers only (the page gate). FR-DEMO-2: the shown time
// is API-10's anchor advanced by the monotonic time since the read, never the device clock.
import '../shell/css/office.ts';
import '../../styles/page-admin-clock.css';
import '../../styles/page-admin-clock-app.css';
import { clockPresets, jumpClock, pauseClock, readClock, resetWorldRow, subscribeEvents, type PresetId } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { dateParts, formatTime, fromWire, zoneAbbreviation, type Instant } from '@bw/time';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { BusyLabel, call, Dialog, Fill } from '../import/ui.tsx';
import { useAnnounce } from '../shell/Announcer.tsx';
import { advance, toView, type ClockAnswer, type ClockView } from '../shell/clock.ts';
import type { AppInfo } from '../shell/Footer.tsx';
import { AdminSide } from '../shell/Headers.tsx';
import { Icon } from '../shell/Icon.tsx';
import { useT, type ClientT } from '../shell/intl.tsx';
import { useMe } from '../shell/me.ts';
import { OfficeTopBar, type Me, type OfficeTopBarProps } from '../shell/OfficeTopBar.tsx';
import { ErrorPanel } from '../shell/Panels.tsx';
import type { Reader } from '../shell/reads.ts';
import { Screen } from '../shell/Surface.tsx';
import { IDLE_UI, type ClockState, type ClockUi } from './state.ts';
import { cooldownMinutes, defaultFields, movesOff, presetOff, progressShown, progressWidth, refusalKey, resetOff, RESET_TARGET, shortWhen, typedMove, type Place } from './model.ts';

export type { ClockState, ClockUi, Part } from './state.ts';

export interface ClockActions {
  onDate: (v: string) => void;
  onTime: (v: string) => void;
  onJump: () => void;
  onPreset: (id: PresetId) => void;
  onPause: () => void;
  onAskReset: () => void;
  onKeep: () => void;
  onReset: () => void;
  onRetry: () => void;
}
const NOOP: ClockActions = { onDate: () => {}, onTime: () => {}, onJump: () => {}, onPreset: () => {}, onPause: () => {}, onAskReset: () => {}, onKeep: () => {}, onReset: () => {}, onRetry: () => {} };

interface Frame {
  me?: Me;
  clock?: ClockAnswer | null;
  appInfo?: AppInfo | null;
  reader?: Reader | false;
  bar?: Omit<OfficeTopBarProps, 'me'>;
}

/** The same notes the frame prints under each preset: the first 2 name their time. */
const PRESET_NOTE: Record<PresetId, MessageKey> = {
  reminder_6pm: 'admin.clock.pre.reminder_6pm',
  tomorrow_8am: 'admin.clock.pre.tomorrow_8am',
  sat_oct_31: 'admin.clock.pre.sat_oct_31',
  sun_nov_1: 'admin.clock.pre.sun_nov_1',
  sat_mar_13_2027: 'admin.clock.pre.sat_mar_13_2027',
  sun_mar_14_2027: 'admin.clock.pre.sun_mar_14_2027',
};

function nowText(at: Instant, zone: string, t: ClientT): string {
  const p = dateParts(at, zone);
  return t('admin.clock.now', {
    weekday: t(`time.weekday.${p.weekday}` as MessageKey),
    month: t(`time.month.${p.month}` as MessageKey),
    day: p.day,
    year: p.year,
    time: formatTime(at, zone, t.lang),
    zone: zoneAbbreviation(at, zone),
  });
}

function Skeleton() {
  return (
    <div className="bw-padb" aria-busy="true">
      <span className="r1-skel bw-skel-60" />
      <span className="r1-skel bw-w-40" />
    </div>
  );
}

function Refusal({ text }: { text: string }) {
  return (
    <div className="r1-fmsg" role="alert">
      <Icon name="alert" />
      {text}
    </div>
  );
}

function lastMoveLine(a: ClockAnswer, zone: string, t: ClientT): ReactNode {
  const m = a.lastMove;
  if (!m) return null;
  const when = shortWhen(fromWire(m.toDemo).toInstant(), zone, t.lang, t);
  const key: MessageKey = m.by === 'nightly' ? 'admin.clock.lm.nightly' : m.by === 'idle' ? 'admin.clock.lm.idle' : (`admin.clock.lm.${m.kind}` as MessageKey);
  const person = m.by !== 'nightly' && m.by !== 'idle';
  return t.rich(key, { name: m.by, when, b: (chunks) => (person ? <b translate="no">{chunks}</b> : <b>{chunks}</b>) });
}

export interface ClockViewProps {
  state: ClockState;
  ui?: ClockUi;
  /** The shown demo time, advanced from API-10's anchor by the caller. */
  at?: Instant | null;
  /** Seconds of the cool-down left now (counted down by the caller). */
  left?: number;
  actions?: ClockActions;
  frame?: Frame;
}

export function ClockView({ state, ui = IDLE_UI, at = null, left = 0, actions = NOOP, frame = {} }: ClockViewProps) {
  const t = useT();
  const me = useMe(frame.reader, frame.me);
  const changeHref = me?.permissions.includes('SCR-OFC-17') ? '/office/admin/clock' : null;
  const a = state.clock.kind === 'ready' ? state.clock.data : null;
  const view = a ? toView(a) : null;
  const zone = view?.zone ?? 'America/New_York';
  const shown = at ?? view?.at ?? null;
  const off = a ? movesOff(a) : null;
  const rOff = a ? resetOff({ ...a, resetAvailableInSeconds: left }) : null;
  const resetWhen = shortWhen(fromWire(RESET_TARGET).toInstant(), 'America/New_York', t.lang, t);
  const busy = ui.busy !== null;
  const offAll = off !== null || busy;

  const body = (
    <div className="body">
      <div className="infobox2 note17" data-ctl="CTL-OFC-17-09">
        <Icon name="info" />
        <span>{t('admin.clock.note')}</span>
      </div>
      {state.clock.kind === 'loading' ? (
        <section className="panel now" aria-busy="true">
          <Skeleton />
        </section>
      ) : null}
      {state.clock.kind === 'error' ? (
        <section className="panel now">
          <div className="bw-padb">
            <ErrorPanel title={t('admin.clock.readFailed')} hint={t('shell.error.checkConnection')} onRetry={actions.onRetry} />
          </div>
        </section>
      ) : null}
      {a && view && shown ? (
        <>
          <section className="panel now">
            <div>
              <div className="big" data-ctl="CTL-OFC-17-01">
                {nowText(shown, zone, t)}{' '}
                <span className={a.paused ? 'chip warn bw-vam' : 'chip ok bw-vam'}>
                  <span className="dot" />
                  {t(a.paused ? 'status.clock.paused' : 'status.clock.running')}
                </span>
              </div>
              {a.lastMove ? (
                <div className="lm" data-ctl="CTL-OFC-17-02">
                  {lastMoveLine(a, zone, t)}
                </div>
              ) : null}
              {a.replay?.running ? (
                <div className="bw-prog" data-ctl={progressShown(a) ? 'CTL-OFC-17-07' : undefined}>
                  {progressShown(a) ? (
                    <>
                      <b className="bw-fs14">{t('admin.clock.progress', { done: a.replay.done, total: a.replay.total })}</b>
                      <div className="bar" role="progressbar" aria-valuenow={a.replay.done} aria-valuemin={0} aria-valuemax={a.replay.total} aria-label={t('admin.clock.progressLabel')}>
                        <Fill width={progressWidth(a.replay.done, a.replay.total)} />
                      </div>
                    </>
                  ) : null}
                  <p id="bw-clock-catching" className="r1-note bw-n-t6">
                    {t('admin.clock.err.catchingUp')}
                  </p>
                </div>
              ) : null}
              {ui.refused?.place === 'pause' ? <Refusal text={ui.refused.text} /> : null}
            </div>
            <div className="acts">
              <button
                type="button"
                className={offAll ? 'btn lg dis' : 'btn lg'}
                aria-disabled={offAll ? true : undefined}
                aria-describedby={off ? 'bw-clock-catching' : undefined}
                data-ctl="CTL-OFC-17-05"
                onClick={offAll ? undefined : actions.onPause}
              >
                <Icon name="clock" />
                {t(a.paused ? 'admin.clock.resume' : 'admin.clock.pause')}
              </button>
            </div>
          </section>
          <section className="panel pp">
            <div className="ph">
              <h3>{t('admin.clock.jump.title')}</h3>
              <span className="s">{t('admin.clock.jump.hint')}</span>
            </div>
            <div className="in" data-ctl="CTL-OFC-17-03">
              <div className="row3">
                <div className="r1-field">
                  <label htmlFor="bw-clock-date">{t('admin.clock.date')}</label>
                  <div className="r1-input">
                    <Icon name="calendar" />
                    <input id="bw-clock-date" type="date" className="bw-field-input" value={ui.date} onChange={(e) => actions.onDate(e.target.value)} />
                  </div>
                </div>
                <div className="r1-field">
                  <label htmlFor="bw-clock-time">{t('admin.clock.time')}</label>
                  <div className={ui.refused?.place === 'jump' ? 'r1-input bad' : 'r1-input'}>
                    <Icon name="clock" />
                    <input id="bw-clock-time" type="time" className="bw-field-input" value={ui.time} onChange={(e) => actions.onTime(e.target.value)} />
                  </div>
                </div>
                <button
                  type="button"
                  className={offAll ? 'btn primary lg dis' : 'btn primary lg'}
                  aria-disabled={offAll ? true : undefined}
                  aria-describedby={off ? 'bw-clock-catching' : undefined}
                  onClick={offAll ? undefined : actions.onJump}
                >
                  {t('admin.clock.jump.go')}
                </button>
              </div>
              {ui.refused?.place === 'jump' ? <Refusal text={ui.refused.text} /> : null}
            </div>
          </section>
          <section className="panel pp">
            <div className="ph">
              <h3>{t('admin.clock.presets.title')}</h3>
              <span className="s">{t('admin.clock.presets.hint')}</span>
            </div>
            {state.presets.kind === 'loading' ? <Skeleton /> : null}
            {state.presets.kind === 'error' ? (
              <div className="bw-padb">
                <ErrorPanel title={t('admin.clock.presetsFailed')} hint={t('shell.error.checkConnection')} onRetry={actions.onRetry} />
              </div>
            ) : null}
            {state.presets.kind === 'ready' ? (
              <div className="presets" data-ctl="CTL-OFC-17-04">
                {state.presets.data.map((p) => {
                  const early = presetOff(p);
                  const dis = early || offAll;
                  const tgt = fromWire(p.target);
                  const when = shortWhen(tgt.toInstant(), tgt.timeZoneId, t.lang, t);
                  return (
                    <button
                      type="button"
                      key={p.presetId}
                      className={dis ? 'pre dis' : 'pre'}
                      aria-disabled={dis ? true : undefined}
                      aria-describedby={off && !early ? 'bw-clock-catching' : undefined}
                      data-preset={p.presetId}
                      onClick={dis ? undefined : () => actions.onPreset(p.presetId)}
                    >
                      <b>{t(p.labelKey as MessageKey)}</b>
                      <span>{early ? t('admin.clock.err.earlier') : t(PRESET_NOTE[p.presetId], { when })}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {ui.refused?.place === 'presets' ? (
              <div className="bw-presets-msg">
                <Refusal text={ui.refused.text} />
              </div>
            ) : null}
          </section>
          <section className="panel reset">
            <span className="tx">
              <b>{t('admin.clock.reset.title')}</b>
              {t('admin.clock.reset.text')}
              {ui.refused?.place === 'reset' ? <Refusal text={ui.refused.text} /> : null}
            </span>
            <div className="bw-reset-act">
              <button
                type="button"
                className={rOff ? 'btn lg dis' : 'btn lg warnb'}
                aria-disabled={rOff ? true : undefined}
                aria-describedby={rOff === 'catching_up' ? 'bw-clock-catching' : rOff === 'cooldown' ? 'bw-clock-next' : undefined}
                data-ctl="CTL-OFC-17-06"
                onClick={rOff ? undefined : actions.onAskReset}
              >
                {rOff ? null : <Icon name="refresh" />}
                {t('admin.clock.reset.button', { when: resetWhen })}
              </button>
              {rOff === 'cooldown' ? (
                <p id="bw-clock-next" className="r1-note bw-n-t6" data-ctl="CTL-OFC-17-08">
                  {t('admin.clock.next', { minutes: cooldownMinutes(left) })}
                </p>
              ) : null}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );

  return (
    <Screen
      screen="SCR-OFC-17"
      surface="SURF-OFC"
      changeHref={changeHref}
      live={me !== null}
      title={t('admin.clock.doc')}
      {...(frame.clock !== undefined ? { clock: frame.clock } : {})}
      {...(frame.appInfo !== undefined ? { appInfo: frame.appInfo } : {})}
      {...(frame.reader !== undefined ? { reader: frame.reader } : {})}
      {...(ui.resetTo !== undefined ? { resetTo: ui.resetTo } : {})}
    >
      {me ? <OfficeTopBar me={me} {...(frame.reader !== undefined && frame.reader !== false ? { reader: frame.reader } : {})} {...frame.bar} /> : null}
      <div className="shell">
        <AdminSide permissions={me?.permissions ?? []} currentPath="/office/admin/clock" />
        <div className="mainc">
          <div className="ah">
            <div>
              <h1>{t('admin.clock.title')}</h1>
              <p>{t('admin.clock.sub')}</p>
            </div>
          </div>
          {body}
        </div>
      </div>
      {ui.dialog ? <ResetDialog ui={ui} actions={actions} resetWhen={resetWhen} /> : null}
    </Screen>
  );
}

/** SCR-OFC-27: Keep the world has the first focus; Escape keeps the world; Reset the world is the destructive primary. */
export function ResetDialog({ ui, actions = NOOP, resetWhen }: { ui: ClockUi; actions?: ClockActions; resetWhen: string }) {
  const t = useT();
  return (
    <Dialog
      screen="SCR-OFC-27"
      {...(ui.inline ? { inline: true } : {})}
      title={t('admin.clock.dlg.title')}
      closeCtl="CTL-OFC-27-03"
      onClose={ui.resetting ? () => {} : actions.onKeep}
      body={
        <>
          <p data-ctl="CTL-OFC-27-01">{t('admin.clock.dlg.message', { when: resetWhen })}</p>
          {ui.dialogMessage ? <p role="alert">{ui.dialogMessage}</p> : null}
        </>
      }
      foot={
        <>
          <button type="button" className={ui.resetting ? 'btn dis' : 'btn'} aria-disabled={ui.resetting ? true : undefined} data-initial data-ctl="CTL-OFC-27-03" onClick={ui.resetting ? undefined : actions.onKeep}>
            {t('admin.clock.dlg.keep')}
          </button>
          <button type="button" className={ui.resetting ? 'btn busy danger' : 'btn danger'} aria-busy={ui.resetting ? true : undefined} data-ctl="CTL-OFC-27-02" onClick={ui.resetting ? undefined : actions.onReset}>
            {ui.resetting ? <BusyLabel>{t('admin.clock.dlg.resetting')}</BusyLabel> : t('admin.clock.dlg.reset')}
          </button>
        </>
      }
    />
  );
}

const TICK_MS = 1_000;
const REPLAY_POLL_MS = 1_000;
const SLOW_POLL_MS = 60_000;
const now = () => performance.now();

/** The page: API-10 and API-11 for the reads, API-12, API-13 and API-14 for the moves, and the event stream (EVT-05, EVT-06) for live. */
export function ClockScreen() {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const announce = useAnnounce();
  const [state, setState] = useState<ClockState>({ clock: { kind: 'loading' }, presets: { kind: 'loading' } });
  const [ui, setUi] = useState<ClockUi>(IDLE_UI);
  const [, setTick] = useState(0);
  const readAt = useRef(0);
  const view = useRef<ClockView | null>(null);
  const fields = useRef(false);
  const left0 = useRef(0);

  const readClockNow = useCallback(async (): Promise<ClockAnswer | null> => {
    const r = await call(readClock);
    if (!r.ok) {
      setState((s) => (s.clock.kind === 'ready' ? s : { ...s, clock: { kind: 'error' } }));
      return null;
    }
    const a = r.data as ClockAnswer;
    readAt.current = now();
    left0.current = a.resetAvailableInSeconds ?? 0;
    view.current = toView(a);
    setState((s) => ({ ...s, clock: { kind: 'ready', data: a } }));
    if (!fields.current) {
      fields.current = true;
      const f = defaultFields(view.current.at, view.current.zone);
      setUi((u) => ({ ...u, date: f.date, time: f.time }));
    }
    return a;
  }, []);
  const readPresets = useCallback(async () => {
    const r = await call(clockPresets);
    setState((s) => ({ ...s, presets: r.ok ? { kind: 'ready', data: r.data.presets } : { kind: 'error' } }));
  }, []);
  const readAll = useCallback(async () => {
    await Promise.all([readClockNow(), readPresets()]);
  }, [readClockNow, readPresets]);

  useEffect(() => {
    void readAll();
    const slow = window.setInterval(() => void readAll(), SLOW_POLL_MS);
    const onFocus = () => void readAll();
    window.addEventListener('focus', onFocus);
    const stream = subscribeEvents({
      onEvent: (e) => {
        if (e.name === 'clock.changed') void readAll();
        if (e.name === 'world.reset') {
          setUi((u) => ({ ...u, dialog: false, resetting: false, dialogMessage: null, refused: null, resetTo: RESET_TARGET }));
          void readAll();
        }
      },
      onReconnect: () => void readAll(),
    });
    return () => {
      window.clearInterval(slow);
      window.removeEventListener('focus', onFocus);
      stream.close();
    };
  }, [readAll]);

  // The shown time and the cool-down move once a second, and a running replay is re-read every second (the progress).
  const a = state.clock.kind === 'ready' ? state.clock.data : null;
  const have = a !== null;
  const running = Boolean(a?.replay?.running);
  const paused = a?.paused ?? false;
  useEffect(() => {
    if (!have) return;
    const tick = window.setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => window.clearInterval(tick);
  }, [have, paused]);
  useEffect(() => {
    if (!running) return;
    const poll = window.setInterval(() => void readClockNow(), REPLAY_POLL_MS);
    return () => window.clearInterval(poll);
  }, [running, readClockNow]);

  const elapsed = now() - readAt.current;
  const at = view.current ? advance(view.current, readAt.current === 0 ? 0 : elapsed) : null;
  const left = Math.max(0, Math.ceil(left0.current - (readAt.current === 0 ? 0 : elapsed) / 1000));

  const refuse = (place: Place, code: string, minutes?: number) =>
    setUi((u) => ({ ...u, busy: null, refused: { place, text: tRef.current(refusalKey(code), { minutes: minutes ?? 5 }) } }));

  const move = async (place: Place, run: () => Promise<{ ok: true } | { ok: false; code: string }>) => {
    if (ui.busy) return;
    setUi((u) => ({ ...u, busy: place, refused: null }));
    const r = await run();
    if (r.ok) {
      // A new move replaces the world reset notice in the strip (CTL-CMP-02-03 gives way to CTL-CMP-02-01).
      setUi((u) => ({ ...u, busy: null, resetTo: null }));
      await readAll();
    } else {
      const fresh = await readClockNow();
      refuse(place, r.code, fresh ? cooldownMinutes(fresh.resetAvailableInSeconds ?? 0) : undefined);
    }
  };

  const actions: ClockActions = {
    onDate: (v) => setUi((u) => ({ ...u, date: v, refused: null })),
    onTime: (v) => setUi((u) => ({ ...u, time: v, refused: null })),
    onJump: () => {
      const v = view.current;
      if (!v || !at) return;
      const m = typedMove(ui.date, ui.time, v.zone, at);
      // An empty field or a time that is not after the clock is refused here, with no call (CTL-OFC-17-03).
      if (!m.ok) return refuse('jump', m.why === 'not_forward' ? 'not_forward' : 'bad_time');
      void move('jump', async () => {
        const r = await call(jumpClock, { to: m.wire });
        return r.ok ? { ok: true } : { ok: false, code: r.code };
      });
    },
    onPreset: (id) =>
      void move('presets', async () => {
        const r = await call(jumpClock, { presetId: id });
        return r.ok ? { ok: true } : { ok: false, code: r.code };
      }),
    onPause: () =>
      void move('pause', async () => {
        const r = await call(pauseClock, { paused: !paused });
        return r.ok ? { ok: true } : { ok: false, code: r.code };
      }),
    onAskReset: () => setUi((u) => ({ ...u, dialog: true, dialogMessage: null, refused: null })),
    onKeep: () => setUi((u) => ({ ...u, dialog: false, dialogMessage: null })),
    onReset: async () => {
      if (ui.resetting) return;
      setUi((u) => ({ ...u, resetting: true, dialogMessage: null }));
      const r = await call(resetWorldRow);
      if (r.ok) {
        setUi((u) => ({ ...u, resetting: false, dialog: false }));
        announce(t('admin.clock.toast.reset'));
        await readAll();
      } else {
        const fresh = await readClockNow();
        const minutes = fresh ? cooldownMinutes(fresh.resetAvailableInSeconds ?? 0) : 5;
        setUi((u) => ({ ...u, resetting: false, dialogMessage: tRef.current(refusalKey(r.code), { minutes }) }));
      }
    },
    onRetry: () => void readAll(),
  };
  return <ClockView state={state} ui={ui} at={at} left={left} actions={actions} />;
}
