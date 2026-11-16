// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-02 Today as DK-117 option B draws it (mockups/pages/r1-ios-b.html), its state content from DK-106 to DK-108 (ruling D5b-1): the
// teal bar with the sync pill, the refresh button, the date, the van and the day's progress; the done rows, the next job card and Later
// today; and the frames' other states. A pure view: the container (TodayScreen.tsx) reads the day and the item engine. Every tagged
// view's id is its testID and its name in the look dump (ci/look-values/native-today-cases.ts).
import type { TodayAnswer } from '@bw/api';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import { fromWire } from '@bw/time';
import { useState, type ReactNode } from 'react';
import { Pressable, RefreshControl, ScrollView, StatusBar, StyleSheet, View } from 'react-native';
import { T as Text, useBigText } from '../../ui/text-size.tsx';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '../../ui/Icon.tsx';
import type { NativeIcon } from '../../ui/icon-paths.ts';
import { useT, type T } from '../../ui/intl.tsx';
import { useLastTry } from '../../ui/last-try.ts';
import { lk } from '../../ui/look.ts';
import { color, type } from '../../ui/tokens.ts';
import { tone } from './palette.ts';
import {
  canStartWay, dayLabel, ENDED, equipmentText, firstName, lastVisitDate, leaveNowLine, nextJob, progress, serviceIcon, showsNoSaved, surname, timeOf, windowLabel,
  type LocalJob, type TodayState,
} from './model.ts';
import type { Notice } from '../mapme/reads.ts';

/** The card's 3 confirm steps (SCR-TEC-03 On my way, SCR-TEC-13 Arrived, SCR-TEC-14 No one home). */
export type SheetKind = 'omw' | 'arrived' | 'noh';

export interface TodayViewProps {
  state: TodayState;
  day: TodayAnswer | null;
  jobs: LocalJob[];
  lang: 'en' | 'es';
  online: boolean;
  /** The demo time the saved list was read (wire time): "Last updated". */
  savedAt: string | null;
  /** The last read failed: CMP-12 above the saved list (F-1019). */
  failed: boolean;
  /** The items waiting on the phone, a damaged one included (core.ts waitingTotal, F-985). */
  waiting: number;
  /** The item store has been read (F-984: no sync verdict before it). */
  ready: boolean;
  oldCount: number;
  notices: Notice[];
  /** A short announcement (CMP-10-04 "3 items sent", or the not-ready line). */
  toast: string | null;
  driveMinutes: number | null;
  refreshing: boolean;
  onRefresh: () => void;
  /** CTL-CMP-10-02: the sync pill opens SCR-TEC-09 Waiting to send. */
  onWaiting: () => void;
  onOpenSheet: (kind: SheetKind, job: LocalJob) => void;
  onJob: (job: LocalJob, history: boolean) => void;
  onDirections: (job: LocalJob) => void;
  onFinish: (job: LocalJob) => void;
  onCall: (phone: string) => void;
}

// ---- small parts ---------------------------------------------------------------------------------------------------------------

/** .st: the status word in its pill (sched, way, done). */
function Chip(props: { id: string; status: LocalJob['status']; label: string }) {
  const k = props.status === 'scheduled' ? s.stSched : props.status === 'on_the_way' ? s.stWay : s.stDone;
  const ink = props.status === 'scheduled' ? s.stSchedText : props.status === 'on_the_way' ? s.stWayText : s.stDoneText;
  return (
    <View {...lk(props.id, [s.st, k])}>
      <Text {...lk(`${props.id}.text`, ink)}>{props.label}</Text>
    </View>
  );
}

/** .wait: Waiting to send (clock) or Sent (check) next to a status (DK-109). */
function Waiting(props: { id: string; pending: boolean; sent: boolean }) {
  const t = useT();
  if (!props.pending && !props.sent) return null;
  return (
    <View {...lk(props.id, [s.wait, props.sent ? s.waitSent : null])}>
      <Text {...lk(`${props.id}.text`, props.sent ? s.waitSentText : s.waitText)}>{t(props.sent ? 'tech.item.sent' : 'tech.item.waiting')}</Text>
    </View>
  );
}

function Num(props: { id: string; children?: ReactNode; kind?: 'ok' | 'way' | 'sk' | 'next' }) {
  const box = props.kind === 'ok' ? s.numOk : props.kind === 'way' ? s.numWay : props.kind === 'sk' ? s.numSk : props.kind === 'next' ? s.numNext : null;
  const ink = props.kind === 'ok' ? s.numOkText : props.kind === 'way' ? s.numWayText : props.kind === 'next' ? s.numNextText : s.numText;
  return (
    <View {...lk(props.id, [s.num, box])}>
      {props.kind === 'ok' ? <Icon id={`${props.id}.icon`} name="check" size={15} color={color.white} strokeWidth={3} /> : props.children !== undefined ? <Text {...lk(`${props.id}.text`, ink)}>{props.children}</Text> : null}
    </View>
  );
}

