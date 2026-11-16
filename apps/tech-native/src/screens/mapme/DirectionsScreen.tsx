// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-08 Directions (DK-117 option B, kit 0.9; state content from DK-113 mockups/pages/tech-map.html, ruling D5b-1; FR-TECH-5, FR-TECH-13,
// FR-MAP-1, FR-MAP-3): one tap from Today, the job or the Map tab to the route to the job on the app's own street map, with the destination
// in words, the drive time, the Next turn card and the turn-by-turn Steps (P6-NATIVE-STEPS, F-1233: "I have never heard of an app that does
// not include turn-by-turn instructions as a primary component of directions."). It opens in the app, on the app's map; no other maps app
// is opened. The route is read again on focus and with each read round of the day (GAP-7); a re-read that is another route says Route
// updated, and a new next turn is announced. The last route read for this destination is kept on the phone (section 4.5 rule 11), so with
// no signal the steps of that read still show. The Back link opens Today (OI-56).
import { clockOfWire, windowLabelOfWire } from '@bw/i18n/src/text-rows.ts';
import { useFocusEffect, useNavigation, useRoute, type NavigationProp, type ParamListBase } from '@react-navigation/native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import { Icon } from '../../ui/Icon.tsx';
import { useT } from '../../ui/intl.tsx';
import { useLastTry } from '../../ui/last-try.ts';
import { lk, useLookDump } from '../../ui/look.ts';
import { color, type } from '../../ui/tokens.ts';
import { ErrBox, InfoBox } from '../job/ui.tsx';
import { NativeMap } from './NativeMap.tsx';
import { Bar2, c, Grp, NoSignal, Row, RowText, Scroll, T } from './parts.tsx';
import { isBranchId, type MapLeg, type MapStop } from './model.ts';
import { isRestOf, nextTurn, stepRows, stepsPhase, streetOf, type RouteRead, type ShownRoute, type StepRow } from './steps.ts';
import { openJob } from '../job/nav.ts';
import { useMapMe } from './use-mapme.ts';

/** DK-117 .nmap.n8: the Directions map is 216 px tall, so 3 steps show above the tab bar. */
const MAP_HEIGHT = 216;

