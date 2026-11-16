// SPDX-License-Identifier: AGPL-3.0-or-later
// The confirm sheets (SD-47 Native app "native sheets for confirm steps"; DK-117 option B sheet frames, their content from DK-109 per ruling
// D5b-1): SCR-TEC-03 On my way, SCR-TEC-13 Arrived and SCR-TEC-14 No one home. The app's 1 implementation of the 3 sheets: Today's card
// (CTL-TEC-02-04, -05, -09) and the job screen (CTL-TEC-04-13, -14, -17, "as CTL-TEC-02-04, -05 and -09 for this job") both open it, as the
// root stack's JobStatus form sheet (job/routes.tsx; a grabber, dismissed by a swipe). Its primary button enters the status item through the
// app's item engine (invariant 1: saved on the phone at once, sent when online) and closes the sheet once the item is saved; Cancel or a
// swipe enters nothing. Nothing is sent before the confirm. Today passes what it knows of the job for the On my way lines (the language, the
// arrival and the text preview, API-100); the job screen passes none, and the sheet then says only what the job screen knows.
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import { NotReadyError } from '@bw/outbox/src/items/native.ts';
import { fromWire, formatTime } from '@bw/time';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { useIntl } from 'react-intl';
import { AccessibilityInfo, findNodeHandle, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { T as Text, useBigText } from '../../ui/text-size.tsx';
import { Icon } from '../../ui/Icon.tsx';
import type { NativeIcon } from '../../ui/icon-paths.ts';
import { SHORT_DETENTS, TALL_DETENTS } from '../../ui/sheet-detents.ts';
import { useT } from '../../ui/intl.tsx';
import { lk, useLookDump } from '../../ui/look.ts';
import { color, type } from '../../ui/tokens.ts';
import { useApp } from '../../useApp.ts';
import type { JobRoutes, StatusKind } from '../job/nav.ts';
import { ErrBox } from '../job/ui.tsx';
import { arrivalSmall, firstName, PREVIEW_LINK, windowLabel, type Drive } from './model.ts';
import { tone } from './palette.ts';

/** What Today knows of the job for the On my way sheet (CTL-TEC-03-01, -04, -05). */
export interface OmwDetail {
  language: 'en' | 'es';
  window: { start: string; end: string };
  preview: { text: string; arrival: string } | null;
  zone: string;
  /** API-104's drive from the van to the job (F-1106, CTL-TEC-03-05); null when not read. */
  drive: Drive | null;
}

export interface StatusSheetParams {
  jobNumber: number;
  version: number;
  kind: StatusKind;
  /** The customer's full name. */
  name: string;
  omw?: OmwDetail;
  /** The phone had signal when the sheet opened (the Online and Offline states); the app's own signal when not given. */
  online?: boolean;
}

interface Spec {
  title: MessageKey;
  go: MessageKey;
  icon: NativeIcon | null;
  /** Send is the warm button (DK-117 .nbtn.warm); Arrived and No one home are teal. */
  warm: boolean;
  dump: string;
}

const SPEC: Record<StatusKind, Spec> = {
  on_my_way: { title: 'tech.omw.title', go: 'tech.omw.send', icon: 'send', warm: true, dump: 'sheet-omw' },
  arrived: { title: 'tech.arrived.title', go: 'tech.today.arrived', icon: 'pin', warm: false, dump: 'sheet-arrived' },
  no_one_home: { title: 'tech.noh.title', go: 'tech.today.noOneHome', icon: null, warm: false, dump: 'sheet-noh' },
};

export function StatusSheet() {
  const t = useT();
  const { locale } = useIntl();
  const { app, state } = useApp();
  const nav = useNavigation();
  const p = useRoute<RouteProp<JobRoutes, 'JobStatus'>>().params;
  const [failed, setFailed] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  // CTL-TEC-03-03, -13-03 and -14-03: Cancel has the initial focus (DK-117 marks it autofocus), so VoiceOver starts on it, not on the title (F-1114).
  const cancel = useRef<ComponentRef<typeof View>>(null);
  useEffect(() => {
    const h = setTimeout(() => {
      const node = findNodeHandle(cancel.current);
      if (typeof node === 'number') AccessibilityInfo.setAccessibilityFocus(node);
    }, 500);
    return () => clearTimeout(h);
  }, []);
  // 14.2 item 2: at the largest text the content is taller than a fit-to-content sheet, so the sheet takes the tall detent, scrolls
  // and stacks its 2 buttons; go stays on the screen and reachable.
  const big = useBigText();
  useEffect(() => {
    // Back to the JobStatus route's own height (screens/job/routes.tsx, as tall as the content) when the text gets smaller while the sheet
    // is up. Not the Confirm route's 0.32 (App.tsx): that is another sheet, and the On my way sheet is taller (F-1733).
    nav.setOptions({ sheetAllowedDetents: big ? TALL_DETENTS : SHORT_DETENTS });
  }, [big, nav]);
  const online = p.online ?? state.outbox.online;
  const spec = SPEC[p.kind];
  // The frames' sheets are the online ones: an offline sheet is its own look state (DK-109's Offline tiles, not drawn by DK-117).
  useLookDump(online ? spec.dump : `${spec.dump}-offline`);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await app.enter({ jobNumber: p.jobNumber, baseVersion: p.version, body: { kind: p.kind } });
      nav.goBack();
    } catch (e) {
      setBusy(false);
      setFailed(e instanceof NotReadyError ? 'tech.sheet.notReady' : 'tech.sheet.storeFailed');
    }
  };
  const first = firstName(p.name);
  const d = p.omw;
  const lang = d ? t(d.language === 'es' ? 'language.name.es' : 'language.name.en') : null;
  const preview = d?.preview ?? null;
  const arrival = preview ? fromWire(preview.arrival).toInstant() : null;
  const inside = preview && d ? preview.arrival >= d.window.start && preview.arrival <= d.window.end : null;
  const bubble = preview?.text.split(PREVIEW_LINK) ?? [];
  const title = p.kind === 'on_my_way' ? t(spec.title, { name: first }) : t(spec.title, { name: p.name });
  const msg = p.kind === 'on_my_way'
    ? (lang ? t('tech.omw.msg', { name: first, language: lang }) : t('tech.omw.fine'))
    : p.kind === 'arrived' ? t('tech.arrived.msg', { name: first }) : t('tech.noh.msg', { name: first });
  const offlineLine = p.kind === 'on_my_way' ? t('tech.omw.offline') : p.kind === 'no_one_home' ? t('tech.noh.offline') : null;
  const showPreview = p.kind === 'on_my_way' && online && d !== undefined && arrival !== null;
  const Body = big ? ScrollView : View;
  return (
    <Body {...lk('sheet', big ? s.sheetBig : s.sheet)} {...(big ? { contentContainerStyle: s.sheetBigIn } : {})}>
      <Text {...lk('sheet.title', s.title)} accessibilityRole="header">{title}</Text>
      <Text {...lk('sheet.msg', s.msg)}>{msg}</Text>
      {showPreview && d ? (
        <>
          <View {...lk('sheet.eta', s.eta)}>
            <Icon id="sheet.eta.icon" name="truck" size={18} color={color.ink900} strokeWidth={2.1} />
            <View style={s.etaTx}>
              <Text {...lk('sheet.eta.text', s.etaText)}>{t('tech.omw.arriving', { time: formatTime(arrival, d.zone, locale.startsWith('es') ? 'es' : 'en') })}</Text>
              <Text {...lk('sheet.eta.small', s.etaSmall)}>{arrivalSmall(d.drive, inside === true, windowLabel(d.window.start, d.window.end), t)}</Text>
            </View>
          </View>
          <View {...lk('sheet.preview', s.preview)}>
            <Text {...lk('sheet.preview.label', s.previewLabel)}>{`${t('tech.omw.gets', { name: first })} - ${t('tech.omw.language', { language: lang ?? '' })}`}</Text>
            <Text {...lk('sheet.preview.bubble', s.bubble)}>{`${bubble[0] ?? ''}${PREVIEW_LINK}${bubble[1] ?? ''}`}</Text>
          </View>
        </>
      ) : null}
      {!online && offlineLine ? <Text {...lk('sheet.offline', s.msg)}>{offlineLine}</Text> : null}
      {failed ? <ErrBox id="sheet.err" text={t(failed)} /> : null}
      <View {...lk('sheet.btns', [s.btns, big ? s.btnsBig : null])}>
        <Pressable ref={cancel} {...lk('sheet.cancel', [s.cancel, big ? s.btnBig : null])} onPress={() => nav.goBack()} accessibilityRole="button" accessibilityLabel={t('common.cancel')}>
          <Text {...lk('sheet.cancel.text', s.cancelText)}>{t('common.cancel')}</Text>
        </Pressable>
        <Pressable {...lk('sheet.go', [s.go, spec.warm ? s.goWarm : s.goPri, big ? s.btnBig : null])} onPress={() => void go()} disabled={busy} accessibilityRole="button"
          accessibilityState={{ busy }} accessibilityLabel={t(spec.go)}>
          {spec.icon ? <Icon id="sheet.go.icon" name={spec.icon} size={19} color={color.white} /> : null}
          <Text {...lk('sheet.go.text', s.goText)}>{t(spec.go)}</Text>
        </Pressable>
      </View>
    </Body>
  );
}

