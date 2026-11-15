// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-10 Me (DK-117 option B; state content from DK-114 mockups/pages/tech-me.html; FR-TECH-15, FR-LANG-1, FR-TECH-4, FR-TECH-7, FR-DISP-20): who is
// signed in, the van with no stock-checked line, today's hours (the day's start, hours on the clock by the demo clock and jobs done, the phone's own
// statuses counted at once, UD-51), Sync with Send now, the Notifications and Text size settings kept on the phone (UD-43), the language, Call dispatch,
// the server address, the app version and Sign out, which is refused while items wait (UD-20).
import { clockOfWire } from '@bw/i18n/src/text-rows.ts';
import { useNavigation, type NavigationProp, type ParamListBase } from '@react-navigation/native';
import Constants from 'expo-constants';
import { useState } from 'react';
import { ActionSheetIOS, Linking, Pressable, StyleSheet, View } from 'react-native';
import { waitingTotal } from '../../core.ts';
import { Icon } from '../../ui/Icon.tsx';
import type { NativeIcon } from '../../ui/icon-paths.ts';
import { useT } from '../../ui/intl.tsx';
import { Hint, Message, WideButton } from '../../ui/kit.tsx';
import { lk, useLookDump } from '../../ui/look.ts';
import { LanguageSegments } from '../../ui/Segmented.tsx';
import { useBigText } from '../../ui/text-size.tsx';
import { color, type } from '../../ui/tokens.ts';
import { Bar2, c, Grp, NoSignal, Row, RowText, Scroll, T } from './parts.tsx';
import {
  branchName, durationText, ENDING_KINDS, jobsDone, minutesOnClock, phoneStart, SIZE_KEY, startOfDay, TEXT_SIZES, type TextSize,
} from './model.ts';
import { forgetMapMe, useMapMe } from './use-mapme.ts';
import { openWaiting } from '../job/nav.ts';

/** A setting's row (.row.set): the icon, the key and what the row ends in. */
function SetRow(props: { id: string; icon: NativeIcon; label: string; first?: boolean; onPress?: (() => void) | undefined; value?: string; stack?: boolean; children?: React.ReactNode }) {
  const big = useBigText();
  if (big) {
    // 14.2 item 2: at the largest sizes the key, its value (wrapping, never cut) and a wide control (stack) share 1 column beside the icon.
    return (
      <Row id={props.id} set first={props.first ?? false} onPress={props.onPress} {...(props.onPress || props.value !== undefined ? { label: props.label } : {})} {...(props.value !== undefined ? { value: props.value } : {})}>
        <Icon id={`${props.id}.icon`} name={props.icon} size={19} color={color.teal700} />
        <View style={s.colBig}>
          <T lkId={`${props.id}.key`} style={s.keyBig}>{props.label}</T>
          {props.value !== undefined ? <T lkId={`${props.id}.value`} style={s.val}>{props.value}</T> : null}
          {props.stack ? props.children : null}
        </View>
        {props.stack ? null : props.children}
      </Row>
    );
  }
  return (
    <Row id={props.id} set first={props.first ?? false} onPress={props.onPress} {...(props.onPress || props.value !== undefined ? { label: props.label } : {})} {...(props.value !== undefined ? { value: props.value } : {})}>
      <Icon id={`${props.id}.icon`} name={props.icon} size={19} color={color.teal700} />
      <T lkId={`${props.id}.key`} style={s.key}>{props.label}</T>
      {props.value !== undefined ? <T lkId={`${props.id}.value`} style={s.val} numberOfLines={1}>{props.value}</T> : null}
      {props.children}
    </Row>
  );
}

/** The iOS switch of the frame (.switch.on): 51 x 31, --teal-600 when on. */
function Switch(props: { id: string; on: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <Pressable {...lk(props.id, [s.switch, props.on ? s.switchOn : s.switchOff])} onPress={() => props.onChange(!props.on)} accessibilityRole="switch"
      accessibilityState={{ checked: props.on }} accessibilityLabel={props.label} accessibilityValue={{ text: props.on ? '1' : '0' }}>
      <View style={[s.knob, props.on ? s.knobOn : null]} />
    </Pressable>
  );
}

