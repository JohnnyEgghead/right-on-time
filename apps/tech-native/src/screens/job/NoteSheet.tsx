// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-05 Add note, native (DK-117 "SCR-TEC-05 Add note, iPhone: Typing"; state content from DK-111; FR-TECH-3, FR-TECH-4,
// invariant 1): a sheet over the job. Every change is written to the phone as a draft at once (copies.ts), so nothing typed is lost if
// the app closes; Save turns the draft into a note item through the shared engine, whose enter() resolves only once the file store
// has committed the item (I1), and only then is the draft dropped and the sheet closed: the note shows on the job at once with
// Waiting to send. Discard asks first (an iOS alert), then deletes the draft.
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { useRef, useState, type ComponentRef } from 'react';
import { Alert, StyleSheet, TextInput, View } from 'react-native';
import { T as Text } from '../../ui/text-size.tsx';
import { NOTE_MAX_CHARS } from '@bw/api';
import { Icon } from '../../ui/Icon.tsx';
import { useT } from '../../ui/intl.tsx';
import { lk, useLookDump } from '../../ui/look.ts';
import { color, type } from '../../ui/tokens.ts';
import { useApp } from '../../useApp.ts';
import { jobData } from './hooks.ts';
import type { JobRoutes } from './nav.ts';
import { ErrBox, SheetBar } from './ui.tsx';

export function NoteSheet() {
  const t = useT();
  const { app } = useApp();
  const nav = useNavigation();
  const jobNumber = useRoute<RouteProp<JobRoutes, 'JobNote'>>().params.jobNumber;
  const copies = jobData().copies;
  const [text, setText] = useState(() => copies.draft(jobNumber) ?? '');
  const [failed, setFailed] = useState(false);
  const [why, setWhy] = useState(false);
  const [saving, setSaving] = useState(false);
  const box = useRef<ComponentRef<typeof TextInput>>(null);
  const has = text.trim() !== '';
  useLookDump(has && !failed && !why ? 'note-typing' : null);

  // CTL-TEC-05-01: each change is kept at once; a failed write says so and keeps the text on the screen.
  const change = (v: string) => {
    const next = v.slice(0, NOTE_MAX_CHARS);
    setText(next);
    setWhy(false);
    try {
      copies.saveDraft(jobNumber, next);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };
  const save = async () => {
    if (!has) {
      setWhy(true);
      box.current?.focus();
      return;
    }
    if (saving) return;
    setSaving(true);
    try {
      const job = copies.job(jobNumber);
      // I1: enter() resolves only after the store committed the note; only then is the draft dropped and the sheet closed.
      await app.enter({ jobNumber, baseVersion: job?.job.version ?? null, body: { kind: 'note', payload: { text: text.trim() } } });
      copies.saveDraft(jobNumber, '');
      nav.goBack();
    } catch {
      setSaving(false);
      setFailed(true);
    }
  };
  // CTL-TEC-05-03: "Discard this note? It is not saved anywhere else." then the draft goes.
  const discard = () => {
    if (!has) {
      nav.goBack();
      return;
    }
    Alert.alert(t('tech.note.discardAsk'), t('tech.note.discardWhy'), [
      { text: t('tech.note.keepWriting'), style: 'cancel' },
      {
        text: t('tech.note.discard'), style: 'destructive', onPress: () => {
          setText('');
          try {
            copies.saveDraft(jobNumber, '');
          } catch {
            setFailed(true);
          }
          nav.goBack();
        },
      },
    ]);
  };
  return (
    <View {...lk('note.body', s.sheet)}>
      <SheetBar id="note.bar" titleId="note.title" title={t('tech.job.addNote')}
        left={{ id: 'note.discard', label: t('tech.note.discard'), onPress: discard }}
        right={{ id: 'note.save', label: t('common.save'), onPress: () => void save(), off: !has || saving }} />
      <View {...lk('note.ta', s.ta)}>
        <TextInput ref={box} {...lk('note.value', s.value)} value={text} onChangeText={change} multiline autoFocus maxLength={NOTE_MAX_CHARS}
          placeholder={t('tech.note.placeholder')} placeholderTextColor={color.ink500} accessibilityLabel={t('tech.note.title')} />
      </View>
      {has ? (
        <View {...lk('note.kept', s.kept)}>
          <Icon id="note.kept.icon" name="check" size={18} color={color.ink600} strokeWidth={2.6} />
          <Text {...lk('note.kept.text', s.keptText)}>{t('tech.note.kept')}</Text>
        </View>
      ) : <Text {...lk('note.why', [s.keptText, why ? s.whyOn : null])} accessibilityRole={why ? 'alert' : undefined}>{t('tech.note.typeFirst')}</Text>}
      {failed ? <ErrBox id="note.failed" text={t('tech.note.storeFailed')} /> : null}
    </View>
  );
}

const s = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: color.white, paddingTop: 25, paddingHorizontal: 18, paddingBottom: 34, rowGap: 10 },
  ta: { minHeight: 140, paddingVertical: 12, paddingHorizontal: 14, backgroundColor: color.white, borderRadius: 12, borderWidth: 1, borderColor: color.ink400, overflow: 'hidden' },
  value: { ...type(400, 16, 23.2, color.ink900), flex: 1, padding: 0, textAlignVertical: 'top' },
  kept: { height: 22.5, marginTop: 6, flexDirection: 'row', alignItems: 'center' },
  keptText: { ...type(400, 12.5, 17.5, color.ink600), marginLeft: 4 },
  whyOn: { color: color.badText },
});
