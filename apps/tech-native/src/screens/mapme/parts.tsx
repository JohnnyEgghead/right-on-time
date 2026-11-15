// SPDX-License-Identifier: AGPL-3.0-or-later
// The pieces the Map, Directions, Parts and Me screens draw (DK-117 option B, r1-ios-b.html: the teal bar2, the scroll area, the grouped
// rows, the Next stop card, the status chips). Every value is the frame's computed value (the DK kit's, light theme); each tagged view's
// id is its testID. Text goes through T, which draws the technician's Text size choice (CTL-TEC-10-09) on these screens.
import { type ComponentRef, type ReactNode, type Ref, type RefObject } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { T } from '../../ui/text-size.tsx';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '../../ui/Icon.tsx';
import { useT } from '../../ui/intl.tsx';
import { lk } from '../../ui/look.ts';
import { color, type } from '../../ui/tokens.ts';

/** Colors of the frame that tokens.ts does not name: --ink-100, --ink-150, --ink-700, --teal-200 and the Next stop colors. */
export const c = {
  ink100: '#f3f4f6',
  ink150: '#eceef1',
  ink700: '#374151',
  teal200: '#b9e0e9',
  orange800: '#b4480c',
  wayBg: '#dbe8fe',
  wayFg: '#1745a8',
  wayLine: '#2f6fe0',
} as const;

// ---- the Text size choice: ui/text-size.tsx, the whole app's (F-1072 item 6) ---------------------------------------------------

export { T, TextSizeProvider } from '../../ui/text-size.tsx';

// ---- the bar ---------------------------------------------------------------------------------------------------------------------

/** The teal bar2 of the frames: a 44 px row (the Back link on a pushed screen), the title (26 px) and the line under it. */
export function Bar2(props: { id: string; title: string; sub?: string | undefined; back?: { label: string; onPress: () => void } }) {
  const top = useSafeAreaInsets().top;
  return (
    <View {...lk(props.id, s.bar)}>
      <View style={{ height: top }} />
      <View {...lk(`${props.id}.nav`, s.navrow)}>
        {props.back ? (
          <Pressable {...lk(`${props.id}.back`, s.backb)} onPress={props.back.onPress} accessibilityRole="button" accessibilityLabel={props.back.label}>
            <Icon id={`${props.id}.back.icon`} name="chevLeft" size={24} color={color.teal100} />
            <T lkId={`${props.id}.back.text`} style={s.backText}>{props.back.label}</T>
          </Pressable>
        ) : null}
      </View>
      <T lkId={`${props.id}.title`} style={s.h1} accessibilityRole="header">{props.title}</T>
      {props.sub !== undefined ? <T lkId={`${props.id}.sub`} style={s.sub}>{props.sub}</T> : null}
    </View>
  );
}

/** The scrolling area under a bar (.scroll): 12 px at the sides, 8 px at the top, 7 px between its children. */
export function Scroll(props: { id: string; children: ReactNode; scrollRef?: RefObject<ComponentRef<typeof ScrollView> | null>; head?: ReactNode }) {
  // head: the part a screen keeps pinned above the scroll area at the default size; at the largest text sizes it scrolls with the body (14.2 item 2).
  return (
    <ScrollView ref={props.scrollRef} style={s.scroll} contentContainerStyle={s.scrollIn} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      {props.head}
      <View {...lk(props.id, s.scrollBody)}>{props.children}</View>
    </ScrollView>
  );
}

/** CTL-CMP-10-01 as the DK-107 frames draw it (.r1p-nosig, the same card on Map, Parts and Me): shown while the phone has no signal. */
export function NoSignal() {
  const t = useT();
  return (
    <View {...lk('nosig', s.nosig)} accessible accessibilityRole="alert" accessibilityLabel={`${t('tech.sync.noSignal')}. ${t('tech.sync.keepWorking')}`}>
      <Icon id="nosig.icon" name="signal" size={22} color="#7a4a00" />
      <View style={s.nosigTx}>
        <T lkId="nosig.title" style={s.nosigB}>{t('tech.sync.noSignal')}</T>
        <T lkId="nosig.text" style={s.nosigText}>{t('tech.sync.keepWorking')}</T>
      </View>
    </View>
  );
}

// ---- grouped rows ----------------------------------------------------------------------------------------------------------------

/** .grp: a white card with a hairline border; its rows are separated by a hairline at each row's top. */
export function Grp(props: { id: string; children: ReactNode; setg?: boolean; accessibilityLabel?: string }) {
  return <View {...lk(props.id, [s.grp, props.setg ? s.setg : null])} {...(props.accessibilityLabel ? { accessibilityLabel: props.accessibilityLabel } : {})}>{props.children}</View>;
}

/** .row: icon or number, text block, trailing part. `first` drops the top hairline; `onPress` makes it a link. */
export function Row(props: { id: string; first?: boolean; children: ReactNode; onPress?: (() => void) | undefined; minHeight?: number; label?: string; value?: string; set?: boolean; rowRef?: Ref<ComponentRef<typeof Pressable>> }) {
  const style = [s.row, props.set ? s.rowSet : null, props.first ? null : s.rowLine];
  const a11y = { ...(props.label ? { accessibilityLabel: props.label } : {}), ...(props.value !== undefined ? { accessibilityValue: { text: props.value } } : {}) };
  return props.onPress ? (
    <Pressable ref={props.rowRef} {...lk(props.id, style)} onPress={props.onPress} accessibilityRole="link" {...a11y}>{props.children}</Pressable>
  ) : (
    <View {...lk(props.id, style)} accessible={props.label !== undefined || props.value !== undefined} {...a11y}>{props.children}</View>
  );
}

