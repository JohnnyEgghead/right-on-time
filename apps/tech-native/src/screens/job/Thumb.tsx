// SPDX-License-Identifier: AGPL-3.0-or-later
// A job photo's thumbnail, shared by SCR-TEC-04's photo row (CTL-TEC-04-10, tap opens the viewer) and SCR-TEC-07's Photos strip
// (CTL-TEC-07-16, display only): the server's small copy (API-175 size=thumb, UD-55, F-1235) or the phone's own unsent bytes, a camera
// placeholder until the image has loaded and when it fails (F-1234; strip.ts), and the clock mark on an own unsent photo (Waiting to
// send). Only the photo viewer (CTL-TEC-04-11) reads the whole file.
import { useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { Icon } from '../../ui/Icon.tsx';
import { lk } from '../../ui/look.ts';
import { color } from '../../ui/tokens.ts';
import type { NativeApp } from '../../core.ts';
import type { T } from '../../ui/intl.tsx';
import { noteWhen, type ShownPhoto } from './model.ts';
import { photoPath, thumbLayers, type PhotoSize, type ThumbImage } from './strip.ts';
import { jc } from './ui.tsx';

/** A photo's image: the server's file (API-175, with the session's bearer token) at `size`, or the phone's own unsent bytes. */
export function photoSource(app: NativeApp, p: ShownPhoto, size: PhotoSize): { uri: string; headers?: Record<string, string> } | null {
  if (p.waiting) {
    const uri = app.store.blobUri(p.key);
    return uri ? { uri } : null;
  }
  const auth = app.authHeader();
  return auth ? { uri: `${app.snapshot.server}${photoPath(p.key, size)}`, headers: auth } : null;
}

/** A thumbnail's spoken name: who took it and when, then Waiting to send for an own unsent one. */
export function photoLabel(t: T, p: ShownPhoto, jobDate: string, lang: string): string {
  return [t('tech.job.photoAlt', { by: p.by ?? '', at: noteWhen(p.at, jobDate, lang) }), p.waiting ? t('tech.job.waitingToSend') : null].filter(Boolean).join(', ');
}

/** With onPress it is a button (the job screen's viewer); without, an image in a display strip (the finish screen). */
export function Thumb(props: { app: NativeApp; p: ShownPhoto; id: string; style: object; label: string; onPress?: () => void }) {
  const src = photoSource(props.app, props.p, 'thumb');
  // The image's state belongs to its source: a waiting photo that is sent changes from the phone's file to the server's, which loads anew.
  const uri = src?.uri ?? null;
  const [loadState, setLoadState] = useState<{ uri: string | null; image: ThumbImage }>({ uri, image: 'loading' });
  const draw = thumbLayers(src !== null, loadState.uri === uri ? loadState.image : 'loading');
  const inner = (
    <>
      {draw.placeholder ? <View style={s.thumbNone}><Icon name="camera" size={18} color={color.ink500} /></View> : null}
      {draw.image && src ? (
        <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" onLoad={() => setLoadState({ uri, image: 'loaded' })} onError={() => setLoadState({ uri, image: 'failed' })} />
      ) : null}
      {props.p.waiting ?<View style={s.thumbWait}><Icon name="clock" size={12} color={jc.riskInk} strokeWidth={2.2} /></View> : null}
    </>
  );
  const value = { text: `${props.p.waiting ? 'waiting' : 'sent'} ${props.p.key}` };
  return props.onPress ? (
    <Pressable {...lk(props.id, props.style)} onPress={props.onPress} accessibilityRole="button" accessibilityLabel={props.label} accessibilityValue={value}>
      {inner}
    </Pressable>
  ) : (
    <View {...lk(props.id, props.style)} accessible accessibilityRole="image" accessibilityLabel={props.label} accessibilityValue={value}>
      {inner}
    </View>
  );
}

const s = StyleSheet.create({
  thumbNone: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  thumbWait: { position: 'absolute', right: 3, bottom: 3, width: 18, height: 18, borderRadius: 9, backgroundColor: jc.riskBg, alignItems: 'center', justifyContent: 'center' },
});