function Group(props: { id: string; children: ReactNode }) {
  return <View {...lk(props.id, s.grp)}>{props.children}</View>;
}

// ---- header ------------------------------------------------------------------------------------------------------------------

/** The teal bar: Today, the sync pill and Refresh (CTL-TEC-02-08), then the date, the van and the progress (CTL-TEC-02-10). */
function Header(p: TodayViewProps) {
  const t = useT();
  const top = useSafeAreaInsets().top;
  const known = p.ready && p.state !== 'loading';
  const pr = progress(p.jobs);
  const zone = p.day?.zone ?? 'America/New_York';
  const when = p.day ? `${dayLabel(p.day.date, t)}, ${timeOf(p.day.asOf, zone, p.lang)}` : '';
  const parts = p.day ? [when, p.day.van ? t('tech.today.van', { van: p.day.van.number }) : null, t('tech.today.progress', { done: pr.done, total: pr.total })] : [];
  const sub = parts.filter(Boolean).join(' - ');
  const line = p.waiting > 0 ? t('tech.sync.waiting', { n: p.waiting }) : t('tech.sync.allSynced');
  const fill = pr.total === 0 ? 0 : pr.done / pr.total;
  return (
    <View {...lk('today.nav', [s.nav, { paddingTop: top + 2 }])}>
      <StatusBar barStyle="light-content" />
      <View {...lk('today.navrow', s.navrow)}>
        <Text {...lk('today.title', s.title)} accessibilityRole="header">{t('tech.tab.today')}</Text>
        {/* The pill and its words both open Waiting to send; the words stay their own element, so the count is read as it shows. */}
        <Pressable {...lk('today.sync', s.sync)} onPress={p.onWaiting} accessible={false}>
          <Icon id="today.sync.icon" name="cloud" size={16} color={tone.syncDot} />
          <Text {...lk('sync.count', s.syncText)} accessibilityRole="button" accessibilityLabel={known ? line : ''} onPress={p.onWaiting}>{known ? line : ''}</Text>
        </Pressable>
        <Pressable {...lk('today.refresh', s.navbtn)} onPress={p.onRefresh} accessibilityRole="button" accessibilityLabel={t('tech.today.refresh')}>
          <Icon id="today.refresh.icon" name="refresh" size={22} color={color.white} />
        </Pressable>
      </View>
      <Text {...lk('today.sub', s.sub)} accessibilityLabel={sub}>{sub}</Text>
      <View {...lk('today.prog', s.prog)}>
        <View {...lk('today.prog.fill', [s.progFill, { width: `${Math.round(fill * 100)}%` }])} />
      </View>
    </View>
  );
}

// ---- rows ----------------------------------------------------------------------------------------------------------------------

function DoneRow(props: { j: LocalJob; i: number; zone: string; lang: 'en' | 'es'; t: T; onJob: TodayViewProps['onJob'] }) {
  const { j, i, t } = props;
  const id = `today.done.${i}`;
  const stamp = j.endedAt ?? j.localAt;
  const at = stamp ? timeOf(stamp, props.zone, props.lang) : '';
  const word = j.status === 'no_one_home' ? t('tech.today.noOneHomeAt', { time: at }) : t('tech.today.doneAt', { time: at });
  return (
    <Pressable {...lk(id, [s.row, i > 0 ? s.rowSep : null])} onPress={() => props.onJob(j, false)} accessibilityRole="button" accessibilityLabel={`${surname(j.customer.name)} - ${word}`}>
      <Num id={`${id}.num`} kind="ok" />
      <View style={s.tx}>
        <Text {...lk(`${id}.name`, s.nameDone)}>{surname(j.customer.name)}</Text>
        <Text {...lk(`${id}.area`, s.small)}>{`${j.area} - ${t(j.serviceLabelKey as MessageKey)}`}</Text>
      </View>
      <View {...lk(`${id}.trail`, s.trail)}>
        <Chip id={`${id}.st`} status="done" label={word} />
        <Waiting id={`${id}.wait`} pending={j.pending} sent={j.sent} />
      </View>
    </Pressable>
  );
}

