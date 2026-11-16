// SPDX-License-Identifier: AGPL-3.0-or-later
// The DK-117 pieces the native job screens draw (mockups/pages/r1-ios-b.html option B: the .bar2 navigation bar, settings groups and
// rows, the .pbtn/.sbtn/.nbtn buttons, the message boxes and the sheet bar). Every value is the frame's computed value (read in
// headless Chromium, ci/look-values/native-job-cases.ts pairs each tagged view with its frame element); the kit's own pieces
// (ui/kit.tsx) are reused where the frame draws the same element. No value here is a contrast pick (OA-84).
import type { ComponentRef, ReactNode, Ref } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { T as Text, useBigText } from '../../ui/text-size.tsx';
import { SvgXml } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '../../ui/Icon.tsx';
import type { NativeIcon } from '../../ui/icon-paths.ts';
import { lk } from '../../ui/look.ts';
import { color, type } from '../../ui/tokens.ts';

/** The frame's colors the shell's tokens do not hold (DK-117 :root). */
export const jc = {
  ink150: '#eceef1',
  ink100: '#f3f4f6',
  teal200: '#b9e0e9',
  teal50: '#f1f8fa',
  orange700: '#b4480c',
  orange600: '#c1550d',
  orange100: '#fdebdc',
  orange50: '#fff6ee',
  schedLine: '#b8c2cc',
  schedInk: '#334155',
  riskBg: '#fff1cf',
  riskInk: '#7a4a00',
  riskLine: '#d48806',
} as const;

