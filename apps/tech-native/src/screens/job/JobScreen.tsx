// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-04 Job, native (DK-117 mockups/pages/r1-ios-b.html "SCR-TEC-04 Job, iPhone"; state content from DK-110 per ruling D5b-1;
// FR-TECH-3, FR-TECH-8, FR-AUTH-4, FR-DISP-27). The job as API-101 answers it (data.ts), kept on the phone for an open with no signal,
// with the technician's own waiting notes, photos and status laid over it at once (UI-SPECIFICATION 4.5 rule 6). Add note and Add
// photo open their sheets (SCR-TEC-05, -06); Finish job opens SCR-TEC-07; On my way, Arrived and No one home open their confirm sheets
// (today/Sheets.tsx, the app's 1 confirm sheet); Directions opens SCR-TEC-08 (P6-NATIVE-MAP-ME's). The photo viewer (CTL-TEC-04-11) is a sheet.
import { useFocusEffect, useNavigation, useRoute, type NavigationProp, type ParamListBase, type RouteProp } from '@react-navigation/native';
import { useCallback, useRef, useState, type ComponentRef } from 'react';
import { ActionSheetIOS, Image, Linking, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { T as Text, useBigText } from '../../ui/text-size.tsx';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import { Icon } from '../../ui/Icon.tsx';
import { useT, type T } from '../../ui/intl.tsx';
import { useLastTry } from '../../ui/last-try.ts';
import { Hint, Message } from '../../ui/kit.tsx';
import { lk, useLookDump } from '../../ui/look.ts';
import { color, type } from '../../ui/tokens.ts';
import { useApp } from '../../useApp.ts';
import type { AppState, NativeApp } from '../../core.ts';
import { jobData, useDemoNow, useDriveMinutes, useJob } from './hooks.ts';
import {
  clockWords, datePast, historyScrollY, noteWhen, shownAsToday, shownNotes, shownPhotos, shownStatus, windowWords, type JobStatus, type ShownPhoto,
} from './model.ts';
import { openDirections } from '../mapme/index.tsx';
import { useMapMe } from '../mapme/use-mapme.ts';
import { applyWaiting, canStartWay } from '../today/model.ts';
import type { JobRoutes } from './nav.ts';
import { stripRest, THUMB } from './strip.ts';
import { photoLabel as thumbLabel, photoSource, Thumb } from './Thumb.tsx';
import { barSubText, Group, GHead, JobBar, Lnk, NoSignal, PButton, Row, SButton, Scroll, Tx, WaitChip, jc } from './ui.tsx';

export const STATUS_WORD: Record<JobStatus, MessageKey> = {
  scheduled: 'tech.status.scheduled', on_the_way: 'tech.status.onTheWay', on_site: 'tech.status.onSite', done: 'tech.status.done',
  no_one_home: 'tech.status.noOneHome', canceled: 'tech.status.canceled',
};
const EQUIPMENT = new Set(['furnace', 'air_conditioner', 'water_heater', 'thermostat']);
const firstName = (n: string) => n.split(' ')[0] ?? n;

function StatusChip(props: { t: T; status: JobStatus; waiting: boolean }) {
  return (
    <View {...lk('job.bar.status', s.chip)}>
      <Text {...lk('job.bar.status.text', s.chipText)}>{props.t(STATUS_WORD[props.status])}</Text>
    </View>
  );
}

/** The look state of the screen when it is in the frame's state (Scheduled, read with signal, a note and a photo shown). */
function lookState(fromPhone: boolean, status: JobStatus, state: AppState, draft: string | null, notes: number, photos: number, firstOffice: boolean): string | null {
  if (fromPhone || !state.outbox.online || status !== 'scheduled' || notes === 0 || photos === 0) return null;
  if (!firstOffice) return null; // the frame's first note is an office note
  return draft ? 'job-draft' : 'job';
}

export function JobScreen() {
  const t = useT();
  const { app, state } = useApp();
  const nav = useNavigation<NavigationProp<ParamListBase>>();
  const { jobNumber, history } = useRoute<RouteProp<JobRoutes, 'Job'>>().params;
  // CTL-TEC-02-13 See history: the screen opens at the job's service history (once, when its heading is laid out).
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const big = useBigText();
  const atHistory = useRef(false);
  // The heading's y is measured inside the body; at big text the body sits in the outer scroll below the bar and the pin, so its own y is added (F-1688).
  const histY = useRef<{ body: number | null; head: number | null }>({ body: null, head: null });
  const goHistory = () => {
    const at = historyScrollY(big ? histY.current.body : 0, histY.current.head);
    if (!history || atHistory.current || at === null) return;
    atHistory.current = true;
    scroll.current?.scrollTo({ y: at, animated: false });
  };
  const { view, me, reload } = useJob(jobNumber, state);
  const [loadTries, setLoadTries] = useState(0);
  const lastTry = useLastTry(view.kind === 'load_failed', loadTries);
  const demoNow = useDemoNow(state);
  // CTL-TEC-04-13 is enabled as CTL-TEC-02-04 is: no other job is On the way or On site (F-1091 f). The day read (API-100) names the other jobs;
  // with no day on the phone nothing says another job is under way, so the button stays.
  const { data: dayRead } = useMapMe();
  const dayJobs = applyWaiting(dayRead.day?.data.jobs ?? [], state.outbox.waiting, state.outbox.lastSent);
  const [draft, setDraft] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ShownPhoto | null>(null);
  // F-1234: the photo strip rests at its end, where the newest photo is (strip.ts), when its content changes and when its width does.
  const strip = useRef<ComponentRef<typeof ScrollView>>(null);
  const stripSize = useRef({ content: 0, view: 0 });
  const restStrip = () => strip.current?.scrollTo({ x: stripRest(stripSize.current.content, stripSize.current.view), animated: false });
  useFocusEffect(useCallback(() => {
    setDraft(jobData().copies.draft(jobNumber));
  }, [jobNumber]));
  const lang = state.language;
  const job = view.kind === 'job' ? view.job : null;
  const st = job ? shownStatus(job, state.outbox.waiting) : null;
  // CTL-TEC-04-04 (F-1369, owner answer fa9c9833): Directions is the drive from the van to THIS job; hidden once the job is On site or ended.
  const driveTo = job && st && job.job.today && (st.status === 'scheduled' || st.status === 'on_the_way') ? jobNumber : null;
  const minutes = useDriveMinutes(driveTo);
  const notes = job ? shownNotes(job, state.outbox.waiting, me) : [];
  const photos = job ? shownPhotos(job, state.outbox.waiting, me) : [];
  useLookDump(job && st && view.kind === 'job' ? lookState(view.fromPhone, st.status, state, draft, notes.length, photos.length, notes[0]?.kind === 'office') : null);

  const back = () => nav.goBack();
  const plainBar = (title: string) => <JobBar id="job" back={t('tech.job.back')} onBack={back} title={title} />;
  if (view.kind === 'loading') {
    return <View style={s.screen}>{plainBar(t('tech.job.number', { job: jobNumber }))}</View>;
  }
  if (view.kind === 'load_failed') {
    return (
      <View style={s.screen}>
        {plainBar(t('tech.job.number', { job: jobNumber }))}
        <Scroll id="job.scroll">
          <Message id="job.state" tone="bad" icon="alert" text={t('job.loadError')} lastTry={lastTry && t('shell.error.lastTry', { time: lastTry })} link={{ label: t('shell.error.tryAgain'), onPress: () => { setLoadTries((n) => n + 1); reload(); }, own: true }} />
        </Scroll>
      </View>
    );
  }
  if (view.kind === 'not_on_phone' || view.kind === 'not_yours') {
    return (
      <View style={s.screen}>
        {plainBar(t('tech.job.number', { job: jobNumber }))}
        <Scroll id="job.scroll">
          {view.kind === 'not_on_phone' ? <NoSignal id="job.nosig" title={t('tech.sync.noSignal')} text={t('tech.sync.keepWorking')} /> : null}
          <Message id="job.state" tone="bad" icon={view.kind === 'not_yours' ? 'user' : 'signal'} text={t(view.kind === 'not_yours' ? 'tech.job.notYours' : 'tech.job.notOnPhone')} />
          {view.kind === 'not_yours' ? <Hint id="job.stateNote" text={t('tech.job.notYoursNote')} /> : null}
        </Scroll>
      </View>
    );
  }
  if (!job || !st) return null;

  // F-1034: a kept copy opened on a later demo day does not offer the number (CTL-TEC-04-03 says why instead).
  const phone = shownAsToday(job, demoNow, view.fromPhone) ? job.customer.phone : null;
  const open = st.status !== 'canceled';
  const ended = st.status === 'done' || st.status === 'no_one_home' || st.status === 'canceled';
  const service = t(job.job.serviceLabelKey as MessageKey);
  const position = job.job.position ? t('tech.job.position', { index: job.job.position.index, of: job.job.position.of, job: jobNumber }) : t('tech.job.number', { job: jobNumber });
  const call = () => {
    if (phone) void Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`);
  };
  const directions = () => {
    // SCR-TEC-08's 1 param shape (mapme MapTab.tsx): the leg into this job, from the van's position (no `from`), as the Today card opens it.
    if (driveTo !== null) openDirections(nav, driveTo);
  };
  const addNote = () => nav.navigate('JobNote', { jobNumber });
  const addPhoto = () => nav.navigate('JobPhoto', { jobNumber });
  const status = (kind: 'on_my_way' | 'arrived' | 'no_one_home') => nav.navigate('JobStatus', { jobNumber, kind, name: job.customer.name, version: job.job.version });
  // CTL-TEC-04-18: More, the iOS action sheet of the actions this screen already has.
  const more = () => {
    const items: { label: string; run: () => void }[] = [
      ...(phone ? [{ label: t('tech.job.call'), run: call }] : []),
      ...(driveTo !== null ? [{ label: t('tech.job.directions'), run: directions }] : []),
      ...(open ? [{ label: t('tech.job.addNote'), run: addNote }, { label: t('tech.job.addPhoto'), run: addPhoto }] : []),
    ];
    ActionSheetIOS.showActionSheetWithOptions({ options: [...items.map((i) => i.label), t('common.cancel')], cancelButtonIndex: items.length, title: t('tech.job.more') },
      (i) => items[i]?.run());
  };

  const endedLine = st.status === 'done' ? t('tech.job.doneAt', { time: clockWords(st.at ?? job.job.endedAt ?? job.job.window.end) })
    : st.status === 'no_one_home' ? t('tech.job.noOneHomeAt', { time: clockWords(st.at ?? job.job.endedAt ?? job.job.window.end) })
      : st.status === 'canceled' ? t('tech.job.canceled') : null;
  const eq = job.equipment;
  const eqName = (x: (typeof eq)[number]) => (EQUIPMENT.has(x.type) ? t(`tech.equipment.${x.type}` as MessageKey) : (x.details?.split('.')[0]?.split(',')[0] ?? x.type));
  const first = eq[0];
  const eqSmall = first ? [first.location, eq.length > 1 ? t('tech.job.alsoEquipment', { list: eq.slice(1, 2).map((x) => `${eqName(x)}${x.year ? `, ${x.year}` : ''}`).join('; ') }) : null].filter(Boolean).join('. ') : null;
  const photoLabel = (p: ShownPhoto) => thumbLabel(t, p, job.job.date, lang);

  const sub = (
    <>
      <Text {...lk('job.bar.sub', barSubText)}>{`${job.customer.address} - ${windowWords(job)} - ${service} - `}</Text>
      <StatusChip t={t} status={st.status} waiting={st.waiting} />
    </>
  );
  const moreButton = (
    <Pressable {...lk('job.more', s.more)} onPress={more} accessibilityRole="button" accessibilityLabel={t('tech.job.more')}>
      <Icon name="more" size={22} color={color.white} />
    </Pressable>
  );
  // 14.2 item 2: at the largest text sizes the bar, the content and the step buttons share 1 scroll (the bar and the pinned buttons would
  // otherwise fill the screen and leave the content no room); at every other size the bar and the buttons stay pinned as the frames draw them.
  const bar = (
    <JobBar id="job" back={t('tech.job.back')} onBack={back} title={job.customer.name} sub={sub} right={moreButton}
      mid={<Text {...lk('job.position', s.position)} numberOfLines={big ? undefined : 1}>{position}</Text>} />
  );
  const body = (
      <Scroll id="job.scroll" scrollRef={scroll} inline={big} onInlineLayout={(y) => { histY.current.body = y; goHistory(); }}>
        {state.outbox.online ? null : <NoSignal id="job.nosig" title={t('tech.sync.noSignal')} text={t('tech.sync.keepWorking')} />}
        {endedLine ? <Message id="job.ended" tone={st.status === 'canceled' ? 'bad' : 'ok'} icon={st.status === 'canceled' ? 'alert' : 'check'} text={endedLine} /> : null}
        {!ended && (driveTo !== null || phone) ? (
          <View {...lk('job.acts', [s.acts, big ? s.actsBig : null])}>
            {driveTo !== null ? <PButton id="job.dir" icon="nav" label={t('tech.job.directions')} small={minutes !== null ? t('tech.job.minutes', { n: minutes }) : null} onPress={directions} /> : null}
            {phone ? <PButton id="job.call" icon="phone" label={t('tech.job.call')} onPress={call} a11y={`${t('tech.job.call')} ${firstName(job.customer.name)}`} /> : null}
          </View>
        ) : null}
        {phone ? null : <Hint id="job.phoneLater" text={t('tech.job.phoneLater')} />}
        <View {...lk('job.cnote.card', s.card)}>
          <View {...lk('job.cnote', s.notebox)}>
            <Text {...lk('job.cnote.title', s.noteboxB)}>{t('tech.job.customerNote')}</Text>
            <Text {...lk('job.cnote.text', s.noteboxText)}>{job.customer.gettingIn ?? job.customer.notes[0]?.body ?? t('tech.job.noCustomerNotes')}</Text>
          </View>
        </View>
        <GHead id="job.ghead.eq" text={t('tech.job.equipment')} />
        <Group id="job.eq.grp">
          <Row id="job.eq.row" first>
            {first ? <Tx id="job.eq" b={`${eqName(first)}${first.year ? `, ${first.year}` : ''}`} small={eqSmall} /> : <Tx id="job.eq" b={t('tech.job.noEquipment')} />}
          </Row>
        </Group>
        <GHead id="job.ghead.hist" text={t('tech.job.historyShort')} onLayout={(e) => { histY.current.head = e.nativeEvent.layout.y; goHistory(); }} />
        <Group id="job.hist.grp">
          {job.history.length > 0 ? job.history.map((h, i) => (
            <Row key={`${h.date}-${i}`} id={i === 0 ? 'job.hist.row' : `job.hist.row.${i}`} first={i === 0}>
              <Tx id={i === 0 ? 'job.hist' : `job.hist.${i}`} b={`${datePast(h.date, lang)} - ${h.what ?? (h.serviceLabelKey ? t(h.serviceLabelKey as MessageKey) : '')}`} small={h.technician} />
            </Row>
          )) : <Row id="job.hist.row" first><Tx id="job.hist" b={t('tech.job.noHistory')} /></Row>}
        </Group>
        <GHead id="job.ghead.notes" text={t('tech.job.notesPhotos')} />
        <Group id="job.notes.grp">
          {notes.map((n, i) => {
            const by = n.kind === 'office' ? t('tech.job.officeNote', { author: n.author ?? '', at: noteWhen(n.at, job.job.date, lang) })
              : t('tech.job.byTech', { author: n.author ?? '', at: noteWhen(n.at, job.job.date, lang) });
            return (
            <Row key={n.key} id={i === 0 ? 'job.note.row' : `job.note.row.${i}`} first={i === 0}>
              <View style={s.tx} accessible accessibilityLabel={`${n.body}. ${by}`} accessibilityValue={{ text: n.waiting ? 'waiting' : n.kind }} testID={`job.note.${n.key.toLowerCase()}`}>
                <Text {...lk(i === 0 ? 'job.note.b' : `job.note.b.${i}`, s.txB)}>{n.body}</Text>
                <Text {...lk(i === 0 ? 'job.note.small' : `job.note.small.${i}`, s.txSmall)}>{by}</Text>
              </View>
              {n.waiting ? <WaitChip id={`job.note.wait.${i}`} text={t('tech.job.waitingToSend')} /> : null}
            </Row>
            );
          })}
          {draft && open ? (
            <Row id="job.draft.row" first={notes.length === 0}>
              <Lnk id="job.draft" label={t('tech.job.draftNative')} onPress={addNote} />
            </Row>
          ) : null}
          {open ? (
            <Row id="job.adds.row" first={notes.length === 0 && !draft}>
              <View {...lk('job.adds', [s.trailc, big ? s.trailcBig : null])}>
                <SButton id="job.addnote" icon="plus" iconStroke={2.4} label={t('tech.job.addNote')} onPress={addNote} />
                <SButton id="job.addphoto" icon="camera" label={t('tech.job.addPhoto')} onPress={addPhoto} />
              </View>
            </Row>
          ) : null}
          {photos.length > 0 ? (
            <Row id="job.media.row" first={notes.length === 0 && !(draft && open) && !open}>
              {/* CTL-TEC-04-10 (.tx.phs, kit 0.10, F-1371): a row of its own, the count, Photos (n), over the strip (72 x 54, 4 in view and a
                  peek of the 5th), which scrolls sideways for the rest and runs to the group's right edge. */}
              <View {...lk('job.phs', s.phs)}>
                <Text {...lk('job.phs.count', s.txSmall)}>{t('tech.job.photos', { n: photos.length })}</Text>
                <ScrollView ref={strip} horizontal style={s.thumbs} contentContainerStyle={s.thumbsIn} showsHorizontalScrollIndicator={false} testID="job.strip"
                  onContentSizeChange={(w) => {
                    stripSize.current.content = w;
                    restStrip();
                  }}
                  onLayout={(e) => {
                    const w = e.nativeEvent.layout.width;
                    if (w === stripSize.current.view) return;
                    stripSize.current.view = w;
                    restStrip();
                  }}>
                  {photos.map((p, i) => (
                    <Thumb key={p.key} app={app} p={p} id={i === 0 ? 'job.thumb' : `job.thumb.${i}`} style={s.thumb} label={photoLabel(p)} onPress={() => setViewer(p)} />
                  ))}
                </ScrollView>
              </View>
            </Row>
          ) : null}
        </Group>
        {ended || st.status === 'on_site' ? null : <Hint id="job.why3" center text={t('tech.job.why3')} />}
      </Scroll>
  );
  // Kit 0.10 (owner answer d6bfc18c, "Pin it", DK-58): the action slot is pinned in a bar just above the tab bar, so On my way (later
  // Arrived, Finish job) shows whatever the screen holds; the content above scrolls on its own. A state with none shows no bar.
  const pin = ended ? null : (
        <View {...lk('job.pin', s.pin)}>
            {st.status === 'scheduled' && canStartWay(dayJobs, { jobNumber, status: st.status }) ? (
              <Pressable {...lk('job.omw', s.omw)} onPress={() => status('on_my_way')} accessibilityRole="button" accessibilityLabel={t('tech.job.onMyWay')}>
                <Icon id="job.omw.icon" name="truck" size={23} color={color.white} strokeWidth={2.2} />
                <Text {...lk('job.omw.text', s.omwText)}>{t('tech.job.onMyWay')}</Text>
              </Pressable>
            ) : null}
            <View {...lk('job.acts2', [s.acts2, big ? s.acts2Big : null])}>
              {st.status === 'on_site'
                ? <SButton id="job.finish" icon="check" iconStroke={2.6} label={t('tech.job.finish')} onPress={() => nav.navigate('Finish', { jobNumber })} />
                : <SButton id="job.arrived" icon="pin" label={t('tech.job.arrived')} onPress={() => status('arrived')} />}
              <SButton id="job.noh" label={t('tech.job.noOneHome')} off={st.status !== 'on_site'} onPress={() => status('no_one_home')} hint={t('tech.job.why3')} />
              {st.status === 'on_site' ? null : <SButton id="job.finish" label={t('tech.job.finish')} off onPress={() => undefined} hint={t('tech.job.why3')} />}
            </View>
        </View>
      );
  return (
    <View style={s.screen}>
      {big ? (
        <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>{bar}{pin}{body}</ScrollView>
      ) : (
        <>{bar}{body}{pin}</>
      )}
      {viewer ? <PhotoViewer app={app} p={viewer} label={photoLabel(viewer)} onClose={() => setViewer(null)} t={t} /> : null}
    </View>
  );
}

/** CTL-TEC-04-11: the photo viewer sheet (the full image, its alt text, Close). */
function PhotoViewer(props: { app: NativeApp; p: ShownPhoto; label: string; onClose: () => void; t: T }) {
  const src = photoSource(props.app, props.p, 'full');
  return (
    <Modal animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      <View {...lk('viewer', s.viewer)} accessibilityViewIsModal>
        <Text style={s.viewerTitle} accessibilityRole="header">{props.t('tech.job.photoTitle')}</Text>
        <View style={s.viewerImage}>{src ? <Image source={src} style={StyleSheet.absoluteFill} resizeMode="contain" accessibilityLabel={props.label} /> : null}</View>
        <Text {...lk('viewer.alt', s.viewerAlt)}>{props.label}</Text>
        <SButton id="viewer.close" label={props.t('tech.job.close')} wide onPress={props.onClose} />
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.screen },
  position: type(400, 13, 18, jc.teal200),
  more: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  chip: { backgroundColor: color.white, borderWidth: 1, borderColor: jc.schedLine, borderRadius: 999, paddingVertical: 1, paddingHorizontal: 8, columnGap: 5, rowGap: 5, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  chipText: type(700, 12, 18, jc.schedInk),
  acts: { marginTop: 7, flexDirection: 'row', columnGap: 8, rowGap: 8 },
  actsBig: { flexDirection: 'column' },
  card: { backgroundColor: color.white, borderWidth: 1, borderColor: color.ink200, borderRadius: 16, paddingVertical: 9, paddingHorizontal: 13, overflow: 'hidden' },
  notebox: { backgroundColor: jc.orange50, borderWidth: 1, borderColor: jc.orange100, borderRadius: 10, paddingVertical: 5, paddingHorizontal: 10, overflow: 'hidden' },
  noteboxB: { ...type(700, 11.5, 15.525, jc.orange700), textTransform: 'uppercase', letterSpacing: 0.575 },
  noteboxText: type(400, 13.5, 18.225, color.ink800),
  tx: { flex: 1, minWidth: 0 },
  txB: type(680, 15, 19.5, color.ink900),
  txSmall: type(400, 13, 16.9, color.ink600),
  phs: { flex: 1, minWidth: 0, rowGap: 6, columnGap: 6 },
  thumbs: { flexGrow: 0, flexShrink: 0, marginRight: -12 },
  thumbsIn: { columnGap: THUMB.gap, rowGap: THUMB.gap, alignItems: 'center', paddingRight: 12 },
  thumb: { width: THUMB.width, height: THUMB.height, borderRadius: 10, overflow: 'hidden' },
  trailc: { flex: 1, flexDirection: 'row', columnGap: 8, rowGap: 8, alignItems: 'center' },
  trailcBig: { flexDirection: 'column', alignItems: 'stretch' },
  pin: { backgroundColor: color.white, borderTopWidth: 1, borderTopColor: color.ink200, paddingTop: 1, paddingHorizontal: 12, paddingBottom: 8 },
  omw: {
    marginTop: 7, minHeight: 50, borderRadius: 14, backgroundColor: jc.orange600, paddingVertical: 4, paddingHorizontal: 12, columnGap: 10, rowGap: 10,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
  },
  omwText: { ...type(750, 19, 26.6, color.white), textAlign: 'center' },
  acts2: { marginTop: 7, flexDirection: 'row', columnGap: 6, rowGap: 6 },
  acts2Big: { flexDirection: 'column' },
  viewer: { flex: 1, backgroundColor: color.white, padding: 18, rowGap: 12 },
  viewerTitle: type(700, 20, 28, color.ink900),
  viewerImage: { flex: 1, borderRadius: 12, overflow: 'hidden', backgroundColor: color.ink900 },
  viewerAlt: type(400, 14, 19.6, color.ink600),
});