function LaterRow(props: { j: LocalJob; i: number; t: T; onJob: TodayViewProps['onJob'] }) {
  const { j, i, t } = props;
  const id = `today.later.${i}`;
  return (
    <Pressable {...lk(id, [s.row, s.rowLater, i > 0 ? s.rowSep : null])} onPress={() => props.onJob(j, false)} accessibilityRole="button" accessibilityLabel={`${j.position} ${surname(j.customer.name)}`}>
      <Num id={`${id}.num`}>{j.position}</Num>
      <View style={s.tx}>
        <Text {...lk(`${id}.name`, s.name)}>{surname(j.customer.name)}</Text>
        <Text {...lk(`${id}.area`, s.small)}>{`${j.area} - ${t(j.serviceLabelKey as MessageKey)}`}</Text>
      </View>
      <View {...lk(`${id}.trail`, s.trail)}>
        <Text {...lk(`${id}.win`, s.trailWin)}>{windowLabel(j.window.start, j.window.end)}</Text>
        <Chip id={`${id}.st`} status={j.status} label={t(`customers.status.${j.status}` as MessageKey)} />
        <Waiting id={`${id}.wait`} pending={j.pending} sent={j.sent} />
      </View>
      <Icon id={`${id}.chev`} name="chevRight" size={16} color={color.ink400} />
    </Pressable>
  );
}

// ---- the next job card ---------------------------------------------------------------------------------------------------------

function What(props: { id: string; icon: NativeIcon; eta?: boolean; children: ReactNode }) {
  return (
    <View {...lk(props.id, s.what)}>
      <Icon id={`${props.id}.icon`} name={props.icon} size={16} color={props.eta ? color.teal700 : color.ink500} marginTop={1} />
      <Text {...lk(`${props.id}.text`, [props.eta ? s.whatEta : s.whatText, { flexShrink: 1 }])}>{props.children}</Text>
    </View>
  );
}

