// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-15 Map (DK-117 option B; state content from DK-113 mockups/pages/tech-map.html; FR-TECH-10, FR-TECH-11, FR-TECH-13, FR-MAP-1, FR-MAP-3): today's
// route on the app's own street map (CMP-05), the stops numbered in the day's order and marked Done, Next or Later, the Next stop card with its
// drive time and Directions, and the Stops list under the map (the map's text alternative, kept with no signal from the saved day).
import { useNavigation, type NavigationProp, type ParamListBase } from '@react-navigation/native';
import { clockOfWire, windowLabelOfWire } from '@bw/i18n/src/text-rows.ts';
import { useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, findNodeHandle, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { ComponentRef, Ref } from 'react';
import { useLastTry } from '../../ui/last-try.ts';
import { Icon } from '../../ui/Icon.tsx';
import { useT } from '../../ui/intl.tsx';
import { useBigText } from '../../ui/text-size.tsx';
import { lk, useLookDump } from '../../ui/look.ts';
import { color, type } from '../../ui/tokens.ts';
import { NativeMap } from './NativeMap.tsx';
import { Bar2, c, Chip, Grp, NoSignal, Num, Row, RowText, Scroll, T } from './parts.tsx';
import {
  distText, isBranchId, legTo, mapLayers, mapPhase, mapSummary, STATE_KEY, type RouteData, type Stop,
} from './model.ts';
import { ErrBox } from '../job/ui.tsx';
import { STOP_COLOR } from './map-style.ts';
import { openJob } from '../job/nav.ts';
import { useMapMe } from './use-mapme.ts';

/** The Directions screen is pushed in the tab's own stack (Tabs.tsx adds it to each); the job number rides as a parameter. */
export function openDirections(nav: NavigationProp<ParamListBase>, jobNumber: number, from?: number): void {
  nav.navigate('Directions', { jobNumber, ...(from !== undefined ? { from } : {}) });
}

function Legend() {
  const t = useT();
  return (
    <View {...lk('map.legend', s.legend)} accessible accessibilityLabel={`${t('tech.map.state.done')}, ${t('tech.map.state.next')}, ${t('tech.map.state.later')}`}>
      {(['done', 'next', 'later'] as const).map((k) => (
        <View key={k} style={s.legendItem}>
          <View style={[s.dot, { backgroundColor: STOP_COLOR[k] }]} />
          <T style={s.legendText}>{t(STATE_KEY[k])}</T>
        </View>
      ))}
    </View>
  );
}

function NextCard(props: { route: RouteData; stop: Stop; onDirections: () => void; onOpen: () => void }) {
  const t = useT();
  const { state } = useMapMe();
  const big = useBigText(); // 14.2 item 2: the window wraps under the label and the Directions button stacks its words
  const leg = legTo(props.route, props.stop.jobNumber);
  const stop = props.stop;
  return (
    <View {...lk('map.next', s.next)}>
      <View {...lk('map.next.lab', [s.lab, big ? s.labBig : null])}>
        <Num id="map.next.num" kind="next" text={String(stop.number)} />
        <T lkId="map.next.label" style={s.labText}>{t('tech.map.nextStop')}</T>
        <View {...lk('map.next.win', s.win)}>
          <T lkId="map.next.win.text" style={s.winText}>{windowLabelOfWire(stop.window)}</T>
        </View>
      </View>
      <View {...lk('map.next.who', s.who)}>
        <T lkId="map.next.name" style={s.name}>{stop.customer}</T>
      </View>
      <T lkId="map.next.addr" style={s.addr}>{stop.address}</T>
      {leg ? (
        <View {...lk('map.next.dist', s.dist)}>
          <Icon name="truck" size={16} color={color.ink600} />
          <T lkId="map.next.dist.text" style={s.distText}>{distText(t, state.language, leg, stop.serviceLabelKey)}</T>
        </View>
      ) : null}
      <View {...lk('map.next.acts', s.acts)}>
        <Pressable {...lk('map.dir', [s.pbtn, big ? s.pbtnBig : null])} onPress={props.onDirections} accessibilityRole="button" accessibilityLabel={`${t('tech.map.directions')}${leg ? `, ${t('tech.map.directionsMin', { n: leg.minutes })}` : ''}`}>
          <Icon id="map.dir.icon" name="nav" size={19} color={color.teal800} />
          <T lkId="map.dir.text" style={s.pbtnText}>{t('tech.map.directions')}</T>
          {leg ? <T lkId="map.dir.min" style={s.pbtnMin}>{t('tech.map.directionsMin', { n: leg.minutes })}</T> : null}
        </Pressable>
      </View>
      <Pressable {...lk('map.open', s.open)} onPress={props.onOpen} accessibilityRole="link" accessibilityLabel={t('tech.map.openJob')}>
        <T lkId="map.open.text" style={s.openText}>{t('tech.map.openJob')}</T>
        <Icon name="chevRight" size={16} color={color.ink400} />
      </Pressable>
    </View>
  );
}

/** `id` is `map.stop.<state>.<k>`: the k-th stop of that state in the day's order (the look cases and the XCUITest find the rows by it). */
function StopRow(props: { id: string; s: Stop; first: boolean; onPress: () => void; rowRef?: Ref<ComponentRef<typeof Pressable>> }) {
  const t = useT();
  const stop = props.s;
  const k = stop.state === 'done' ? 'ok' : stop.state === 'next' ? 'way' : 'later';
  return (
    <Row id={props.id} first={props.first} onPress={props.onPress} {...(props.rowRef ? { rowRef: props.rowRef } : {})} label={`${stop.number}, ${stop.customer}, ${t(STATE_KEY[stop.state])}`}>
      <Num id={`${props.id}.num`} kind={k} text={String(stop.number)} />
      <RowText id={`${props.id}.tx`} title={stop.customer} small={t('tech.map.stopLine', { area: stop.area, service: t(stop.serviceLabelKey as never) })} />
      <Chip id={`${props.id}.st`} kind={stop.state === 'done' ? 'done' : stop.state === 'next' ? 'way' : 'later'} text={t(STATE_KEY[stop.state])} />
    </Row>
  );
}

export function MapTab() {
  const t = useT();
  const nav = useNavigation<NavigationProp<ParamListBase>>();
  const { state, data, reads } = useMapMe();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const [fitKey, setFitKey] = useState(0);
  const [listY, setListY] = useState(0);
  const [headH, setHeadH] = useState(0); // the bar and the map above the scroll body when they scroll with it (the largest text sizes)
  const firstStop = useRef<ComponentRef<typeof Pressable>>(null);
  const [focused, setFocused] = useState('none');
  const route = data.route?.data ?? null;
  const offline = !state.outbox.online || !data.online;
  const phase = mapPhase(route, offline, data.settled, data.failed);
  const [tries, setTries] = useState(0);
  const lastTry = useLastTry(phase === 'error', tries);
  const stops = route?.stops ?? [];
  const done = stops.filter((x) => x.state === 'done').length;
  const nextStop = route && route.next !== null ? stops.find((x) => x.jobNumber === route.next) : undefined;
  const layers = useMemo(() => (route ? mapLayers(t, route) : null), [route, t]);
  const branch = route && isBranchId(route.branch) ? route.branch : 'columbus';
  const summary = mapSummary(t, phase, stops.length, done);
  const drawn = layers !== null && stops.length > 0 && (phase === 'route' || phase === 'alldone' || phase === 'offline');
  // The look dump of this frame's state (the Route frame): once the day's route is on the screen.
  useLookDump(phase === 'route' ? 'map' : null);

  // CTL-TEC-15-06: scroll to the Stops list and move focus to its first stop (the screen reader lands on it).
  const showList = () => {
    scroll.current?.scrollTo({ y: listY + (big ? headH : 0), animated: true });
    const node = firstStop.current ? (findNodeHandle(firstStop.current) ?? null) : null;
    if (node === null) return;
    AccessibilityInfo.setAccessibilityFocus(node);
    setFocused(`stop ${stops[0]?.jobNumber ?? 'none'}`);
  };

  // 14.2 item 2: at the largest text sizes the bar and the map scroll away with the Next stop card and the list (they stay pinned above them at
  // every other size), so Directions and the Stops list are never pushed under the tab bar.
  const big = useBigText();
  const mapBlock = phase === 'none' || phase === 'error' ? null : drawn && layers ? (
        <View style={s.mapw}>
          <NativeMap id="map.view" branch={branch} origin={state.session?.origin ?? state.server} stops={layers.stops} legs={phase === 'alldone' ? [] : layers.legs}
            fitKey={fitKey} online={!offline} label={t('tech.map.label')} />
          <Legend />
          <Pressable {...lk('map.fit', [s.fab, s.fabA])} onPress={() => setFitKey((k) => k + 1)} accessibilityRole="button" accessibilityLabel={t('tech.map.fit')}>
            <Icon name="nav" size={22} color={color.teal700} />
          </Pressable>
          <Pressable {...lk('map.list', [s.fab, s.fabB])} onPress={showList} accessibilityRole="button" accessibilityLabel={t('tech.map.list')}>
            <Icon name="list" size={22} color={color.teal700} />
          </Pressable>
        </View>
      ) : (
        <View {...lk('map.empty', s.skel)} accessibilityLabel={t('tech.map.label')} />
      );

  return (
    <View style={s.screen}>
      {big ? null : <Bar2 id="map.bar" title={t('tech.tab.map')} sub={summary} />}
      {big ? null : mapBlock}
      <Scroll id="map.scroll" scrollRef={scroll}
        {...(big ? { head: <View onLayout={(e) => setHeadH(e.nativeEvent.layout.height)}><Bar2 id="map.bar" title={t('tech.tab.map')} sub={summary} />{mapBlock}</View> } : {})}>
        {offline ? <NoSignal /> : null}
        {phase === 'route' && route && nextStop ? (
          <NextCard route={route} stop={nextStop} onDirections={() => openDirections(nav, nextStop.jobNumber)} onOpen={() => openJob(nav, nextStop.jobNumber)} />
        ) : null}
        {phase === 'error' ? (
          // SCR-TEC-15 Route not loaded (F-1757): CMP-12 in place of the map and the stop list, with Try again reading the day and route again
          <ErrBox id="map.failed" text={t('tech.map.error')} lastTry={lastTry && t('shell.error.lastTry', { time: lastTry })} link={{ id: 'map.retry', label: t('shell.error.tryAgain'), onPress: () => { setTries((n) => n + 1); void reads?.refresh(); } }} />
        ) : phase === 'none' ? (
          <View {...lk('map.none', s.note)}><Icon name="map" size={18} color={color.ink500} /><T style={s.noteText}>{t('tech.map.noJobs')}</T></View>
        ) : (
          <View onLayout={(e) => setListY(e.nativeEvent.layout.y)}>
            <T style={s.stopsHead}>{phase === 'offline' && data.route ? t('tech.map.stopsSaved', { time: clockOfWire(data.route.at) }) : t('tech.map.stops')}</T>
          </View>
        )}
        {phase === 'alldone' ? (
          <View {...lk('map.alldone', s.note)}><Icon name="check" size={18} color={color.okText} /><T style={s.noteText}>{t('tech.map.allDone')}</T></View>
        ) : null}
        {route && phase !== 'none' && phase !== 'alldone' && phase !== 'error' ? (
          <Grp id="map.stops">
            {stops.map((x, i) => <StopRow key={x.jobNumber} {...(i === 0 ? { rowRef: firstStop } : {})} id={`map.stop.${x.state}.${stops.slice(0, i).filter((y) => y.state === x.state).length}`} s={x} first={i === 0} onPress={() => openJob(nav, x.jobNumber)} />)}
          </Grp>
        ) : null}
      </Scroll>
      {/* F-1088: the focus read-out is for the XCUITest only (a rig bundle, EXPO_PUBLIC_BW_RIG=1); a screen reader never finds it in a shipped one. */}
      {process.env.EXPO_PUBLIC_BW_RIG === '1' ? <T lkId="map.list.focus" style={s.focusLog} accessibilityLabel={`focus=${focused}`}>{focused}</T> : null}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.screen },
  mapw: { height: 300 },
  focusLog: { position: 'absolute', top: 0, left: 0, width: 1, height: 1, opacity: 0.01, fontSize: 1 },
  skel: { height: 300, backgroundColor: c.ink100 },
  legend: {
    position: 'absolute', left: 12, top: 12, flexDirection: 'row', alignItems: 'center', columnGap: 10, rowGap: 10, backgroundColor: 'rgba(255,255,255,0.96)',
    borderWidth: 1, borderColor: color.ink200, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 12,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', columnGap: 4, rowGap: 4 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  legendText: type(650, 12.5, 16, color.ink800),
  fab: {
    position: 'absolute', right: 12, width: 48, height: 48, borderRadius: 14, backgroundColor: color.white, borderWidth: 1, borderColor: color.ink200,
    alignItems: 'center', justifyContent: 'center',
  },
  fabA: { top: 54 },
  fabB: { top: 110 },
  next: { backgroundColor: color.white, borderWidth: 2, borderColor: color.orange500, borderRadius: 16, paddingVertical: 9, paddingHorizontal: 13 },
  lab: { flexDirection: 'row', alignItems: 'center', columnGap: 8, rowGap: 8 },
  labText: { ...type(750, 12, 16.8, c.orange800), textTransform: 'uppercase', letterSpacing: 0.72 },
  labBig: { flexWrap: 'wrap' },
  pbtnBig: { flexDirection: 'column', paddingVertical: 6, paddingHorizontal: 8, columnGap: 2, rowGap: 2 },
  win: { marginLeft: 'auto', flexShrink: 1, backgroundColor: c.ink100, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8 },
  winText: type(750, 13.5, 18.9, color.ink800),
  who: { marginTop: 6, flexDirection: 'row', alignItems: 'center', columnGap: 8, rowGap: 8 },
  name: type(750, 21, 29.4, color.ink900),
  addr: { ...type(400, 14, 19.6, c.ink700), marginTop: 1 },
  dist: { marginTop: 4, flexDirection: 'row', alignItems: 'center', columnGap: 6, rowGap: 6 },
  distText: type(550, 13, 18.2, color.ink600),
  acts: { marginTop: 7, flexDirection: 'row', alignItems: 'stretch', columnGap: 8, rowGap: 8 },
  pbtn: {
    flex: 1, minHeight: 44, backgroundColor: color.white, borderWidth: 1, borderColor: color.teal700, borderRadius: 12, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', columnGap: 7, rowGap: 7,
  },
  pbtnText: type(700, 15, 21, color.teal800),
  pbtnMin: type(550, 13, 18.2, color.ink500),
  open: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', columnGap: 2, rowGap: 2, paddingHorizontal: 8 },
  openText: type(650, 15, 21, color.teal800),
  stopsHead: { ...type(700, 13, 18, color.ink600), marginTop: 4 },
  note: { flexDirection: 'row', alignItems: 'center', columnGap: 8, rowGap: 8, paddingVertical: 12 },
  noteText: type(400, 14, 19.6, color.ink600),
});
