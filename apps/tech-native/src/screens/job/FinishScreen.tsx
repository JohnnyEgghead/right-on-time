// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-07 Finish job, native (DK-117 "SCR-TEC-07 Finish job, iPhone: Editing" and its A part row, Signed, Confirming and Invalid
// details; state content from DK-112; FR-TECH-14, FR-BILL-3's technician path, FR-TECH-3, FR-TECH-4, invariant 10). Every entry (the
// work-done lines, part rows from the phone's copy of the fixed parts list with quantities, or No parts used; labor; the customer's
// signature) is kept on the phone at once (copies.ts), with no signal too, until the job is finished. Finish job checks parts or No
// parts used (FR-BILL-3) and opens the confirm step; Finish and send to billing enters the Finished item (parts, labor and the
// work-done lines, which go to billing) and the signature as its own photo-like item (SD-32's PNG, never sent to billing,
// FR-TECH-14) through the shared engine. A finish the server refused for want of parts (F-1025, parts_required) reopens here with the
// message and what was sent, and its correction replaces it under its own key.
import { FinishLeave, signatureOwed } from '@bw/outbox/src/items/native.ts';
import { useNavigation, useRoute, type NavigationProp, type ParamListBase, type RouteProp } from '@react-navigation/native';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { T as Text } from '../../ui/text-size.tsx';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import { Icon } from '../../ui/Icon.tsx';
import { useT } from '../../ui/intl.tsx';
import { Message } from '../../ui/kit.tsx';
import { lk, useLookDump } from '../../ui/look.ts';
import { color, type } from '../../ui/tokens.ts';
import { useApp } from '../../useApp.ts';
import { jobData, useDemoNow, useJob, useParts } from './hooks.ts';
import {
  addPart, checkFinish, clockWords, demoWire, draftFromRefused, emptyFinish, findParts, finishWaits, laborFrom, laborMinutes, laborWords,
  refusedFinish, shownNotes, shownPhotos, stepQuantity, type FinishDraft, type Part,
} from './model.ts';
import type { JobRoutes } from './nav.ts';
import { SignaturePad } from './SignaturePad.tsx';
import { photoLabel, Thumb } from './Thumb.tsx';
import { signaturePng, signed, type Stroke } from './signature.ts';
import { barSubText, CloseIcon, GHead, Group, JobBar, Lnk, NButton, Row, Scroll, SButton, Tx, WaitChip, jc } from './ui.tsx';

type Msg = 'parts' | 'labor' | 'server' | 'sig' | null;