const s = StyleSheet.create({
  sheet: { backgroundColor: color.white, paddingHorizontal: 18, paddingTop: 22, paddingBottom: 34, rowGap: 10 },
  title: { ...type(750, 21, 26.25, color.ink900), letterSpacing: -0.42 },
  msg: type(400, 15, 21.75, color.ink800),
  eta: { flexDirection: 'row', alignItems: 'center', columnGap: 8, rowGap: 8 },
  etaTx: { flex: 1 },
  etaText: type(400, 15, 21, color.ink900),
  etaSmall: type(400, 13, 18.2, color.ink600),
  preview: { rowGap: 6 },
  previewLabel: type(650, 13.5, 18.9, color.ink800),
  bubble: { ...type(400, 14, 19.6, color.ink900), backgroundColor: tone.ink100, borderRadius: 12, padding: 12, overflow: 'hidden' },
  btns: { flexDirection: 'row', columnGap: 10, rowGap: 10 },
  btnsBig: { flexDirection: 'column' },
  btnBig: { flex: 0, flexGrow: 0, flexBasis: 'auto' },
  sheetBig: { flex: 1, backgroundColor: color.white },
  sheetBigIn: { paddingHorizontal: 18, paddingTop: 22, paddingBottom: 34, rowGap: 10 },
  cancel: { flex: 1, minHeight: 50, borderRadius: 13, backgroundColor: tone.ink150, alignItems: 'center', justifyContent: 'center', columnGap: 8, rowGap: 8, paddingVertical: 4, paddingHorizontal: 12 },
  cancelText: { ...type(650, 17, 23.8, color.ink900), textAlign: 'center' },
  go: { flex: 1, minHeight: 50, borderRadius: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', columnGap: 8, rowGap: 8, paddingVertical: 4, paddingHorizontal: 12 },
  goWarm: { backgroundColor: tone.orange700 },
  goPri: { backgroundColor: color.teal700 },
  goText: { ...type(650, 17, 23.8, color.white), textAlign: 'center' },
});