/** .tx: the row's bold line and the small line under it. */
export function RowText(props: { id: string; title: string; small?: string | undefined; link?: boolean; translateNo?: boolean; onPress?: () => void }) {
  return (
    <View {...lk(props.id, s.tx)}>
      <T lkId={`${props.id}.b`} style={props.onPress ? [s.b, s.bTap] : s.b} numberOfLines={props.link ? 1 : undefined} {...(props.onPress ? { onPress: props.onPress, accessibilityRole: 'link' as const } : {})}>{props.title}</T>
      {props.small !== undefined ? <T lkId={`${props.id}.small`} style={s.small}>{props.small}</T> : null}
    </View>
  );
}

/** .num: a 26 px stop disc; `ok` draws the check, `way` the Next stop's blue, `plain` the Next card's orange. */
export function Num(props: { id: string; kind: 'ok' | 'way' | 'next' | 'later'; text?: string }) {
  const k = props.kind === 'ok' ? s.numOk : props.kind === 'way' ? s.numWay : props.kind === 'later' ? s.numLater : s.numNext;
  return (
    <View {...lk(props.id, [s.num, k])}>
      {props.kind === 'ok' ? <Icon id={`${props.id}.icon`} name="check" size={15} color={color.white} strokeWidth={3} /> : (
        <T lkId={`${props.id}.text`} style={[s.numText, props.kind === 'way' ? { color: c.wayFg } : props.kind === 'later' ? { color: c.ink700 } : null]}>{props.text ?? ''}</T>
      )}
    </View>
  );
}

/** .st: the status chip at the end of a stop row. */
export function Chip(props: { id: string; kind: 'done' | 'way' | 'later'; text: string }) {
  const fg = props.kind === 'done' ? color.okText : props.kind === 'way' ? c.wayFg : color.ink600;
  return (
    <View {...lk(props.id, [s.chip, props.kind === 'done' ? s.chipDone : props.kind === 'way' ? s.chipWay : s.chipLater])}>
      <T lkId={`${props.id}.text`} style={[s.chipText, { color: fg }]}>{props.text}</T>
    </View>
  );
}

const s = StyleSheet.create({
  nosig: { flexDirection: 'row', alignItems: 'center', columnGap: 10, rowGap: 10, backgroundColor: '#fff1cf', borderWidth: 1, borderColor: '#d48806', borderRadius: 11, paddingVertical: 8, paddingHorizontal: 12 },
  nosigTx: { flex: 1, flexShrink: 1 },
  nosigB: type(750, 14.5, 19.6, '#7a4a00'),
  nosigText: type(400, 13, 17.6, '#7a4a00'),
  bar: { backgroundColor: color.teal900, paddingHorizontal: 8, paddingBottom: 10 },
  navrow: { flexDirection: 'row', alignItems: 'center', columnGap: 8, rowGap: 8, minHeight: 44, marginTop: 2 },
  backb: { flexDirection: 'row', alignItems: 'center', columnGap: 2, rowGap: 2, minHeight: 44, paddingHorizontal: 6 },
  backText: type(500, 17, 23.8, color.teal100),
  h1: { ...type(770, 26, 36.4, color.white), marginTop: 2, marginHorizontal: 8 },
  sub: { ...type(400, 14, 19.6, c.teal200), marginTop: 3, marginHorizontal: 8 },
  scroll: { flex: 1 },
  scrollIn: { flexGrow: 1 },
  scrollBody: { paddingTop: 8, paddingHorizontal: 12, paddingBottom: 12, rowGap: 7 },
  grp: { backgroundColor: color.white, borderWidth: 1, borderColor: color.ink200, borderRadius: 12, overflow: 'hidden' },
  setg: { marginTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', columnGap: 10, rowGap: 10, paddingVertical: 7, paddingHorizontal: 12, minHeight: 48 },
  rowSet: { minHeight: 46 },
  rowLine: { borderTopWidth: 1, borderTopColor: c.ink150 },
  tx: { flex: 1, flexShrink: 1 },
  b: type(680, 15, 19.5, color.ink900),
  // F-1640: a pressable title line is its own accessibility element; the padding grows it to 44 pt tall and the negative margin keeps the row's layout.
  bTap: { paddingVertical: 12.25, marginVertical: -12.25 },
  small: type(400, 13, 16.9, color.ink600),
  num: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  numOk: { backgroundColor: color.okLine, borderColor: color.okLine },
  numWay: { backgroundColor: c.wayBg, borderColor: c.wayLine },
  numLater: { backgroundColor: color.white, borderColor: color.ink400 },
  numNext: { backgroundColor: color.orange500, borderColor: color.orange500 },
  numText: type(750, 13, 18.2, color.ink900),
  chip: { flexDirection: 'row', alignItems: 'center', columnGap: 5, rowGap: 5, paddingVertical: 1, paddingHorizontal: 8, borderRadius: 999 },
  chipDone: { backgroundColor: color.okBg },
  chipWay: { backgroundColor: c.wayBg },
  chipLater: { backgroundColor: c.ink150 },
  chipText: type(700, 12, 18, color.ink900),
});