export function FinishScreen() {
  const t = useT();
  const { app, state } = useApp();
  const nav = useNavigation<NavigationProp<ParamListBase>>();
  const jobNumber = useRoute<RouteProp<JobRoutes, 'Finish'>>().params.jobNumber;
  const { view, me } = useJob(jobNumber, state);
  const { parts, failed: partsFailed } = useParts();
  const demoNow = useDemoNow(state);
  const copies = jobData().copies;
  const kept = useMemo(() => copies.finish(jobNumber), [copies, jobNumber]);
  const [d, setD] = useState<FinishDraft>(kept ?? emptyFinish(jobNumber));
  const [find, setFind] = useState('');
  const qtyViews = useRef(new Map<string, ComponentRef<typeof View> | null>()); // CTL-TEC-07-02: the quantity control of each listed part
  const [msg, setMsg] = useState<Msg>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  // F-1932: what of this screen's own finish is kept, for the retry after an entry that was not.
  const [leaving] = useState(() => new FinishLeave(app));
  const [editLabor, setEditLabor] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const lines = useRef<(ComponentRef<typeof TextInput> | null)[]>([]);
  const focusLine = useRef<number | null>(null);

  // F-1025: a finish the server refused for want of parts reopens with the message and, when no entries are kept, with what was sent.
  const refused = refusedFinish(jobNumber, state.outbox.waiting);
  const prefilled = useRef(false);
  useEffect(() => {
    if (!refused) return;
    setMsg('server');
    if (!kept && !prefilled.current && parts !== null) {
      prefilled.current = true;
      setD(draftFromRefused(jobNumber, refused.payload, parts));
    }
  }, [refused, kept, parts, jobNumber]);
  useEffect(() => {
    if (focusLine.current !== null) {
      lines.current[focusLine.current]?.focus();
      focusLine.current = null;
    }
  });

  /** Every change is kept on the phone at once (CTL-TEC-07-10, -11, -14); a failed write says so. */
  const keep = useCallback((draft: FinishDraft) => {
    const next = leaving.entriesOf(d, draft, refused !== null);
    try {
      copies.saveFinish(next);
    } catch {
      setMsg('sig');
    }
    setD(next);
  }, [copies, leaving, refused, d]);

  const labor = useMemo(() => {
    if (d.hours !== null && d.minutes !== null) return { hours: d.hours, minutes: d.minutes };
    const arrived = view.kind === 'job' ? view.job.job.arrivedAt : null;
    return demoNow === null ? { hours: '', minutes: '' } : laborFrom(arrived, demoNow);
  }, [d.hours, d.minutes, view, demoNow]);

  const isSigned = d.signature !== null && signed(d.signature.strokes);
  const hasParts = d.parts.length > 0;
  const look = view.kind !== 'job' || saving ? null
    : confirming ? 'finish-confirm'
      : msg === 'parts' ? 'finish-invalid'
        : isSigned ? 'finish-signed'
          : hasParts ? 'finish-part'
            : msg === null && !d.noPartsUsed && d.workDone.length === 1 && d.workDone[0] !== '' ? 'finish-editing' : null;
  useLookDump(look);
  // A finish already waiting on the phone closes the screen to the job; never while this screen's own finish is leaving or its signature is not kept yet (owed).
  // A screen opened again after its finish was kept and its signature was not (F-1976) still owes the signature: the finish is not entered twice.
  const owedAgain = refused === null && signatureOwed(state.outbox.waiting, jobNumber, isSigned);
  useEffect(() => {
    if (owedAgain) leaving.resume();
  }, [owedAgain, leaving]);
  const closeNow = view.kind === 'job' && finishWaits(jobNumber, state.outbox.waiting) && !refused && msg !== 'server' && !saving && !leaving.owed && !owedAgain;
  useEffect(() => {
    if (closeNow) nav.goBack();
  }, [closeNow, nav]);

  const back = () => nav.goBack();
  if (view.kind !== 'job') {
    return (
      <View style={s.screen}>
        <JobBar id="fin" back={t('tech.finish.backToJob')} onBack={back} title={t('tech.finish.title')} />
        {view.kind === 'loading' ? null : (
          <Scroll id="fin.scroll"><Message id="fin.state" tone="bad" icon="signal" text={t(view.kind === 'not_yours' ? 'tech.job.notYours' : 'tech.job.notOnPhone')} /></Scroll>
        )}
      </View>
    );
  }
  const job = view.job;
  const service = t(job.job.serviceLabelKey as MessageKey);
  if (closeNow) return null;
  const results = parts ? findParts(parts, find) : [];
  const techNotes = shownNotes(job, state.outbox.waiting, me).filter((n) => n.kind === 'technician');
  const photos = shownPhotos(job, state.outbox.waiting, me);
  const minutes = laborMinutes(labor.hours, labor.minutes);
  const lw = laborWords(minutes ?? 0);

  const pick = (p: Part) => {
    const r = addPart(d.parts, p);
    keep({ ...d, parts: r.rows, noPartsUsed: false });
    setFind('');
    setMsg(null);
    // CTL-TEC-07-02: a part already listed is not added again; the focus moves to its quantity (F-1091 c).
    if (!r.added) {
      const node = findNodeHandle(qtyViews.current.get(p.partId) ?? null);
      if (typeof node === 'number') AccessibilityInfo.setAccessibilityFocus(node);
    }
  };
  const tryFinish = () => {
    const c = checkFinish(d, labor);
    if (!c.ok) {
      setMsg(c.on);
      return;
    }
    setMsg(null);
    setConfirming(true);
  };
  const confirm = async () => {
    const c = checkFinish(d, labor);
    if (!c.ok || saving) return;
    setSaving(true);
    try {
      const signature = d.signature && isSigned ? signaturePng(d.signature.strokes, d.signature.width, d.signature.height) : null;
      await leaving.leave({ jobNumber, baseVersion: job.job.version, payload: c.payload, refusedKey: refused?.key ?? null, signature });
      copies.forgetFinish(jobNumber);
      back();
    } catch {
      setSaving(false);
      setConfirming(false);
      setMsg('sig');
    }
  };
  const sign = (strokes: Stroke[], size: { width: number; height: number }) => {
    const at = demoNow === null ? (d.signature?.at ?? '') : demoWire(demoNow, job.job.zone);
    keep({ ...d, signature: { strokes, width: size.width, height: size.height, at } });
  };
  const setLine = (i: number, v: string) => keep({ ...d, workDone: d.workDone.map((l, j) => (j === i ? v : l)) });
  const addLine = () => {
    focusLine.current = d.workDone.length;
    keep({ ...d, workDone: [...d.workDone, ''] });
  };
  const removeLine = (i: number) => {
    const rest = d.workDone.filter((_, j) => j !== i);
    keep({ ...d, workDone: rest.length > 0 ? rest : [''] });
  };
  const setLabor = (hours: string, mins: string) => keep({ ...d, hours, minutes: mins });

  const sub = <Text {...lk('fin.bar.sub', barSubText)}>{`${job.customer.name} - ${service}`}</Text>;
  return (
    <View style={s.screen}>
      <JobBar id="fin" back={t('tech.finish.backToJob')} onBack={back} title={t('tech.finish.title')} sub={sub} />
      <Scroll id="fin.scroll" scrollEnabled={!drawing}>
        {msg === 'server' ? <Message id="fin.server" tone="bad" icon="alert" text={t('tech.finish.partsRequiredServer')} /> : null}
        <GHead id="fin.ghead.work" text={t('tech.finish.workDone')} />
        <Group id="fin.work.grp">
          {d.workDone.map((l, i) => (
            <Row key={i} id={i === 0 ? 'fin.line.row' : `fin.line.row.${i}`} first={i === 0}>
              <TextInput ref={(r) => { lines.current[i] = r; }} {...lk(i === 0 ? 'fin.line.value' : `fin.line.value.${i}`, s.line)} value={l}
                onChangeText={(v) => setLine(i, v)} accessibilityLabel={t('tech.finish.lineLabel', { n: i + 1 })} multiline={false} returnKeyType="done" />
              <Pressable {...lk(i === 0 ? 'fin.line.remove' : `fin.line.remove.${i}`, s.navbtn)} onPress={() => removeLine(i)} accessibilityRole="button"
                accessibilityLabel={t('tech.finish.removeLine', { n: i + 1 })}>
                <CloseIcon id={i === 0 ? 'fin.line.remove.icon' : `fin.line.remove.icon.${i}`} size={22} color={color.white} />
              </Pressable>
            </Row>
          ))}
          <Row id="fin.addline" first={false} onPress={addLine} label={t('tech.finish.addLine')}>
            <Icon id="fin.addline.icon" name="plus" size={18} color={color.ink900} strokeWidth={2.4} />
            <Text {...lk('fin.addline.text', s.addText)}>{t('tech.finish.addLine')}</Text>
          </Row>
        </Group>
        <GHead id="fin.ghead.parts" text={t('tech.finish.parts')} />
        {d.parts.length > 0 ? (
          <Group id="fin.part.grp">
            {d.parts.map((p, i) => (
              <Row key={p.partId} id={i === 0 ? 'fin.part.row' : `fin.part.row.${i}`} first={i === 0} gap={8}>
                <View style={s.tx}>
                  <Text {...lk(i === 0 ? 'fin.part.name' : `fin.part.name.${i}`, s.txB)}>{p.name}</Text>
                  <Text {...lk(i === 0 ? 'fin.part.code' : `fin.part.code.${i}`, s.txSmall)}>{p.code}</Text>
                </View>
                <View style={s.trailc}>
                  <View ref={(v) => { qtyViews.current.set(p.partId, v); }} {...lk(i === 0 ? 'fin.part.qty' : `fin.part.qty.${i}`, s.stepn)} accessible accessibilityRole="adjustable" accessibilityLabel={t('tech.finish.quantity', { part: p.name })}
                    accessibilityValue={{ text: String(p.quantity) }}
                    accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                    onAccessibilityAction={(e) => keep({ ...d, parts: stepQuantity(d.parts, p.partId, e.nativeEvent.actionName === 'increment' ? 1 : -1) })}>
                    <Pressable {...lk(i === 0 ? 'fin.part.less' : `fin.part.less.${i}`, s.step)} onPress={() => keep({ ...d, parts: stepQuantity(d.parts, p.partId, -1) })}>
                      <Text {...lk(i === 0 ? 'fin.part.less.text' : `fin.part.less.text.${i}`, s.stepText)}>-</Text>
                    </Pressable>
                    <Text {...lk(i === 0 ? 'fin.part.n' : `fin.part.n.${i}`, s.stepN)}>{p.quantity}</Text>
                    <Pressable {...lk(i === 0 ? 'fin.part.more' : `fin.part.more.${i}`, s.step)} onPress={() => keep({ ...d, parts: stepQuantity(d.parts, p.partId, 1) })}>
                      <Text {...lk(i === 0 ? 'fin.part.more.text' : `fin.part.more.text.${i}`, s.stepText)}>+</Text>
                    </Pressable>
                  </View>
                  <Lnk id={i === 0 ? 'fin.part.remove' : `fin.part.remove.${i}`} label={t('tech.finish.remove', { part: '' }).trim()} onPress={() => keep({ ...d, parts: d.parts.filter((x) => x.partId !== p.partId) })} />
                </View>
              </Row>
            ))}
          </Group>
        ) : null}
        <Group id="fin.parts.grp">
          <Row id="fin.find" first>
            <Icon id="fin.find.icon" name="search" size={18} color={color.ink900} />
            <TextInput {...lk('fin.find.value', s.find)} value={find} onChangeText={setFind} placeholder={t('tech.finish.find')} placeholderTextColor={color.ink600}
              editable={!d.noPartsUsed} accessibilityLabel={t('tech.finish.find')} autoCorrect={false} autoCapitalize="none" />
          </Row>
          {results.map((p, i) => (
            <Row key={p.partId} id={`fin.result.${i}`} first={false} onPress={() => pick(p)} label={`${p.name}, ${p.code}`}>
              <Tx id={`fin.result.${i}`} b={p.name} small={p.code} />
            </Row>
          ))}
          {find.trim() !== '' && parts !== null && results.length === 0 ? (
            <Row id="fin.nomatch" first={false}><Tx id="fin.nomatch" b={t('tech.finish.noMatch', { text: find.trim() })} /></Row>
          ) : null}
          {parts === null && partsFailed ? <Row id="fin.partsfailed" first={false}><Tx id="fin.partsfailed" b={t('job.finish.partsError')} /></Row> : null}
          {parts === null && !partsFailed ? <Row id="fin.nocopy" first={false}><Tx id="fin.nocopy" b={t('tech.finish.noCopy')} /></Row> : null}
          <Row id="fin.noparts" first={false}>
            <Text {...lk('fin.noparts.text', [s.txB, s.flex])}>{t('tech.finish.noPartsUsed')}</Text>
            <View {...lk('fin.noparts.switch', [s.switchBox, { backgroundColor: d.noPartsUsed ? color.teal600 : color.ink400 }])}>
              <Switch value={d.noPartsUsed} disabled={hasParts} onValueChange={(v) => { keep({ ...d, noPartsUsed: v }); setMsg(null); }}
                trackColor={{ false: color.ink400, true: color.teal600 }} ios_backgroundColor={color.ink400} accessibilityLabel={t('tech.finish.noPartsUsed')}
                testID="fin.noparts.toggle" />
            </View>
          </Row>
        </Group>
        <GHead id="fin.ghead.labor" text={t('tech.finish.labor')} />
        <Group id="fin.labor.grp">
          <Row id="fin.labor.row" first onPress={() => setEditLabor(true)} label={t('tech.finish.labor')} value={minutes === null ? '' : t('tech.finish.laborValue', { h: lw.h, m: lw.m })}>
            <Tx id="fin.labor" b={minutes === null ? t('tech.finish.typeLabor') : t('tech.finish.laborValue', { h: lw.h, m: lw.m })}
              small={job.job.arrivedAt ? t('tech.finish.fromArrived', { time: clockWords(job.job.arrivedAt) }) : null} />
          </Row>
          {editLabor ? (
            <Row id="fin.labor.edit" first={false}>
              <TextInput {...lk('fin.labor.hours', s.num)} value={labor.hours} onChangeText={(v) => setLabor(v, labor.minutes)} keyboardType="number-pad" accessibilityLabel={t('tech.finish.hours')} />
              <Text style={s.txSmall}>{t('tech.finish.hr')}</Text>
              <TextInput {...lk('fin.labor.minutes', s.num)} value={labor.minutes} onChangeText={(v) => setLabor(labor.hours, v)} keyboardType="number-pad" accessibilityLabel={t('tech.finish.minutes')} />
              <Text style={s.txSmall}>{t('tech.finish.min')}</Text>
            </Row>
          ) : null}
        </Group>
        {msg === 'labor' ? <Message id="fin.labor.err" tone="bad" icon="alert" text={t('tech.finish.needLabor')} /> : null}
        <GHead id="fin.ghead.sig" text={t('tech.finish.signature')} />
        {isSigned && d.signature ? (
          <View {...lk('fin.signed', s.signedRow)}>
            <Text {...lk('fin.signed.text', [s.txB, s.flex])}>{t('tech.finish.signed', { name: job.customer.name, time: d.signature.at ? clockWords(d.signature.at) : '' })}</Text>
            <Lnk id="fin.signed.clear" label={t('tech.finish.clear')} onPress={() => keep({ ...d, signature: null })} />
          </View>
        ) : null}
        <SignaturePad strokes={d.signature?.strokes ?? []} hint={t('tech.finish.signHere')} label={t('tech.finish.signature')} onStroke={sign} onDrawing={setDrawing} />
        {msg === 'sig' ? <Message id="fin.sig.err" tone="bad" icon="alert" text={t('tech.finish.sigFailed')} /> : null}
        {msg === 'parts' ? <Message id="fin.err" tone="bad" icon="alert" text={t('tech.finish.needPartsNative')} /> : null}
        <Pressable {...lk('fin.finish', s.primary)} onPress={tryFinish} accessibilityRole="button" accessibilityLabel={t('tech.finish.finish')}>
          <Icon id="fin.finish.icon" name="check" size={19} color={color.white} strokeWidth={2.6} />
          <Text {...lk('fin.finish.text', s.primaryText)}>{t('tech.finish.finish')}</Text>
        </Pressable>
        <Text {...lk('fin.finishNote', s.finishNote)}>{t('tech.finish.finishNote')}</Text>
        <GHead id="fin.ghead.notes" text={t('tech.finish.notes', { n: techNotes.length })} />
        <Group id="fin.notes.grp">
          {techNotes.length === 0 ? <Row id="fin.notes.none" first><Tx id="fin.notes.none" b={t('tech.finish.noNotes')} /></Row> : techNotes.map((n, i) => (
            <Row key={n.key} id={`fin.note.${i}`} first={i === 0}>
              <Tx id={`fin.note.${i}`} b={n.body} small={clockWords(n.at)} />
              {n.waiting ? <WaitChip id={`fin.note.wait.${i}`} text={t('tech.job.waitingToSend')} /> : null}
            </Row>
          ))}
          <Row id="fin.addnote.row" first={false}>
            <SButton id="fin.addnote" icon="plus" iconStroke={2.4} label={t('tech.job.addNote')} onPress={() => nav.navigate('JobNote', { jobNumber })} />
          </Row>
        </Group>
        {photos.length > 0 ? (
          <>
            <GHead id="fin.ghead.photos" text={t('tech.finish.photos', { n: photos.length })} />
            <Group id="fin.photos.grp">
              <Row id="fin.photos" first>
                {/* CTL-TEC-07-16: a thumbnail of each of the job's photos, own unsent ones marked Waiting to send (display only). */}
                <ScrollView horizontal style={s.thumbs} contentContainerStyle={s.thumbsIn} showsHorizontalScrollIndicator={false}>
                  {photos.map((p, i) => (
                    <Thumb key={p.key} app={app} p={p} id={`fin.photo.${i}`} style={s.thumb}
                      label={photoLabel(t, p, job.job.date, state.language)} />
                  ))}
                </ScrollView>
              </Row>
            </Group>
          </>
        ) : null}
      </Scroll>
      {confirming ? (
        <View style={s.dim}>
          <View {...lk('fin.confirm', s.confirm)} accessibilityViewIsModal>
            <Text {...lk('fin.confirm.title', s.confirmTitle)} accessibilityRole="header">{t('tech.finish.confirmTitle')}</Text>
            <Text {...lk('fin.confirm.why', s.confirmWhy)}>{t('tech.finish.cannotChange')}</Text>
            <NButton id="fin.confirm.ok" label={t('tech.finish.confirm')} pri busy={saving} onPress={() => void confirm()} />
            <NButton id="fin.confirm.back" label={t('tech.finish.goBack')} onPress={() => setConfirming(false)} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.screen },
  tx: { flex: 1, minWidth: 0 },
  flex: { flex: 1 },
  txB: type(680, 15, 19.5, color.ink900),
  txSmall: type(400, 13, 16.9, color.ink600),
  thumbs: { flexGrow: 1, flexShrink: 1 },
  thumbsIn: { columnGap: 6, rowGap: 6, alignItems: 'center' },
  thumb: { width: 64, height: 44, borderRadius: 12, overflow: 'hidden' },
  line: { ...type(680, 15, 19.5, color.ink900), flex: 1, padding: 0, minHeight: 44 },
  navbtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  addText: type(650, 15, 21, color.teal700),
  find: { ...type(400, 13, 16.9, color.ink600), flex: 1, padding: 0, minHeight: 34 },
  trailc: { flexDirection: 'row', alignItems: 'center', columnGap: 6, rowGap: 6 },
  stepn: { width: 104, height: 34, borderRadius: 9, backgroundColor: jc.ink150, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  step: { width: 40, height: 34, alignItems: 'center', justifyContent: 'center' },
  stepText: type(400, 19, 26.6, color.ink800),
  stepN: { ...type(700, 14, 19.6, color.ink900), width: 24, textAlign: 'center' },
  switchBox: { width: 51, height: 31, borderRadius: 16 },
  num: { ...type(680, 15, 19.5, color.ink900), width: 56, height: 34, paddingHorizontal: 8, borderWidth: 1, borderColor: color.ink400, borderRadius: 9, backgroundColor: color.white },
  signedRow: { flexDirection: 'row', alignItems: 'center', columnGap: 8, rowGap: 8, paddingVertical: 7, paddingHorizontal: 12, minHeight: 48 },
  primary: {
    marginTop: 14, minHeight: 52, borderRadius: 14, backgroundColor: color.teal700, paddingVertical: 4, paddingHorizontal: 12, columnGap: 9, rowGap: 9,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
  },
  primaryText: { ...type(720, 18, 25.2, color.white), textAlign: 'center' },
  finishNote: { ...type(400, 12, 15.6, color.ink600), textAlign: 'center', marginTop: 4 },
  dim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(17,24,39,0.35)', justifyContent: 'flex-end' },
  confirm: { backgroundColor: color.white, borderTopLeftRadius: 14, borderTopRightRadius: 14, paddingTop: 18, paddingHorizontal: 18, paddingBottom: 110, rowGap: 10 },
  confirmTitle: type(700, 14, 19.6, color.ink900),
  confirmWhy: type(400, 14, 19.6, color.ink900),
});
