// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-06 Add photo, native (DK-117 "SCR-TEC-06 Add photo, iPhone: Preview" and its No photo and Permission denied details; state
// content from DK-110; FR-TECH-3, FR-TECH-4). Take or choose a photo opens the iOS action sheet: Take photo (the system camera, asking
// for its permission first; refused: the message with Open Settings, CTL-TEC-06-06) or Choose from library (the system photo picker).
// The picked photo is made SD-32's JPEG (photo.ts) and previewed; Save photo enters it through the shared engine, which holds it in
// the file store until API-103 answers (invariant 1), and closes the sheet to the job, where it shows Waiting to send.
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { useState } from 'react';
import { ActionSheetIOS, Image, Linking, ScrollView, StyleSheet, View } from 'react-native';
import { StoreWriteError } from '@bw/outbox/src/items/native.ts';
import { useT } from '../../ui/intl.tsx';
import { useBigText } from '../../ui/text-size.tsx';
import { Hint } from '../../ui/kit.tsx';
import { lk, useLookDump } from '../../ui/look.ts';
import { color } from '../../ui/tokens.ts';
import { useApp } from '../../useApp.ts';
import { jobData } from './hooks.ts';
import type { JobRoutes } from './nav.ts';
import { compressPhoto } from './photo.ts';
import { expoEncoder, pickPhoto } from './photo-expo.ts';
import { ErrBox, NButton, SheetBar } from './ui.tsx';

type SheetState = 'none' | 'working' | 'preview' | 'saving' | 'denied' | 'full' | 'failed';

export function PhotoSheet() {
  const t = useT();
  const { app } = useApp();
  const nav = useNavigation();
  const jobNumber = useRoute<RouteProp<JobRoutes, 'JobPhoto'>>().params.jobNumber;
  const [state, setState] = useState<SheetState>('none');
  const [picked, setPicked] = useState<{ uri: string | null; bytes: Uint8Array } | null>(null);
  useLookDump(state === 'preview' ? 'photo-preview' : state === 'none' ? 'photo-none' : state === 'denied' ? 'photo-denied' : null);

  const pick = async (from: 'camera' | 'library') => {
    const r = await pickPhoto(from);
    if (r.kind === 'canceled') return; // canceled by the user: nothing changes
    if (r.kind === 'denied') return setState('denied');
    if (r.kind === 'failed') return setState(picked ? 'preview' : 'none');
    setState('working');
    const c = await compressPhoto(r, expoEncoder);
    setPicked({ uri: c.ok ? c.uri : null, bytes: c.bytes });
    setState('preview');
  };
  // CTL-TEC-06-01 and -04: the iOS action sheet of the 2 sources.
  const choose = () => {
    ActionSheetIOS.showActionSheetWithOptions({ options: [t('tech.photo.takePhoto'), t('tech.photo.choose'), t('common.cancel')], cancelButtonIndex: 2 },
      (i) => {
        if (i === 0) void pick('camera');
        if (i === 1) void pick('library');
      });
  };
  const save = async () => {
    if (!picked || state === 'saving') return;
    setState('saving');
    try {
      await app.enter({ jobNumber, baseVersion: null, body: { kind: 'photo', contentType: 'image/jpeg' }, blob: picked.bytes });
      jobData(); // the job screen re-reads on focus
      nav.goBack();
    } catch (e) {
      setState(e instanceof StoreWriteError && /space|full|quota/i.test(e.message) ? 'full' : 'failed');
    }
  };
  const cancel = () => nav.goBack();
  const preview = picked !== null && state !== 'none' && state !== 'denied';
  const big = useBigText(); // 14.2 item 2: the sheet scrolls and its 2 buttons stack, so none is cut off or out of reach
  const Body = big ? ScrollView : View;
  return (
    <Body {...lk('photo.body', big ? s.sheetBig : s.sheet)} {...(big ? { contentContainerStyle: s.sheetBigIn } : {})}>
      <SheetBar id="photo.bar" titleId="photo.title" title={t('tech.job.addPhoto')} left={{ id: 'photo.cancel', label: t('common.cancel'), onPress: cancel }} />
      {preview ? (
        <>
          <View {...lk('photo.preview', s.pv)} accessible accessibilityRole="image" accessibilityLabel={t('tech.photo.previewLabel')}>
            {picked?.uri ? <Image source={{ uri: picked.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
          </View>
          {state === 'full' ? <ErrBox id="photo.err" text={t('tech.photo.full')} /> : null}
          {state === 'failed' ? <ErrBox id="photo.err" text={t('tech.photo.failed')} /> : null}
          <View {...lk('photo.btns', [s.b2, big ? s.b2Big : null])}>
            <NButton id="photo.retake" icon="camera" label={t('tech.photo.retake')} onPress={choose} flex={!big} />
            <NButton id="photo.save" icon="check" iconStroke={2.6} label={t('tech.photo.save')} pri busy={state === 'saving'} onPress={() => void save()} flex={!big} />
          </View>
        </>
      ) : (
        <>
          {state === 'denied' ? (
            <ErrBox id="photo.denied" text={t('tech.photo.denied')} link={{ id: 'photo.settings', label: t('tech.photo.openSettings'), onPress: () => void Linking.openSettings() }} />
          ) : <Hint id="photo.lead" text={t('tech.photo.lead', { job: jobNumber, name: jobData().copies.job(jobNumber)?.customer.name ?? '' })} />}
          <NButton id="photo.take" icon="camera" label={t('tech.photo.take')} pri busy={state === 'working'} onPress={choose} />
        </>
      )}
    </Body>
  );
}

const s = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: color.white, paddingTop: 25, paddingHorizontal: 18, paddingBottom: 34, rowGap: 10 },
  pv: { height: 230, borderRadius: 12, overflow: 'hidden' },
  b2: { flexDirection: 'row', columnGap: 10, rowGap: 10 },
  b2Big: { flexDirection: 'column' },
  sheetBig: { flex: 1, backgroundColor: color.white },
  sheetBigIn: { paddingTop: 25, paddingHorizontal: 18, paddingBottom: 34, rowGap: 10 },
});