export function DirectionsScreen() {
  const t = useT();
  const nav = useNavigation<NavigationProp<ParamListBase>>();
  const params = (useRoute().params ?? {}) as { jobNumber?: number; from?: number };
  const jobNumber = params.jobNumber ?? 0;
  const { state, reads, data } = useMapMe();
  const [read, setRead] = useState<RouteRead | null>(null);
  const [updated, setUpdated] = useState(false);
  const [focus, setFocus] = useState<{ at: readonly [number, number]; key: number } | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [tries, setTries] = useState(0);
  const [focusRound, setFocusRound] = useState(0);
  const offline = !state.outbox.online || !data.online;

  // The destination in words comes from the day (kept on the phone), so it shows with no signal too.
  const job = data.day?.data.jobs.find((j) => j.jobNumber === jobNumber);
  const stop = data.route?.data.stops.find((x) => x.jobNumber === jobNumber);
  const dest = job ? { customer: job.customer.name, address: job.address, window: job.window } : stop ? { customer: stop.customer, address: stop.address, window: stop.window } : null;
  const address = dest?.address ?? '';
  const street = streetOf(address);

  useFocusEffect(useCallback(() => setFocusRound((n) => n + 1), []));

  // API-104 with signal: on open and focus, after Try again, and with each read round of the day (GAP-7: the interval, the foreground).
  // The saved day is a new object with each answered round, so a round re-reads the route even while the demo clock holds still (F-1330; data.now is that clock's
  // answer and does not change while it is paused). The web screen keys on the day object the same way.
  const round = data.day;
  useEffect(() => {
    if (!reads || offline || jobNumber <= 0) return;
    let live = true;
    void reads.leg(jobNumber, params.from).then((r) => live && setRead(r));
    return () => {
      live = false;
    };
  }, [reads, offline, jobNumber, params.from, round, tries, focusRound]);

  // CTL-TEC-08-08 and CTL-TEC-08-05: a re-read that is another route redraws with Route updated; a new next turn is announced.
  const shown = useRef<ShownRoute | null>(null);
  const spoken = useRef<string | null>(null);
  useEffect(() => {
    if (read?.kind !== 'leg') return;
    const before = shown.current;
    shown.current = read;
    if (before !== null && !isRestOf(before, read)) {
      setUpdated(true);
      setFocus(null);
      AccessibilityInfo.announceForAccessibility(t('tech.dir.routeUpdated'));
    }
  }, [read, t]);

  const kept = reads?.keptRoute(jobNumber) ?? null;
  const phase = stepsPhase(read, offline, kept !== null, jobNumber > 0);
  const lastTry = useLastTry(phase === 'failed', tries);
  // What the screen draws: the live read with signal, the kept read of this destination with none.
  const route: ShownRoute | null = phase === 'offlineSaved' ? kept : read?.kind === 'leg' ? read : null;
  const live = phase === 'route' || phase === 'approximate';
  const rows = useMemo(() => (route && phase !== 'approximate' ? stepRows(route.steps, t, street, phase === 'route') : []), [route, phase, t, street]);
  const turn = useMemo(() => (route && phase === 'route' ? nextTurn(route.steps, t, street) : null), [route, phase, t, street]);
  const turnWords = turn ? `${turn.lead} ${turn.words}` : null;
  useEffect(() => {
    if (turnWords === null) return;
    if (spoken.current !== null && spoken.current !== turnWords) AccessibilityInfo.announceForAccessibility(turnWords);
    spoken.current = turnWords;
  }, [turnWords]);

  const leg = live && read?.kind === 'leg' ? read.leg : null;
  const branch = route && isBranchId(route.branch) ? route.branch : 'columbus';
  const stops: MapStop[] = useMemo(() => (leg && dest ? [{
    id: 'to', at: [leg.to.lon, leg.to.lat], state: 'next', text: stop ? String(stop.number) : '',
    words: t('tech.map.stopWords', { n: stop?.number ?? 0, state: t('tech.map.state.next'), customer: dest.customer, area: dest.address }),
  }] : []), [leg, dest, stop, t]);
  const legs: MapLeg[] = useMemo(() => (leg ? [{ id: 'leg', from: [leg.from.lon, leg.from.lat], to: [leg.to.lon, leg.to.lat], track: leg.track }] : []), [leg]);
  useLookDump(phase === 'route' && dest && turn && rows.length >= 3 ? 'directions' : null);

  const back = () => {
    nav.goBack();
    nav.getParent()?.navigate('Today');
  };
  // CTL-TEC-08-04 (F-1072 item 2): SCR-TEC-04 for the destination job, on Today's stack; Directions leaves its own stack first, as Back does.
  const openTheJob = () => {
    nav.goBack();
    openJob(nav, jobNumber);
  };
  const pick = (r: StepRow) => setFocus((f) => ({ at: r.at, key: (f?.key ?? 0) + 1 }));
  const fit = () => {
    setFocus(null);
    setFitKey((k) => k + 1);
  };

  const minutes = route && route.leg.track !== null && (phase === 'route' || phase === 'offlineSaved') ? route.leg.minutes : null;
  return (
    <View style={s.screen}>
      <Bar2 id="dir.bar" title={t('tech.dir.title')} back={{ label: t('tech.dir.back'), onPress: back }} />
      {phase === 'none' ? (
        <View style={s.pad}><View {...lk('dir.none', s.note)}><Icon name="check" size={18} color={color.okText} /><T style={s.noteText}>{t('tech.dir.noMore')}</T></View></View>
      ) : (
        <>
          {live ? (
            <NativeMap id="dir.map" branch={branch} origin={state.session?.origin ?? state.server} stops={stops} legs={legs} fitKey={fitKey} online={!offline}
              label={t('tech.map.label')} height={MAP_HEIGHT} turn={turn ? { at: turn.at, icon: turn.icon } : null} focus={focus}>
              {/* CTL-TEC-08-07: back to the whole route as it first opened, after a step was picked. */}
              <Pressable {...lk('dir.fit', s.fit)} onPress={fit} accessibilityRole="button" accessibilityLabel={t('tech.dir.fit')}>
                <Icon id="dir.fit.icon" name="nav" size={22} color={color.teal700} />
              </Pressable>
              {phase === 'approximate' ? <T lkId="dir.approx" style={s.approx}>{t('map.approx')}</T> : null}
            </NativeMap>
          ) : phase === 'loading' ? (
            <View {...lk('dir.map.wait', s.wait)} accessibilityLabel={t('tech.map.label')} />
          ) : phase === 'offline' || phase === 'offlineSaved' ? (
            <View {...lk('dir.map.wait', s.wait)} accessibilityLabel={t('tech.map.label')}>
              <T lkId="dir.need" style={s.noteText}>{phase === 'offline' ? t('tech.dir.needSignal', { address }) : t('tech.map.needSignal')}</T>
            </View>
          ) : null}
          <Scroll id="dir.scroll">
            {offline ? <NoSignal /> : null}
            {phase === 'failed' ? (
              <ErrBox id="dir.failed" text={`${t('tech.dir.notLoaded')} ${t('tech.dir.notLoadedBody')}`} lastTry={lastTry && t('shell.error.lastTry', { time: lastTry })}
                link={{ id: 'dir.retry', label: t('shell.error.tryAgain'), onPress: () => setTries((n) => n + 1) }} />
            ) : null}
            {phase === 'moved' ? (
              <View {...lk('dir.moved', s.note)} accessibilityRole="alert"><Icon name="alert" size={18} color={color.ink500} /><T style={s.noteText}>{t('tech.dir.moved')}</T></View>
            ) : null}
            <Grp id="dir.dest">
              <Row id="dir.dest.who" first>
                <RowText id="dir.dest.who.tx" title={dest?.customer ?? ''} small={dest ? t('tech.dir.where', { address: dest.address, window: windowLabelOfWire(dest.window) }) : ''} />
              </Row>
              {minutes !== null ? (
                <Row id="dir.time"><RowText id="dir.time.tx" title={t('tech.dir.about', { n: minutes })} /></Row>
              ) : null}
              <Row id="dir.open" onPress={openTheJob} label={t('tech.dir.openJob')}>
                <RowText id="dir.open.tx" title={t('tech.dir.openJob')} link />
                <Icon id="dir.open.chev" name="chevRight" size={16} color={color.ink400} />
              </Row>
            </Grp>
            {updated && live ? (
              <View {...lk('dir.updated', s.updated)} accessibilityRole="alert">
                <Icon name="check" size={18} color={color.okText} />
                <T lkId="dir.updated.text" style={s.updatedText}>{t('tech.dir.routeUpdated')}</T>
              </View>
            ) : null}
            {turn ? <NextTurnCard turn={turn} /> : null}
            {phase === 'loading' ? <SkeletonSteps head={t('tech.dir.steps')} /> : null}
            {phase === 'approximate' || (phase === 'route' && rows.length === 0) ? (
              <>
                <T lkId="dir.ghead" style={s.ghead} accessibilityRole="header">{t('tech.dir.steps')}</T>
                <InfoBox id="dir.noturn" text={t('tech.dir.approximate', { address })} />
              </>
            ) : null}
            {rows.length > 0 ? (
              <>
                <T lkId="dir.ghead" style={s.ghead} accessibilityRole="header">
                  {phase === 'offlineSaved' && route ? t('tech.dir.stepsFrom', { time: clockOfWire(route.at) }) : t('tech.dir.steps')}
                </T>
                <View {...lk('dir.steps', s.steps)} accessibilityRole="list" accessibilityLabel={t('tech.dir.steps')}>
                  {rows.map((r, i) => <StepLine key={r.index} r={r} first={i === 0} onPress={live ? () => pick(r) : undefined} />)}
                </View>
              </>
            ) : null}
          </Scroll>
        </>
      )}
    </View>
  );
}

