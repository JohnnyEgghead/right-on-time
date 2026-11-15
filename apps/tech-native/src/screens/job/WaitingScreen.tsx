// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-09 Waiting to send, native (DK-117 "SCR-TEC-09 Waiting to send, iPhone: Waiting, offline"; state content from DK-111;
// FR-TECH-4, FR-TECH-6, FR-TECH-7, invariant 1). Read from the phone's file store only: every item not yet on the server, in entry
// order, with its kind, job, customer, entry time in demo time and status word; an item waiting over 24 hours of the phone's real time
// is marked; today's answers the technician should see (listed for the office, history only, not added after a reset) stay listed.
// F-985: an item whose file no longer parses is listed too (it stays on the phone and is never sent), and the count counts it. Send
// now runs the engine's send; How sending works says what the native app can do (it sends for a while after the app is left).
import { useNavigation, type NavigationProp, type ParamListBase } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { T as Text } from '../../ui/text-size.tsx';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import { OLD_ITEM_MS, type AnsweredItem, type QueuedItem } from '@bw/outbox/src/items/native.ts';
import { realNow } from '@bw/time';
import { waitingTotal } from '../../core.ts';
import { useT } from '../../ui/intl.tsx';
import { Hint } from '../../ui/kit.tsx';
import { lk, useLookDump } from '../../ui/look.ts';
import { color, type } from '../../ui/tokens.ts';
import { useApp } from '../../useApp.ts';
import { jobData, useDemoNow } from './hooks.ts';
import { enteredWords, isRefusedFinish } from './model.ts';
import { Group, InfoBox, JobBar, NoSignal, Row, Scroll, SButton, Tx, WaitChip } from './ui.tsx';

/** Today's answers the screen keeps showing: what the office was told, what sent with no text, what the reset did not add. */
const KEPT_RESULTS = new Set(['flagged', 'history_only', 'world_reset']);