export function MeTab() {
  const t = useT();
  const nav = useNavigation<NavigationProp<ParamListBase>>();
  const { app, state, reads, data } = useMapMe();
  const [refused, setRefused] = useState<{ n: number; damaged: boolean } | null>(null);
  const signOut = (discardDamaged: boolean) => {
    void app.signOut(discardDamaged).then((r) => {
      setRefused(r.ok ? null : { n: r.waiting, damaged: r.damaged });
      if (r.ok) forgetMapMe();
    });
  };
  const day = data.day?.data ?? null;
  const stops = data.route?.data.stops ?? [];
  const offline = !state.outbox.online || !data.online;
  const waiting = state.outbox.waiting;
  const n = waitingTotal(state); // F-985: a damaged item still waits on the phone

  // Today's hours: the server's start, or the phone's own first action until the server's arrives (OI-40).
  const started = startOfDay(day?.startedAt ?? null, phoneStart(waiting, day?.date ?? null));
  const onClock = started && data.now ? minutesOnClock(started, data.now) : null;
  const endedHere = new Set(waiting.filter((i) => ENDING_KINDS.has(i.kind)).map((i) => i.jobNumber));
  const done = jobsDone(stops.map((x) => ({ state: endedHere.has(x.jobNumber) ? ('done' as const) : x.state })));
  const skillKey = day?.technician.skill ? (`tech.me.skill.${day.technician.skill}` as const) : null;
  const roleLine = skillKey && t(skillKey as never) !== skillKey ? t('tech.me.role', { skill: t(skillKey as never) }) : t('tech.me.roleOnly');
  const branch = branchName(day?.technician.branch);
  const branchLine = day?.technician.employeeNumber ? t('tech.me.branch', { branch, number: day.technician.employeeNumber }) : t('tech.me.branchOnly', { branch });
  const server = (state.session?.origin ?? state.server).replace(/^https?:\/\//, '');
  const version = Constants.expoConfig?.version ?? '';
  // The frame is the all-synced Me (Send now off): a visit with items waiting and signal draws it on, and would overwrite the frame's dump.
  useLookDump(day && n === 0 ? 'me' : null);

  const pickSize = () => {
    const labels = TEXT_SIZES.map((x) => t(SIZE_KEY[x]));
    ActionSheetIOS.showActionSheetWithOptions({ title: t('tech.me.textSize'), options: [...labels, t('common.cancel')], cancelButtonIndex: labels.length }, (i) => {
      const picked: TextSize | undefined = TEXT_SIZES[i];
      if (picked) reads?.setSize(picked);
    });
  };

  return (
    <View style={s.screen}>
      <Bar2 id="me.bar" title={t('tech.tab.me')} />
      <Scroll id="me.scroll">
        {offline ? <NoSignal /> : null}
        <Grp id="me.profile.grp">
          <Row id="me.profile" first>
            <View {...lk('me.avatar', s.avatar)}><T lkId="me.avatar.text" style={s.avatarText}>{day?.technician.initials ?? ''}</T></View>
            <RowText id="me.profile.tx" title={day?.technician.name ?? state.session?.name ?? ''} small={day ? `${roleLine} - ${branchLine}` : ''} />
          </Row>
        </Grp>
        <Grp id="me.day.grp">
          <Row id="me.van" first>
            <RowText id="me.van.tx" title={day?.van ? t('tech.me.vanNumber', { number: day.van.number }) : t('tech.me.noVan')} small={day?.van?.vehicle} />
          </Row>
          <Row id="me.hours">
            <RowText id="me.hours.tx"
              title={started ? `${t('tech.me.started')} ${clockOfWire(started)}${onClock === null ? '' : ` - ${durationText(t, onClock)}`}` : t('tech.me.notStarted')}
              small={`${t('tech.me.jobsDone')} ${t('tech.me.ofTotal', { done, total: stops.length })}`} />
          </Row>
          <Row id="me.sync">
            <RowText id="me.sync.tx" title={n > 0 ? t('tech.sync.waiting', { n }) : t('tech.me.syncedAt', { time: data.now ? clockOfWire(data.now) : '' })}
              small={n > 0 ? t('tech.me.waiting', { n }) : t('tech.me.syncedNothing')} onPress={() => openWaiting(nav)} />
            <Pressable {...lk('me.sendnow', [s.sbtn, offline || waiting.length === 0 ? s.sbtnOff : s.sbtnOn])} disabled={offline || waiting.length === 0} onPress={() => void app.sync()}
              accessibilityRole="button" accessibilityState={{ disabled: offline || waiting.length === 0 }}>
              <T lkId="me.sendnow.text" style={[s.sbtnText, { color: offline || waiting.length === 0 ? color.ink500 : color.ink800 }]}>{t('tech.me.sendNow')}</T>
            </Pressable>
          </Row>
        </Grp>
        {offline && n > 0 ? <T lkId="me.sendnow.why" style={s.why}>{t('tech.me.sendNowWhy')}</T> : null}
        <Grp id="me.settings" setg>
          <SetRow id="me.notices" icon="bell" label={t('tech.me.notifications')} first>
            <Switch id="me.notices.switch" on={data.noticesOn} label={t('tech.me.notifications')} onChange={(on) => reads?.setNotices(on)} />
          </SetRow>
          <SetRow id="me.size" icon="list" label={t('tech.me.textSize')} value={t(SIZE_KEY[data.textSize])} onPress={pickSize}>
            <Icon id="me.size.chev" name="chevRight" size={16} color={color.ink400} />
          </SetRow>
          <SetRow id="me.language" icon="globe" label={t('tech.me.language')} stack>
            <LanguageSegments id="me.lang" value={state.language} onChange={(l) => void app.setLanguage(l)} width={170} />
          </SetRow>
          <SetRow id="me.call" icon="phone" label={t('tech.me.call')} value={day?.officePhone ?? ''} onPress={day ? () => { void Linking.openURL(`tel:${day.officePhone.replace(/[^0-9+]/g, '')}`); } : undefined} />
          <SetRow id="me.server" icon="cloud" label={t('tech.server.row')} value={server} />
          <SetRow id="me.version" icon="info" label={t('tech.me.version')} value={t('tech.me.versionValue', { version })} />
        </Grp>
        {refused !== null && !refused.damaged ? <Message id="me.refused" tone="bad" icon="alert" text={t('tech.me.signOutWaiting', { n: refused.n })} /> : null}
        {refused?.damaged ? (
          // F-1093 (owner ruling "Allow sign-out, warn"): the warning names the item the phone cannot read; the person chooses to lose it
          <Message id="me.refused" tone="bad" icon="alert" text={t('tech.me.signOutDamaged', { n: refused.n })} link={{ label: t('tech.me.signOutAnyway'), onPress: () => signOut(true), own: true }} />
        ) : null}
        <Hint id="me.hint" center text={t('tech.me.signOutHint')} marginTop={2} />
        <WideButton id="me.signout" label={t('shell.signOut')} icon="lock" onPress={() => signOut(false)} />
      </Scroll>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.screen },
  avatar: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: color.ink300, backgroundColor: color.white, alignItems: 'center', justifyContent: 'center' },
  avatarText: type(750, 13, 18.2, c.ink700),
  key: { ...type(600, 15, 21, color.ink900), flex: 1 },
  val: type(400, 15, 21, color.ink600),
  colBig: { flex: 1, minWidth: 0 },
  keyBig: type(600, 15, 21, color.ink900),
  sbtn: { minHeight: 44, borderWidth: 1, borderRadius: 11, paddingVertical: 3, paddingHorizontal: 6, columnGap: 6, rowGap: 6, alignItems: 'center', justifyContent: 'center' },
  sbtnOff: { backgroundColor: c.ink100, borderColor: color.ink200 },
  sbtnOn: { backgroundColor: color.white, borderColor: color.ink300 },
  sbtnText: type(650, 13.5, 16.2, color.ink800),
  why: { ...type(400, 12.5, 17.5, color.ink600), textAlign: 'right' },
  switch: { width: 51, height: 31, borderRadius: 16 },
  switchOn: { backgroundColor: color.teal600 },
  switchOff: { backgroundColor: color.ink300 },
  knob: { position: 'absolute', top: 2, left: 2, width: 27, height: 27, borderRadius: 14, backgroundColor: color.white },
  knobOn: { left: 22 },
});