/** CTL-TEC-08-05 (.nturn): the next turn's arrow, "In 0.3 mi:" and its words. */
function NextTurnCard(props: { turn: NonNullable<ReturnType<typeof nextTurn>> }) {
  return (
    <View {...lk('dir.next', s.nturn)} accessible accessibilityLabel={`${props.turn.lead} ${props.turn.words}`} accessibilityValue={{ text: props.turn.words }}>
      <View {...lk('dir.next.mv', s.nturnMv)}><Icon id="dir.next.icon" name={props.turn.icon} size={24} color={color.white} /></View>
      <View {...lk('dir.next.tx', s.nturnTx)}>
        <T lkId="dir.next.lead" style={s.nturnLead}>{props.turn.lead}</T>
        <T lkId="dir.next.words" style={s.nturnWords}>{props.turn.words}</T>
      </View>
    </View>
  );
}

/** 1 step (.row.turn): its arrow, Now on the step the van is on, its words and its distance; pressed, it centers the map on its turn. */
function StepLine(props: { r: StepRow; first: boolean; onPress: (() => void) | undefined }) {
  const { r } = props;
  const t = useT();
  const id = r.arrive ? 'dir.step.arrive' : `dir.step.${r.index}`;
  const style = [s.row, props.first ? null : s.rowLine, r.now ? s.rowNow : null];
  const label = [r.words, r.distance].filter(Boolean).join(', ');
  const body = (
    <>
      <View {...lk(`${id}.mv`, [s.mv, r.now ? s.mvNow : r.arrive ? s.mvArrive : null])}>
        <Icon id={`${id}.icon`} name={r.icon} size={18} color={r.now ? color.white : r.arrive ? color.ink900 : color.teal800} />
      </View>
      <View {...lk(`${id}.tx`, s.tx)}>
        {r.now ? <View {...lk(`${id}.now`, s.nowt)}><T lkId={`${id}.now.text`} style={s.nowText}>{t('tech.dir.now')}</T></View> : null}
        <T lkId={`${id}.words`} style={s.words}>{r.words}</T>
      </View>
      {r.distance !== null ? <T lkId={`${id}.v`} style={s.v}>{r.distance}</T> : null}
    </>
  );
  const a11y = { accessibilityLabel: label, accessibilityValue: { text: r.now ? 'now' : 'step' } };
  return props.onPress ? (
    <Pressable {...lk(id, style)} onPress={props.onPress} accessibilityRole="button" {...a11y}>{body}</Pressable>
  ) : (
    <View {...lk(id, style)} accessible {...a11y}>{body}</View>
  );
}

