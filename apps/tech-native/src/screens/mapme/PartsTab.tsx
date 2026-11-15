// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-16 Parts (DK-117 option B; state content from DK-116 mockups/pages/r1-techweb-parts.html; FR-TECH-10, FR-BILL-3): a read-only search of the
// parts list kept on the phone (API-107, read with signal and kept by reads.ts), by name or code, working with no signal. Nothing here edits a part
// or counts stock.
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Icon } from '../../ui/Icon.tsx';
import { useT } from '../../ui/intl.tsx';
import { lk, useLookDump } from '../../ui/look.ts';
import { color, type } from '../../ui/tokens.ts';
import { Bar2, c, Grp, NoSignal, Row, Scroll, T } from './parts.tsx';
import { partsPhase, priceText, searchParts } from './model.ts';
import { useMapMe } from './use-mapme.ts';

export function PartsTab() {
  const t = useT();
  const { state, data } = useMapMe();
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState(false);
  const parts = data.parts?.data ?? null;
  const phase = partsPhase(parts, query);
  const found = parts ? searchParts(parts, query) : { shown: [], matched: 0 };
  // The look dump of the Results frame: a search typed and its matches listed.
  useLookDump(phase === 'results' && found.shown.length >= 2 ? 'parts' : null);

  return (
    <View style={s.screen}>
      <Bar2 id="parts.bar" title={t('tech.tab.parts')} sub={t('tech.parts.sub')} />
      <Scroll id="parts.scroll">
        {!state.outbox.online || !data.online ? <NoSignal /> : null}
        {phase === 'nocopy' ? (
          <View {...lk('parts.nocopy', s.note)}>
            <Icon name="cloud" size={18} color={color.ink500} />
            <T style={s.noteText}>{t('tech.parts.noCopy')}</T>
          </View>
        ) : (
          <>
            <View {...lk('parts.fld', s.fld)}>
              <View {...lk('parts.inp', [s.inp, focus || query !== '' ? s.inpFocus : s.inpRest])}>
                <Icon id="parts.inp.icon" name="search" size={18} color={color.ink500} />
                <TextInput
                  {...lk('parts.input', s.value)}
                  value={query}
                  onChangeText={setQuery}
                  onFocus={() => setFocus(true)}
                  onBlur={() => setFocus(false)}
                  placeholder={t('tech.parts.placeholder')}
                  placeholderTextColor={color.ink500}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  returnKeyType="search"
                  accessibilityLabel={t('tech.parts.find')}
                />
                {query !== '' ? (
                  <Pressable {...lk('parts.clear', s.show)} onPress={() => setQuery('')} accessibilityRole="button" accessibilityLabel={t('tech.parts.clear')}>
                    <T lkId="parts.clear.text" style={s.showText}>{t('tech.parts.clear')}</T>
                  </Pressable>
                ) : null}
              </View>
            </View>
            {phase === 'empty' ? (
              <View {...lk('parts.empty', s.note)}><Icon name="box" size={18} color={color.ink500} /><T style={s.noteText}>{t('tech.parts.empty', { total: parts?.length ?? 0 })}</T></View>
            ) : null}
            {phase === 'nomatch' ? (
              <View {...lk('parts.nomatch', s.note)}><Icon name="search" size={18} color={color.ink500} /><T style={s.noteText}>{t('tech.parts.noMatch', { q: query.trim() })}</T></View>
            ) : null}
            {phase === 'results' ? (
              <>
                <T lkId="parts.count" style={s.hint}>{t('tech.parts.count', { shown: found.matched, total: parts?.length ?? 0 })}</T>
                <Grp id="parts.results">
                  {found.shown.map((p, i) => (
                    <Row key={p.partId} id={`parts.row.${i}`} first={i === 0}>
                      <View {...lk(`parts.row.${i}.tx`, s.tx)}>
                        <T lkId={`parts.row.${i}.name`} style={s.name}>{p.name}</T>
                        <T lkId={`parts.row.${i}.code`} style={s.code}>{p.code}</T>
                      </View>
                      <View {...lk(`parts.row.${i}.trail`, s.trail)}>
                        <T lkId={`parts.row.${i}.price`} style={s.price}>{priceText(p.priceCents)}</T>
                      </View>
                    </Row>
                  ))}
                </Grp>
                <View {...lk('parts.kept', s.ro)}><Icon name="cloud" size={16} color={color.ink500} /><T style={s.roText}>{t('tech.parts.kept')}</T></View>
              </>
            ) : null}
          </>
        )}
      </Scroll>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.screen },
  fld: {},
  inp: {
    height: 48, backgroundColor: color.white, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, columnGap: 10, rowGap: 10,
    flexDirection: 'row', alignItems: 'center', overflow: 'hidden',
  },
  inpRest: { borderColor: color.ink400 },
  inpFocus: { borderColor: color.teal600 },
  value: { ...type(400, 17, 23.8, color.ink900), flex: 1, padding: 0 },
  show: { height: 30, paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: color.ink300, justifyContent: 'center' },
  showText: type(700, 14, 19.6, color.teal700),
  hint: { ...type(400, 12.5, 17.5, color.ink600), marginTop: 6 },
  tx: { flex: 1, flexShrink: 1 },
  name: type(680, 15, 19.5, color.ink900),
  code: type(400, 13, 16.9, color.ink600),
  trail: { alignItems: 'flex-end', rowGap: 2, columnGap: 2 },
  price: type(700, 13.5, 18.9, color.ink800),
  note: { flexDirection: 'row', alignItems: 'center', columnGap: 8, rowGap: 8, paddingVertical: 12 },
  noteText: { ...type(400, 14, 19.6, color.ink600), flexShrink: 1 },
  ro: { flexDirection: 'row', alignItems: 'center', columnGap: 8, rowGap: 8, marginTop: 4 },
  roText: { ...type(400, 12.5, 17.5, c.ink700), flexShrink: 1 },
});