/** The frame's Remove-line cross (mockups/pages/r1-ios-b.html XI.close; the web finish screen's XICON). */
const CLOSE = '<path d="M6 6l12 12M18 6L6 18"/>';
export function CloseIcon(props: { id: string; size: number; color: string }) {
  const xml = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${CLOSE}</svg>`;
  return <SvgXml {...lk(props.id, { width: props.size, height: props.size })} xml={xml} width={props.size} height={props.size} color={props.color} accessible={false} />;
}

/** DK-117 .bar2: the teal bar under the status bar, a back button, the large title and the line under it. */
export function JobBar(props: { id: string; back: string; onBack: () => void; title: string; sub?: ReactNode; mid?: ReactNode; right?: ReactNode }) {
  const top = useSafeAreaInsets().top;
  return (
    <View style={[s.bar, { paddingTop: top }]}>
      <View {...lk(`${props.id}.bar.nav`, s.navrow)}>
        <Pressable {...lk(`${props.id}.bar.back`, s.backb)} onPress={props.onBack} accessibilityRole="button" accessibilityLabel={props.back}>
          <Icon id={`${props.id}.bar.back.icon`} name="chevLeft" size={24} color={color.teal100} />
          <Text {...lk(`${props.id}.bar.back.text`, s.backText)}>{props.back}</Text>
        </Pressable>
        <View style={s.spacer}>{props.mid}</View>
        {props.right}
      </View>
      <Text {...lk(`${props.id}.bar.title`, s.title)} accessibilityRole="header">{props.title}</Text>
      {props.sub ? <View style={s.sub}>{props.sub}</View> : null}
    </View>
  );
}

export const barSubText: TextStyle = type(400, 14, 19.6, jc.teal200);

/** The screen's scrolling body (.scroll): the frame's padding and the 7 px gap between its children. */
export function Scroll(props: { id: string; children: ReactNode; scrollEnabled?: boolean; scrollRef?: Ref<ComponentRef<typeof ScrollView>>; inline?: boolean; onInlineLayout?: (y: number) => void }) {
  const tag = lk(props.id, s.scroll);
  // inline: the screen puts this body, with its bar and its pinned actions, inside 1 scroll of its own (the largest text sizes, 14.2 item 2).
  if (props.inline) return <View testID={tag.testID} style={tag.style} onLayout={(e) => props.onInlineLayout?.(e.nativeEvent.layout.y)}>{props.children}</View>;
  return <ScrollView ref={props.scrollRef} testID={tag.testID} contentContainerStyle={tag.style} scrollEnabled={props.scrollEnabled ?? true} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>{props.children}</ScrollView>;
}

export function GHead(props: { id: string; text: string; onLayout?: (e: LayoutChangeEvent) => void }) {
  return <Text {...lk(props.id, s.ghead)} accessibilityRole="header" {...(props.onLayout ? { onLayout: props.onLayout } : {})}>{props.text}</Text>;
}

/** A settings group (.grp). */
export function Group(props: { id: string; children: ReactNode }) {
  return <View {...lk(props.id, s.grp)}>{props.children}</View>;
}

/** A group row (.row): every row after the first has the frame's top line. */
export function Row(props: { id: string; first: boolean; children: ReactNode; gap?: 8; onPress?: () => void; label?: string; value?: string; style?: StyleProp<ViewStyle> }) {
  const style = [s.row, props.gap === 8 ? s.gap8 : null, props.first ? null : s.rowLine, props.style];
  if (props.onPress) {
    return (
      <Pressable {...lk(props.id, style)} onPress={props.onPress} accessibilityRole="button" {...(props.label ? { accessibilityLabel: props.label } : {})}
        {...(props.value !== undefined ? { accessibilityValue: { text: props.value } } : {})}>
        {props.children}
      </Pressable>
    );
  }
  return <View {...lk(props.id, style)}>{props.children}</View>;
}

/** A row's text column (.tx): the bold line and the small line under it. */
export function Tx(props: { id: string; b: string; small?: string | null; bStyle?: StyleProp<TextStyle> }) {
  return (
    <View style={s.tx}>
      <Text {...lk(`${props.id}.b`, [s.txB, props.bStyle])}>{props.b}</Text>
      {props.small ? <Text {...lk(`${props.id}.small`, s.txSmall)}>{props.small}</Text> : null}
    </View>
  );
}

/** The job's large action buttons (.pbtn): Directions with its minutes, Call. */
export function PButton(props: { id: string; icon: NativeIcon; label: string; small?: string | null; onPress: () => void; a11y?: string }) {
  const big = useBigText(); // 14.2 item 2: its screen stacks its buttons in 1 column, each as wide as the screen, words under the icon
  return (
    <Pressable {...lk(props.id, [s.pbtn, big ? s.pbtnBig : null])} onPress={props.onPress} accessibilityRole="button" accessibilityLabel={props.a11y ?? [props.label, props.small].filter(Boolean).join(', ')}>
      <Icon id={`${props.id}.icon`} name={props.icon} size={19} color={color.teal800} />
      <Text {...lk(`${props.id}.text`, s.pbtnText)}>{props.label}</Text>
      {props.small ? <Text {...lk(`${props.id}.minutes`, s.pbtnSmall)}>{props.small}</Text> : null}
    </Pressable>
  );
}

/** The secondary button (.sbtn), its off form (.sbtn.dis) and its wide form (.sbtn.wide). */
export function SButton(props: { id: string; icon?: NativeIcon; iconStroke?: number; label: string; off?: boolean; dim?: boolean; wide?: boolean; onPress: () => void; hint?: string }) {
  // off: not pressable (.sbtn.dis); dim: drawn as .sbtn.dis but still pressable (Send now with no signal known: a tap tries).
  const off = !!props.off;
  const look = off || !!props.dim;
  const big = useBigText();
  return (
    <Pressable {...lk(props.id, [s.sbtn, props.wide ? s.wide : big ? s.flex0 : s.flex1, look ? s.sbtnOff : s.sbtnOn])} onPress={props.onPress} disabled={off}
      accessibilityRole="button" accessibilityLabel={props.label} accessibilityState={{ disabled: off }} {...(props.hint ? { accessibilityHint: props.hint } : {})}>
      {props.icon ? <Icon id={`${props.id}.icon`} name={props.icon} size={16} color={color.teal700} {...(props.iconStroke ? { strokeWidth: props.iconStroke } : {})} /> : null}
      <Text {...lk(`${props.id}.text`, [props.wide ? s.sbtnWideText : s.sbtnText, { color: look ? color.ink500 : color.ink800 }])}>{props.label}</Text>
    </Pressable>
  );
}

/** The sheet and confirm buttons (.nbtn, .nbtn.pri). */
export function NButton(props: { id: string; icon?: NativeIcon; iconStroke?: number; label: string; pri?: boolean; busy?: boolean; onPress: () => void; flex?: boolean }) {
  const fg = props.pri ? color.white : color.ink900;
  return (
    <Pressable {...lk(props.id, [s.nbtn, props.pri ? s.nbtnPri : s.nbtnSec, props.flex ? s.flex1 : null])} onPress={props.onPress} disabled={props.busy}
      accessibilityRole="button" accessibilityLabel={props.label} accessibilityState={{ busy: !!props.busy }}>
      {props.icon ? <Icon id={`${props.id}.icon`} name={props.icon} size={19} color={fg} {...(props.iconStroke ? { strokeWidth: props.iconStroke } : {})} /> : null}
      <Text {...lk(`${props.id}.text`, [s.nbtnText, { color: fg }])}>{props.label}</Text>
    </Pressable>
  );
}

/** The error box (.errbox), with an optional link line under its words (CTL-TEC-06-06 Open Settings). */
export function ErrBox(props: { id: string; text: string; lastTry?: string | undefined; link?: { id: string; label: string; onPress: () => void } }) {
  return (
    <View {...lk(props.id, s.err)} accessibilityRole="alert">
      <Icon id={`${props.id}.icon`} name="alert" size={18} color={color.badText} marginTop={1} />
      <View style={s.errCol}>
        <Text {...lk(`${props.id}.text`, s.errText)}>{props.text}</Text>
        {props.lastTry ? <Text {...lk(`${props.id}.lastTry`, s.errText)}>{props.lastTry}</Text> : null}
        {props.link ? <Text {...lk(props.link.id, s.errLink)} onPress={props.link.onPress} accessibilityRole="link">{props.link.label}</Text> : null}
      </View>
    </View>
  );
}

/** CTL-CMP-10-01 No signal (.nosig): the badge, the bold line and the words under it. */
export function NoSignal(props: { id: string; title: string; text: string }) {
  return (
    <View {...lk(props.id, s.nosig)} accessibilityRole="alert">
      <View {...lk(`${props.id}.badge`, s.nosigBadge)}>
        <Icon id={`${props.id}.icon`} name="signal" size={18} color={jc.riskInk} />
      </View>
      <View style={s.tx}>
        <Text {...lk(`${props.id}.title`, s.nosigTitle)}>{props.title}</Text>
        <Text {...lk(`${props.id}.text`, s.nosigText)}>{props.text}</Text>
      </View>
    </View>
  );
}

/** The info box (.infobox). */
export function InfoBox(props: { id: string; text: string }) {
  return (
    <View {...lk(props.id, s.info)}>
      <Icon id={`${props.id}.icon`} name="info" size={18} color={color.teal900} marginTop={1} />
      <Text {...lk(`${props.id}.text`, s.infoText)}>{props.text}</Text>
    </View>
  );
}

/** A text link (.lnk). */
export function Lnk(props: { id: string; label: string; onPress: () => void; style?: StyleProp<TextStyle> }) {
  return <Text {...lk(props.id, [s.lnk, props.style])} onPress={props.onPress} accessibilityRole="link">{props.label}</Text>;
}

/** The waiting chip on a row (.wait). */
export function WaitChip(props: { id: string; text: string }) {
  return <Text {...lk(props.id, s.wait)}>{props.text}</Text>;
}

/** The sheets' bar (.sbar3): a text button each side and the bold title between. */
export function SheetBar(props: { id: string; titleId: string; title: string; left: { id: string; label: string; onPress: () => void }; right?: { id: string; label: string; onPress: () => void; off?: boolean } }) {
  const big = useBigText(); // 14.2 item 2: the 2 buttons share the first line, the title wraps under them
  const title = <Text {...lk(props.titleId, [s.sheetTitle, big ? s.sheetTitleBig : null])} accessibilityRole="header">{props.title}</Text>;
  return (
    <View {...lk(props.id, [s.sbar3, big ? s.sbar3Big : null])}>
      <Pressable {...lk(props.left.id, s.tb)} onPress={props.left.onPress} accessibilityRole="button" accessibilityLabel={props.left.label}>
        <Text {...lk(`${props.left.id}.text`, s.tbText)}>{props.left.label}</Text>
      </Pressable>
      {big ? null : title}
      {props.right ? (
        <Pressable {...lk(props.right.id, [s.tb, props.right.off ? s.off : null])} onPress={props.right.onPress} accessibilityRole="button" accessibilityLabel={props.right.label}>
          <Text {...lk(`${props.right.id}.text`, s.tbStrong)}>{props.right.label}</Text>
        </Pressable>
      ) : big ? null : <View style={s.tbSpace} />}
      {big ? title : null}
    </View>
  );
}

export const s = StyleSheet.create({
  bar: { backgroundColor: color.teal900, paddingHorizontal: 8, paddingBottom: 10 },
  navrow: { height: 44, marginTop: 2, flexDirection: 'row', alignItems: 'center', columnGap: 8, rowGap: 8 },
  backb: { height: 44, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', columnGap: 2, rowGap: 2 },
  backText: type(500, 17, 23.8, color.teal100),
  spacer: { flex: 1, alignItems: 'center' },
  title: { ...type(770, 26, 36.4, color.white), letterSpacing: -0.52, marginTop: 2, marginHorizontal: 8 },
  sub: { marginTop: 3, marginHorizontal: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  scroll: { paddingTop: 8, paddingHorizontal: 12, paddingBottom: 24, rowGap: 7, columnGap: 7 },
  ghead: { ...type(750, 12, 16.8, color.ink600), textTransform: 'uppercase', letterSpacing: 0.84, marginTop: 2, marginHorizontal: 4, marginBottom: -2 },
  grp: { backgroundColor: color.white, borderRadius: 12, borderWidth: 1, borderColor: color.ink200, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', columnGap: 10, rowGap: 10, paddingVertical: 7, paddingHorizontal: 12, minHeight: 48 },
  gap8: { columnGap: 8, rowGap: 8 },
  rowLine: { borderTopWidth: 1, borderTopColor: jc.ink150 },
  tx: { flex: 1, minWidth: 0, flexDirection: 'column' },
  txB: type(680, 15, 19.5, color.ink900),
  txSmall: type(400, 13, 16.9, color.ink600),
  pbtn: {
    flex: 1, minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: color.teal700, backgroundColor: color.white,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', columnGap: 7, rowGap: 7, overflow: 'hidden',
  },
  pbtnText: { ...type(700, 15, 21, color.teal800), textAlign: 'center' },
  pbtnSmall: { ...type(550, 13, 18.2, color.ink500), textAlign: 'center' },
  flex1: { flex: 1 },
  flex0: { flex: 0 },
  pbtnBig: { flex: 0, flexDirection: 'column', paddingVertical: 6, paddingHorizontal: 8, columnGap: 2, rowGap: 2 },
  sbtn: {
    minHeight: 44, borderRadius: 11, borderWidth: 1, paddingVertical: 3, paddingHorizontal: 6, columnGap: 6, rowGap: 6,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  wide: { marginTop: 10, alignSelf: 'stretch' },
  sbtnOn: { backgroundColor: color.white, borderColor: color.ink300 },
  sbtnOff: { backgroundColor: jc.ink100, borderColor: color.ink200 },
  sbtnText: { ...type(650, 13.5, 16.2, color.ink800), textAlign: 'center', flexShrink: 1 },
  sbtnWideText: { ...type(650, 15, 18, color.ink800), textAlign: 'center' },
  nbtn: { minHeight: 50, borderRadius: 13, paddingVertical: 4, paddingHorizontal: 12, columnGap: 8, rowGap: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  nbtnPri: { backgroundColor: color.teal700 },
  nbtnSec: { backgroundColor: jc.ink150 },
  nbtnText: { ...type(650, 17, 23.8, color.ink900), textAlign: 'center' },
  err: { marginTop: 10, borderWidth: 1, borderRadius: 11, paddingVertical: 10, paddingHorizontal: 12, columnGap: 9, rowGap: 9, flexDirection: 'row', alignItems: 'flex-start', overflow: 'hidden', backgroundColor: color.badBg, borderColor: color.badLine },
  errCol: { flex: 1, flexShrink: 1 },
  errText: type(400, 14, 19.6, color.badText),
  errLink: { ...type(650, 14, 19.6, color.teal700), textDecorationLine: 'underline', marginTop: 2 },
  nosig: { backgroundColor: jc.riskBg, borderWidth: 1, borderColor: jc.riskLine, borderRadius: 11, paddingVertical: 8, paddingHorizontal: 12, columnGap: 10, rowGap: 10, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  nosigBadge: { width: 34, height: 34, borderRadius: 17, borderWidth: 2, borderColor: jc.riskLine, backgroundColor: color.white, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  nosigTitle: type(780, 15, 21, jc.riskInk),
  nosigText: type(550, 12.5, 16.875, jc.riskInk),
  info: { marginTop: 8, backgroundColor: jc.teal50, borderWidth: 1, borderColor: jc.teal200, borderRadius: 11, paddingVertical: 10, paddingHorizontal: 12, columnGap: 9, rowGap: 9, flexDirection: 'row', alignItems: 'flex-start', overflow: 'hidden' },
  infoText: { ...type(400, 14, 19.6, color.teal900), flex: 1 },
  lnk: { ...type(650, 14, 19.6, color.teal700), textDecorationLine: 'underline' },
  wait: { ...type(650, 12, 16.8, jc.riskInk), backgroundColor: jc.riskBg, borderRadius: 6, paddingVertical: 1, paddingHorizontal: 6, overflow: 'hidden' },
  sbar3: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tb: { minHeight: 44, minWidth: 64, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  tbSpace: { width: 64 },
  off: { opacity: 0.45 },
  tbText: type(400, 16, 22.4, color.teal700),
  tbStrong: type(750, 16, 22.4, jc.orange700),
  sheetTitle: type(700, 17, 23.8, color.ink900),
  sbar3Big: { flexWrap: 'wrap', rowGap: 4 },
  sheetTitleBig: { width: '100%', paddingHorizontal: 8 },
});