function NextCard(p: TodayViewProps & { j: LocalJob }) {
  const { j } = p;
  const t = useT();
  const big = useBigText(); // 14.2 item 2: the window wraps under the label and the Directions button stacks its words
  const zone = p.day?.zone ?? 'America/New_York';
  const late = j.lateText;
  const lateCard = late !== null && j.status === 'scheduled';
  const first = firstName(j.customer.name);
  const phone = j.customer.phone?.replace(/[^\d+]/g, '');
  const eta = late ? timeOf(late.eta, zone, p.lang) : null;
  const minLate = late?.wasEta ? Math.round((fromWire(late.eta).toInstant().epochMilliseconds - fromWire(late.wasEta).toInstant().epochMilliseconds) / 60_000) : null;
  const canWay = canStartWay(p.jobs, j);
  const onSite = j.status === 'on_site';
  const statusWord = t(`customers.status.${j.status}` as MessageKey);
  // F-1106: CTL-TEC-02-02's arrival estimate when online (a late card shows the late text's new time instead).
  const leaveNow = lateCard ? null : leaveNowLine(j, p.online, zone, p.lang, t);
  return (
    <View {...lk('today.card', s.card)}>
      <View {...lk('card.lab', [s.lab, big ? s.labBig : null])}>
        <Num id="card.num" kind="next">{j.position}</Num>
        <Text {...lk('card.label', s.labText)}>{t(lateCard ? 'tech.today.nextLate' : 'tech.today.next')}</Text>
        <View {...lk('card.win', s.win)}>
          <Text {...lk('card.win.text', s.winText)}>{windowLabel(j.window.start, j.window.end)}</Text>
        </View>
      </View>
      <View {...lk('card.who', s.who)}>
        <Text {...lk('card.name', s.h2)} accessibilityRole="header">{j.customer.name}</Text>
        <Chip id="card.st" status={j.status} label={statusWord} />
        <Waiting id="card.wait" pending={j.pending} sent={j.sent} />
      </View>
      <Text {...lk('card.addr', s.addr)}>{j.address}</Text>
      <What id="card.what1" icon={serviceIcon(j.serviceLabelKey)}>
        <Text style={s.whatBold}>{t(j.serviceLabelKey as MessageKey)}</Text>
        {j.equipment ? ` - ${equipmentText(j.equipment, t)}` : ''}
      </What>
      {late && lateCard ? (
        <>
          <View {...lk('card.late', s.late)} accessibilityLabel={`${t('tech.today.newArrival')} ${t('tech.today.about', { time: eta ?? '' })}`}>
            <Icon id="card.late.icon" name="alert" size={17} color={tone.riskInk} strokeWidth={2.2} marginTop={1} />
            <Text {...lk('card.late.text', s.lateText)}>
              {`${t('tech.today.newArrival')}  ${t('tech.today.about', { time: eta ?? '' })}`}
              {minLate !== null && minLate > 0 ? `, ${t('tech.today.minLate', { min: minLate })}` : ''}
              {late.wasEta ? `, ${t('tech.today.was', { time: timeOf(late.wasEta, zone, p.lang) })}` : ''}
            </Text>
          </View>
          <View {...lk('card.texted', s.late)}>
            <Icon id="card.texted.icon" name="message" size={17} color={tone.riskInk} marginTop={1} />
            <Text {...lk('card.texted.text', s.lateText)}>{`${t('tech.today.texted', { name: first })}${t('tech.today.textedAt', { time: timeOf(late.sentAt, zone, p.lang) })}`}</Text>
          </View>
        </>
      ) : j.lastVisit ? (
        // See history is its own control after the words (F-1105: a link nested in a line of text is no accessibility element on iOS).
        <View {...lk('card.what2', s.what)}>
          <Icon id="card.what2.icon" name="clock" size={16} color={color.ink500} marginTop={1} />
          <View style={s.whatRun}>
            <Text {...lk('card.what2.text', s.whatText)}>{`${t('tech.today.lastVisit', { date: lastVisitDate(j.lastVisit.date, t) })} - `}</Text>
            <Pressable {...lk('card.history', s.histHit)} onPress={() => p.onJob(j, true)} accessibilityRole="link" accessibilityLabel={t('tech.today.history')}>
              <Text {...lk('card.history.text', s.lnk)}>{t('tech.today.history')}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {leaveNow ? <What id="card.eta" icon="nav" eta>{leaveNow}</What> : null}
      {j.customerNote && !lateCard ? (
        <View {...lk('card.note', s.note)}>
          <Text {...lk('card.note.title', s.noteTitle)}>{t('tech.today.note')}</Text>
          <Text {...lk('card.note.text', s.noteText)}>{j.customerNote}</Text>
        </View>
      ) : null}
      <View {...lk('card.acts', [s.acts, big ? s.actsBig : null])}>
        <Pressable {...lk('card.dir', [s.pbtn, s.pdir, big ? s.pbtnBig : null])} onPress={() => p.onDirections(j)} accessibilityRole="button"
          accessibilityLabel={p.driveMinutes !== null ? `${t('tech.today.directions')} ${t('tech.map.directionsMin', { n: p.driveMinutes })}` : t('tech.today.directions')}>
          <Icon id="card.dir.icon" name="nav" size={19} color={color.teal800} />
          <Text {...lk('card.dir.text', s.pbtnText)}>{t('tech.today.directions')}</Text>
          {p.driveMinutes !== null ? <Text {...lk('card.dir.min', s.pbtnMin)}>{t('tech.map.directionsMin', { n: p.driveMinutes })}</Text> : null}
        </Pressable>
        {phone ? (
          <Pressable {...lk('card.call', [s.pbtn, s.psq])} onPress={() => p.onCall(phone)} accessibilityRole="button" accessibilityLabel={t('tech.today.callAria', { name: first })}>
            <Icon id="card.call.icon" name="phone" size={19} color={color.teal800} />
          </Pressable>
        ) : null}
        <Pressable {...lk('card.open', [s.pbtn, s.psq])} onPress={() => p.onJob(j, false)} accessibilityRole="button" accessibilityLabel={t('tech.today.openJob')}>
          <Icon id="card.open.icon" name="note" size={19} color={color.teal800} />
        </Pressable>
      </View>
      {j.status === 'scheduled' ? (
        <>
          <Pressable {...lk('card.omw', [s.omw, canWay ? null : s.omwOff])} onPress={() => canWay && p.onOpenSheet('omw', j)} disabled={!canWay}
            accessibilityRole="button" accessibilityState={{ disabled: !canWay }}>
            <Icon id="card.omw.icon" name="truck" size={23} color={canWay ? color.white : color.ink500} strokeWidth={2.2} />
            <Text {...lk('card.omw.text', [s.omwText, canWay ? null : { color: color.ink500 }])}>{t('tech.today.onMyWay')}</Text>
          </Pressable>
          <Text {...lk('card.omwnote', s.omwnote)}>{t('tech.today.omwNote', { name: first })}</Text>
        </>
      ) : null}
      {onSite ? (
        <>
          <View {...lk('card.acts2', s.acts2)}>
            <Pressable {...lk('card.finish', [s.sbtn, s.sbtnPri])} onPress={() => p.onFinish(j)} accessibilityRole="button">
              <Text {...lk('card.finish.text', [s.sbtnText, { color: color.white }])}>{t('tech.today.finish')}</Text>
            </Pressable>
            <Pressable {...lk('card.noh', s.sbtn)} onPress={() => p.onOpenSheet('noh', j)} accessibilityRole="button">
              <Text {...lk('card.noh.text', s.sbtnText)}>{t('tech.today.noOneHome')}</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <>
          <View {...lk('card.acts2', s.acts2)}>
            <Pressable {...lk('card.arrived', s.sbtn)} onPress={() => p.onOpenSheet('arrived', j)} accessibilityRole="button">
              <Icon id="card.arrived.icon" name="pin" size={16} color={color.teal700} />
              <Text {...lk('card.arrived.text', s.sbtnText)}>{t('tech.today.arrived')}</Text>
            </Pressable>
            <View {...lk('card.noh', [s.sbtn, s.sbtnOff])} accessibilityRole="button" accessibilityState={{ disabled: true }} accessible accessibilityLabel={t('tech.today.noOneHome')}>
              <Text {...lk('card.noh.text', [s.sbtnText, s.sbtnOffText])}>{t('tech.today.noOneHome')}</Text>
            </View>
            <View {...lk('card.finish', [s.sbtn, s.sbtnOff])} accessibilityRole="button" accessibilityState={{ disabled: true }} accessible accessibilityLabel={t('tech.today.finish')}>
              <Text {...lk('card.finish.text', [s.sbtnText, s.sbtnOffText])}>{t('tech.today.finish')}</Text>
            </View>
          </View>
          <Text {...lk('card.after', s.after)}>{t(j.status === 'on_the_way' && j.pending ? 'tech.today.omwSaved' : 'tech.today.opensAfter')}</Text>
        </>
      )}
    </View>
  );
}

// ---- state pieces ----------------------------------------------------------------------------------------------------------------

function Empty(props: { id: string; icon: NativeIcon; text: string }) {
  return (
    <View {...lk(props.id, s.empty)}>
      <Icon id={`${props.id}.icon`} name={props.icon} size={26} color={color.teal700} />
      <Text {...lk(`${props.id}.text`, s.emptyText)}>{props.text}</Text>
    </View>
  );
}

function NoSignal() {
  const t = useT();
  return (
    <View {...lk('today.nosig', s.nosig)} accessibilityRole="alert">
      <View {...lk('today.nosig.bi', s.bi)}>
        <Icon id="today.nosig.icon" name="signal" size={18} color={tone.riskInk} />
      </View>
      <View style={s.nosigTx}>
        <Text {...lk('today.nosig.title', s.nosigTitle)}>{t('tech.sync.noSignal')}</Text>
        <Text {...lk('today.nosig.text', s.nosigSmall)}>{t('tech.sync.keepWorking')}</Text>
      </View>
    </View>
  );
}

function Skeleton() {
  return (
    <Group id="today.skel">
      {[0, 1].map((i) => (
        <View key={i} {...lk(`today.skel.${i}`, [s.row, i > 0 ? s.rowSep : null])}>
          <Num id={`today.skel.${i}.num`} kind="sk" />
          <View style={s.tx}>
            <View {...lk(`today.skel.${i}.a`, [s.skel, { width: i === 0 ? '60%' : '50%' }])} />
            <View {...lk(`today.skel.${i}.b`, [s.skel, { width: i === 0 ? '85%' : '75%' }])} />
          </View>
        </View>
      ))}
    </Group>
  );
}

function Toast(props: { id: string; text: string; ok?: boolean; icon: NativeIcon }) {
  return (
    <View {...lk(props.id, s.toast)} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Icon id={`${props.id}.icon`} name={props.icon} size={18} color={props.ok ? '#d9f3e3' : color.orange300} strokeWidth={props.ok ? 2.6 : 1.9} />
      <Text {...lk(`${props.id}.text`, s.toastText)}>{props.text}</Text>
    </View>
  );
}

// ---- the screen ------------------------------------------------------------------------------------------------------------------

export function TodayView(p: TodayViewProps) {
  const t = useT();
  const zone = p.day?.zone ?? 'America/New_York';
  const [tries, setTries] = useState(0);
  const lastTry = useLastTry(!!p.failed, tries, zone);
  const done = p.jobs.filter((j) => ENDED.has(j.status));
  const next = nextJob(p.jobs);
  const later = p.jobs.filter((j) => !ENDED.has(j.status) && j.jobNumber !== next?.jobNumber);
  const list = p.state === 'success' || p.state === 'offline_saved' || p.state === 'all_done';
  const offline = !p.online;
  return (
    <View {...lk('today.screen', s.screen)}>
      <Header {...p} />
      <ScrollView {...lk('today.scroll', s.scroll)} contentContainerStyle={s.content}
        refreshControl={<RefreshControl refreshing={p.refreshing} onRefresh={p.onRefresh} />}>
        {offline && p.state !== 'loading' ? <NoSignal /> : null}
        {p.oldCount > 0 ? (
          <View {...lk('today.old', s.old)} accessibilityRole="alert">
            <Icon id="today.old.icon" name="alert" size={17} color={color.badText} marginTop={1} />
            <Text {...lk('today.old.text', s.oldText)}>{`${t('tech.sync.old', { n: p.oldCount })} ${t('tech.sync.oldLink', { n: p.oldCount })}`}</Text>
          </View>
        ) : null}
        {p.notices.map((n) => (
          <Toast key={n.id} id="today.notice" icon="bell" text={n.change ? t(`tech.notice.${n.change.kind}` as MessageKey, { job: n.change.job }) : t('tech.notice.several', { n: n.n })} />
        ))}
        {p.toast ? <Toast id="today.toast" icon="check" ok text={p.toast} /> : null}
        {p.failed && (p.state !== 'offline_none' || p.online) ? (
          <View {...lk('today.error', s.errPanel)} accessibilityRole="alert">
            <Icon id="today.error.icon" name="alert" size={18} color={color.badText} marginTop={1} />
            <View style={s.errTx}>
              <Text {...lk('today.error.title', s.errTitle)}>{t('tech.today.error')}</Text>
              {p.savedAt ? <Text {...lk('today.error.text', s.errText)}>{t('tech.today.errorSaved', { time: timeOf(p.savedAt, zone, p.lang) })}</Text> : null}
              {lastTry ? <Text {...lk('today.error.lastTry', s.errText)}>{t('shell.error.lastTry', { time: lastTry })}</Text> : null}
              <Pressable {...lk('today.error.retry', s.retry)} onPress={() => { setTries((n) => n + 1); p.onRefresh(); }} accessibilityRole="button">
                <Text {...lk('today.error.retry.text', s.retryText)}>{t('shell.error.tryAgain')}</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        {p.state === 'loading' || p.state === 'new_day' ? <Skeleton /> : null}
        {showsNoSaved(p.state, p.online) ? <Empty id="today.empty" icon="signal" text={t('tech.today.noSaved')} /> : null}
        {p.state === 'no_jobs' ? <Empty id="today.empty" icon="calendar" text={t('tech.today.none')} /> : null}
        {p.state === 'all_done' ? <Empty id="today.empty" icon="check" text={t('tech.today.allDone', { n: p.jobs.length })} /> : null}
        {p.state === 'offline_saved' && p.savedAt ? (
          <View {...lk('today.savedline', s.savedline)}>
            <Text {...lk('today.savedline.text', s.savedText)}>{t('tech.today.updated', { time: timeOf(p.savedAt, zone, p.lang) })}</Text>
            {p.waiting > 0 ? (
              <Pressable {...lk('today.savedline.pill', s.syncWarn)} onPress={p.onWaiting} accessible={false}>
                <Icon id="today.savedline.icon" name="cloud" size={16} color={tone.riskInk} />
                <Text {...lk('today.savedline.pill.text', s.syncWarnText)} accessibilityRole="button" onPress={p.onWaiting}>{t('tech.sync.waiting', { n: p.waiting })}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {list && done.length > 0 ? (
          <Group id="today.done">
            {done.map((j, i) => <DoneRow key={j.jobNumber} j={j} i={i} zone={zone} lang={p.lang} t={t} onJob={p.onJob} />)}
          </Group>
        ) : null}
        {list && next ? <NextCard {...p} j={next} /> : null}
        {list && later.length > 0 ? <Text {...lk('today.later.head', s.ghead)}>{t('tech.today.later')}</Text> : null}
        {list && later.length > 0 ? (
          <Group id="today.later">
            {later.map((j, i) => <LaterRow key={j.jobNumber} j={j} i={i} t={t} onJob={p.onJob} />)}
          </Group>
        ) : null}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.screen },
  nav: { backgroundColor: color.teal900, paddingHorizontal: 16, paddingBottom: 12 },
  navrow: { flexDirection: 'row', alignItems: 'center', columnGap: 8, rowGap: 8, height: 44 },
  title: { ...type(780, 30, 33, color.white), flex: 1, letterSpacing: -0.6 },
  sync: {
    flexDirection: 'row', alignItems: 'center', columnGap: 5, rowGap: 5, minHeight: 30, borderRadius: 999, paddingVertical: 4, paddingLeft: 8, paddingRight: 10,
    backgroundColor: tone.glass, borderWidth: 1, borderColor: tone.glassLine,
  },
  // F-1640: the words are their own accessibility elements (a button, a link); the padding grows each to 44 pt tall and the negative margin keeps the layout.
  syncText: { ...type(650, 12.5, 17.5, color.white), paddingVertical: 13.25, marginVertical: -13.25 },
  histHit: { paddingVertical: 13, marginVertical: -13 },
  navbtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  sub: { ...type(400, 14, 19.6, tone.teal200), marginTop: 3 },
  prog: { marginTop: 9, height: 6, borderRadius: 3, backgroundColor: tone.glassTrack, overflow: 'hidden' },
  progFill: { height: 6, borderRadius: 3, backgroundColor: color.orange500 },
  scroll: { flex: 1 },
  content: { paddingTop: 8, paddingHorizontal: 12, paddingBottom: 12, rowGap: 7 },
  ghead: { ...type(750, 12, 16.8, color.ink600), textTransform: 'uppercase', letterSpacing: 0.84, marginHorizontal: 4, marginTop: 2, marginBottom: -2 },
  grp: { backgroundColor: color.white, borderRadius: 12, borderWidth: 1, borderColor: color.ink200, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', columnGap: 10, rowGap: 10, paddingVertical: 7, paddingHorizontal: 12, minHeight: 48 },
  rowLater: { minHeight: 50 },
  rowSep: { borderTopWidth: 1, borderTopColor: tone.ink150 },
  tx: { flex: 1, minWidth: 0 },
  name: type(680, 15, 19.5, color.ink900),
  nameDone: type(680, 15, 19.5, tone.ink700),
  small: type(400, 13, 16.9, color.ink600),
  trail: { alignItems: 'flex-end', rowGap: 2 },
  trailWin: type(700, 13.5, 18.9, color.ink800),
  num: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, borderColor: color.ink300, backgroundColor: color.white, alignItems: 'center', justifyContent: 'center' },
  numText: type(750, 13, 18.2, tone.ink700),
  numOk: { backgroundColor: color.okLine, borderColor: color.okLine },
  numOkText: type(750, 13, 18.2, color.white),
  numWay: { backgroundColor: tone.wayBg, borderColor: tone.wayLine },
  numWayText: type(750, 13, 18.2, tone.wayInk),
  numSk: { backgroundColor: tone.ink150, borderColor: tone.ink150 },
  numNext: { backgroundColor: color.orange500, borderColor: color.orange500 },
  numNextText: type(750, 13, 18.2, color.ink900),
  st: { flexDirection: 'row', alignItems: 'center', columnGap: 5, rowGap: 5, borderRadius: 999, paddingVertical: 1, paddingHorizontal: 8, minHeight: 20, alignSelf: 'flex-start' },
  stSched: { backgroundColor: color.white, borderWidth: 1, borderColor: tone.schedBorder },
  stSchedText: type(700, 12, 18, tone.schedInk),
  stWay: { backgroundColor: tone.wayBg },
  stWayText: type(700, 12, 18, tone.wayInk),
  stDone: { backgroundColor: color.okBg },
  stDoneText: type(700, 12, 18, color.okText),
  wait: { borderRadius: 6, paddingVertical: 1, paddingHorizontal: 6, backgroundColor: tone.riskBg, alignSelf: 'flex-start' },
  waitText: type(650, 12, 16.8, tone.riskInk),
  waitSent: { backgroundColor: color.okBg },
  waitSentText: type(650, 12, 16.8, color.okText),
  // the next job card
  card: { backgroundColor: color.white, borderRadius: 16, borderWidth: 2, borderColor: color.orange500, paddingVertical: 9, paddingHorizontal: 13 },
  lab: { flexDirection: 'row', alignItems: 'center', columnGap: 8, rowGap: 8 },
  labBig: { flexWrap: 'wrap' },
  actsBig: { flexWrap: 'wrap' },
  pbtnBig: { flexDirection: 'column', paddingVertical: 6, paddingHorizontal: 8, columnGap: 2, rowGap: 2, flexBasis: '100%' },
  labText: { ...type(750, 12, 16.8, tone.orange700), textTransform: 'uppercase', letterSpacing: 0.72 },
  win: { marginLeft: 'auto', flexShrink: 1, backgroundColor: tone.ink100, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8 },
  winText: type(750, 13.5, 18.9, color.ink800),
  who: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 8, rowGap: 8, marginTop: 6 },
  h2: { ...type(750, 21, 29.4, color.ink900), letterSpacing: -0.42 },
  addr: { ...type(400, 14, 19.6, tone.ink700), marginTop: 1 },
  what: { flexDirection: 'row', alignItems: 'flex-start', columnGap: 8, rowGap: 8, marginTop: 3 },
  whatText: type(400, 13.5, 18.225, color.ink800),
  whatBold: type(700, 13.5, 18.225, color.ink800),
  whatEta: type(600, 13.5, 18.225, color.teal800),
  lnk: { ...type(650, 13.5, 18.225, color.teal700), textDecorationLine: 'underline' },
  whatRun: { flexDirection: 'row', flexWrap: 'wrap', flexShrink: 1, alignItems: 'baseline' },
  note: { marginTop: 6, backgroundColor: tone.orange50, borderWidth: 1, borderColor: tone.orange100, borderRadius: 10, paddingVertical: 5, paddingHorizontal: 10 },
  noteTitle: { ...type(700, 11.5, 15.525, tone.orange700), textTransform: 'uppercase', letterSpacing: 0.575 },
  noteText: type(400, 13.5, 18.225, color.ink800),
  late: {
    flexDirection: 'row', alignItems: 'flex-start', columnGap: 9, rowGap: 9, marginTop: 6, borderRadius: 11, paddingVertical: 9, paddingHorizontal: 12,
    backgroundColor: tone.riskBg, borderWidth: 1, borderColor: tone.riskLine,
  },
  lateText: { ...type(400, 13.5, 18.9, tone.riskInk), flexShrink: 1 },
  acts: { flexDirection: 'row', columnGap: 8, rowGap: 8, marginTop: 7 },
  pbtn: {
    minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: color.teal700, backgroundColor: color.white, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', columnGap: 7, rowGap: 7,
  },
  pdir: { flex: 1 },
  psq: { width: 50 },
  pbtnText: type(700, 15, 21, color.teal800),
  pbtnMin: type(550, 13, 18.2, color.ink500),
  omw: {
    marginTop: 7, minHeight: 50, borderRadius: 14, backgroundColor: tone.orange600, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    columnGap: 10, rowGap: 10, paddingVertical: 4, paddingHorizontal: 12,
  },
  omwOff: { backgroundColor: tone.ink100 },
  omwText: { ...type(750, 19, 26.6, color.white), textAlign: 'center' },
  omwnote: { ...type(400, 12, 15.6, color.ink600), textAlign: 'center', marginTop: 4 },
  acts2: { flexDirection: 'row', columnGap: 6, rowGap: 6, marginTop: 7 },
  sbtn: {
    flex: 1, minHeight: 44, borderRadius: 11, borderWidth: 1, borderColor: color.ink300, backgroundColor: color.white, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', columnGap: 6, rowGap: 6, paddingVertical: 3, paddingHorizontal: 6,
  },
  sbtnPri: { backgroundColor: color.teal700, borderColor: color.teal700 },
  sbtnOff: { backgroundColor: tone.ink100, borderColor: color.ink200 },
  sbtnText: { ...type(650, 13.5, 16.2, color.ink800), textAlign: 'center' },
  sbtnOffText: { color: color.ink500 },
  after: { ...type(400, 12, 15.6, color.ink600), textAlign: 'center', marginTop: 4 },
  // states
  empty: { alignItems: 'center', rowGap: 6, columnGap: 6, paddingVertical: 14, paddingHorizontal: 10, backgroundColor: color.white, borderRadius: 12, borderWidth: 1, borderColor: color.ink200 },
  emptyText: { ...type(650, 15, 21, color.ink800), textAlign: 'center' },
  nosig: {
    flexDirection: 'row', alignItems: 'center', columnGap: 10, rowGap: 10, borderRadius: 11, paddingVertical: 8, paddingHorizontal: 12,
    backgroundColor: tone.riskBg, borderWidth: 1, borderColor: tone.riskLine,
  },
  bi: { width: 34, height: 34, borderRadius: 17, backgroundColor: color.white, borderWidth: 2, borderColor: tone.riskLine, alignItems: 'center', justifyContent: 'center' },
  nosigTx: { flex: 1 },
  nosigTitle: type(780, 15, 21, tone.riskInk),
  nosigSmall: type(550, 12.5, 16.875, tone.riskInk),
  savedline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', columnGap: 8, rowGap: 8 },
  savedText: type(600, 13, 18.2, color.ink600),
  syncWarn: {
    flexDirection: 'row', alignItems: 'center', columnGap: 5, rowGap: 5, minHeight: 30, borderRadius: 999, paddingVertical: 4, paddingLeft: 8, paddingRight: 10,
    backgroundColor: tone.riskBg, borderWidth: 1, borderColor: tone.riskLine,
  },
  syncWarnText: type(650, 12.5, 17.5, tone.riskInk),
  skel: { height: 11, borderRadius: 6, backgroundColor: tone.ink150, marginVertical: 2.5 },
  old: {
    flexDirection: 'row', alignItems: 'flex-start', columnGap: 9, rowGap: 9, borderRadius: 11, paddingVertical: 9, paddingHorizontal: 12,
    backgroundColor: color.badBg, borderWidth: 1, borderColor: color.badLine,
  },
  oldText: { ...type(400, 13.5, 18.9, color.badText), flexShrink: 1 },
  toast: { flexDirection: 'row', alignItems: 'center', columnGap: 9, rowGap: 9, borderRadius: 14, paddingVertical: 11, paddingHorizontal: 14, backgroundColor: color.ink800 },
  toastText: { ...type(600, 14, 19.6, color.white), flexShrink: 1 },
  errPanel: {
    flexDirection: 'row', alignItems: 'flex-start', columnGap: 10, rowGap: 10, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12,
    backgroundColor: color.badBg, borderWidth: 1, borderColor: color.badLine,
  },
  errTx: { flex: 1 },
  errTitle: type(700, 14, 19.6, color.badText),
  errText: type(400, 14, 19.6, color.badText),
  retry: { alignSelf: 'flex-start', marginTop: 6, minHeight: 36, borderRadius: 10, borderWidth: 1, borderColor: color.badLine, paddingHorizontal: 12, justifyContent: 'center', backgroundColor: color.white },
  retryText: type(650, 14, 19.6, color.badText),
});