export function WaitingScreen() {
  const t = useT();
  const { app, state } = useApp();
  const nav = useNavigation<NavigationProp<ParamListBase>>();
  const outbox = state.outbox;
  const demoNow = useDemoNow(state);
  const [answered, setAnswered] = useState<AnsweredItem[]>([]);
  const [clicked, setClicked] = useState(false);
  useEffect(() => {
    void app.answered().then(setAnswered, () => undefined);
  }, [app, outbox.lastSent]);
  useEffect(() => {
    if (!outbox.sending) setClicked(false);
  }, [outbox.sending]);
  const n = waitingTotal(state);
  useLookDump(!outbox.online && outbox.waiting.length >= 2 ? 'waiting-offline' : null);

  const lang = state.language;
  const name = (job: number) => jobData().copies.job(job)?.customer.name ?? null;
  const title = (k: QueuedItem['kind'], text?: string) => (text !== undefined ? t('tech.waiting.noteTitle', { text }) : t(`tech.waiting.kind.${k}` as MessageKey));
  const where = (job: number, at: string) => {
    const who = name(job);
    const time = enteredWords(at, demoNow, lang);
    return who ? t('tech.waiting.where', { job, name: who, time }) : t('tech.waiting.whereNoName', { job, time });
  };
  const sending = outbox.sending && (clicked || outbox.waiting.length > 0);
  const now = realNow('tech_waiting_banner').epochMilliseconds;
  // F-1033: only the signed-in person's answers (the engine's userId; unknown yet: none).
  const kept = answered.filter((a) => KEPT_RESULTS.has(a.result) && (outbox.userId === undefined || (outbox.userId !== null && a.userId === outbox.userId)));
  const recentSent = outbox.lastSent.filter((a) => !KEPT_RESULTS.has(a.result));
  const rowId = (i: number) => (i === 0 ? 'wait.row' : i === 1 ? 'wait.row2' : `wait.row.${i}`);
  const rows: React.ReactNode[] = [];
  for (const a of recentSent) {
    rows.push(
      <Row key={`s-${a.key}`} id={`wait.sent.${a.key}`} first={rows.length === 0}>
        <Tx id={`wait.sent.${a.key}`} b={title(a.kind)} small={t('tech.waiting.job', { job: a.jobNumber })} />
        <WaitChip id={`wait.sent.state.${a.key}`} text={t('tech.waiting.sent')} />
      </Row>,
    );
  }
  outbox.waiting.forEach((i, k) => {
    const old = now - i.enteredRealMs > OLD_ITEM_MS;
    const refused = i.lastTry?.outcome === 'refused';
    const retry = i.lastTry && !refused;
    const why = refused ? t(i.lastTry?.code === 'parts_required' ? 'tech.finish.partsRequiredServer' : 'tech.waiting.refused')
      : old ? t('tech.waiting.oldWhy') : retry ? t('tech.waiting.retry') : null;
    // F-1025: a finish refused for parts opens its job's finish screen with the message (UI-SPECIFICATION 4.5 rule 10).
    const open = isRefusedFinish(i) ? () => nav.navigate('Today', { screen: 'Finish', params: { jobNumber: i.jobNumber }, initial: false }) : undefined;
    const id = rowId(k);
    rows.push(
      <Row key={i.key} id={id} first={rows.length === 0} {...(open ? { onPress: open, label: title(i.kind) } : {})}>
        <View style={s.tx} accessible accessibilityLabel={title(i.kind, i.kind === 'note' ? i.payload.text : undefined)} accessibilityValue={{ text: sending ? 'sending' : refused ? 'refused' : 'waiting' }}
          testID={`wait.item.${i.key}`}>
          <Text {...lk(`${id}.b`, s.txB)}>{title(i.kind, i.kind === 'note' ? i.payload.text : undefined)}</Text>
          <Text {...lk(`${id}.small`, s.txSmall)}>{where(i.jobNumber, i.demoTime)}</Text>
          {why ? <Text style={s.why}>{why}</Text> : null}
        </View>
        <WaitChip id={`${id}.state`} text={sending ? t('tech.waiting.sending') : t('tech.job.waitingToSend')} />
      </Row>,
    );
  });
  // F-985: the damaged items, after the readable ones: never sent, never removed, so a person can still recover them from the phone.
  state.damaged.forEach((key, k) => {
    rows.push(
      <Row key={`d-${key}`} id={`wait.damaged.${k}`} first={rows.length === 0}>
        <View style={s.tx} accessible accessibilityLabel={t('tech.waiting.damaged')} accessibilityValue={{ text: 'damaged' }} testID={`wait.damaged.item.${k}`}>
          <Text style={s.txB}>{t('tech.waiting.damaged')}</Text>
          <Text style={s.txSmall}>{t('tech.waiting.damagedWhy')}</Text>
        </View>
        <WaitChip id={`wait.damaged.state.${k}`} text={t('tech.waiting.damagedState')} />
      </Row>,
    );
  });
  for (const a of kept) {
    rows.push(
      <Row key={`a-${a.key}`} id={`wait.kept.${a.key}`} first={rows.length === 0}>
        <Tx id={`wait.kept.${a.key}`} b={title(a.kind)} small={t('tech.waiting.job', { job: a.jobNumber })} />
        <WaitChip id={`wait.kept.state.${a.key}`} text={a.result === 'world_reset' ? t('tech.waiting.notAdded') : t(a.result === 'flagged' ? 'tech.waiting.listed' : 'tech.waiting.sent')} />
      </Row>,
    );
  }
  const readable = outbox.waiting.length;
  // The count the list holds (the frame shows no count line; the header's count, CTL-CMP-10-02, says it): the list's accessibility value.
  const top = sending ? t('tech.waiting.sendingN', { n: readable })
    : recentSent.length > 0 && n > 0 ? t('tech.waiting.partial', { sent: recentSent.length, left: n })
      : n > 0 ? t('tech.waiting.count', { n }) : t('tech.waiting.nothing');
  // The native app learns "no signal" only from a call that failed (no reachability service), so Send now always tries. With no signal
  // known it is drawn dim and says No signal, as the frame draws it, but it stays pressable: a tap that finds the signal back sends.
  // This departs from UI-SPECIFICATION SCR-TEC-09 "Waiting, offline: Send now disabled with No signal" (F-1096 c; the spec's native note
  // is a phase 6 documentation item).
  const canSend = readable > 0 && !sending;
  return (
    <View style={s.screen}>
      <JobBar id="wait" back={t('tech.tab.me')} onBack={() => nav.goBack()} title={t('tech.waiting.title')} />
      <Scroll id="wait.scroll">
        {outbox.online ? null : <NoSignal id="wait.nosig" title={t('tech.sync.noSignal')} text={t('tech.sync.keepWorking')} />}
        {rows.length > 0 ? <View accessibilityLabel={top} testID="wait.listed"><Group id="wait.list">{rows}</Group></View> : (
          <Group id="wait.list"><Row id="wait.none" first><Tx id="wait.none" b={t('tech.waiting.nothing')} /></Row></Group>
        )}
        {readable > 0 ? (
          <>
            <SButton id="wait.send" icon="send" label={sending ? t('tech.waiting.sendingBtn') : t('tech.waiting.sendNow')} wide off={!canSend} dim={!outbox.online}
              onPress={() => { setClicked(true); void app.sync(); }} {...(outbox.online ? {} : { hint: t('tech.sync.noSignal') })} />
            {outbox.online ? null : <Hint id="wait.why" center marginTop={2} text={t('tech.sync.noSignal')} />}
          </>
        ) : null}
        <InfoBox id="wait.how" text={t('tech.waiting.howNative')} />
      </Scroll>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.screen },
  tx: { flex: 1, minWidth: 0 },
  txB: type(680, 15, 19.5, color.ink900),
  txSmall: type(400, 13, 16.9, color.ink600),
  why: type(600, 12.5, 17.5, color.badText),
});