/** Loading: 3 skeleton step rows under the Steps head. */
function SkeletonSteps(props: { head: string }) {
  return (
    <>
      <T lkId="dir.ghead" style={s.ghead} accessibilityRole="header">{props.head}</T>
      <View {...lk('dir.steps.skel', s.steps)} accessibilityState={{ busy: true }}>
        {[62, 74, 48].map((w, i) => (
          <View key={w} style={[s.row, i === 0 ? null : s.rowLine]}>
            <View style={s.mv} />
            <View style={[s.skel, { width: `${w}%` }]} />
          </View>
        ))}
      </View>
    </>
  );
}

const TEAL_50 = '#f1f8fa';

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.screen },
  pad: { padding: 12 },
  wait: { height: MAP_HEIGHT, backgroundColor: c.ink100, alignItems: 'center', justifyContent: 'center', padding: 16 },
  note: { flexDirection: 'row', alignItems: 'center', columnGap: 8, rowGap: 8, paddingVertical: 12 },
  noteText: { fontSize: 14, color: color.ink600, flexShrink: 1, textAlign: 'center' },
  // .nmap .nfit: 44 px, 10 px in from the map's top right corner.
  fit: {
    position: 'absolute', right: 10, top: 10, width: 44, height: 44, borderRadius: 12, backgroundColor: color.white, borderWidth: 1, borderColor: color.ink200,
    alignItems: 'center', justifyContent: 'center',
  },
  approx: { position: 'absolute', left: 8, top: 8, backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: 5, paddingVertical: 1, paddingHorizontal: 6, ...type(650, 12, 16.8, color.ink800) },
  updated: { flexDirection: 'row', alignItems: 'center', columnGap: 8, rowGap: 8, backgroundColor: color.okBg, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  updatedText: type(600, 14, 19.6, color.okText),
  // .nturn: the teal-900 card, 60 px at least, the 40 px arrow disc, the lead line and the words.
  nturn: { flexDirection: 'row', alignItems: 'center', columnGap: 12, rowGap: 12, backgroundColor: color.teal900, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14, minHeight: 60 },
  nturnMv: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.teal700, alignItems: 'center', justifyContent: 'center' },
  nturnTx: { flex: 1, minWidth: 0 },
  nturnLead: type(700, 13.5, 16.875, c.teal200),
  nturnWords: { ...type(740, 18, 22.5, color.white), letterSpacing: -0.18 },
  // .ghead
  ghead: { ...type(750, 12, 16.8, color.ink600), textTransform: 'uppercase', letterSpacing: 0.84, marginTop: 2, marginHorizontal: 4, marginBottom: -2 },
  // ol.grp.nsteps and its .row.turn rows
  steps: { backgroundColor: color.white, borderWidth: 1, borderColor: color.ink200, borderRadius: 12, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', columnGap: 10, rowGap: 10, paddingVertical: 7, paddingHorizontal: 12, minHeight: 48 },
  rowLine: { borderTopWidth: 1, borderTopColor: c.ink150 },
  rowNow: { backgroundColor: TEAL_50 },
  mv: { width: 30, height: 30, borderRadius: 15, backgroundColor: TEAL_50, alignItems: 'center', justifyContent: 'center' },
  mvNow: { backgroundColor: color.teal700 },
  mvArrive: { backgroundColor: color.orange500 },
  tx: { flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  nowt: { backgroundColor: color.teal700, borderRadius: 999, paddingVertical: 1, paddingHorizontal: 7, marginRight: 6 },
  nowText: { ...type(750, 11.5, 14.95, color.white), letterSpacing: 0.23 },
  words: { ...type(680, 15, 19.5, color.ink900), flexShrink: 1 },
  v: type(650, 14, 19.6, color.ink600),
  skel: { height: 11, borderRadius: 6, backgroundColor: c.ink150 },
});
