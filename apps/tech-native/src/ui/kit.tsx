// SPDX-License-Identifier: AGPL-3.0-or-later
// The native kit pieces the shell draws (DK-117 option B; DK-50 navigation bar, DK-54 field, DK-56 buttons, settings rows and
// messages, DK-57 state fragments). Every value is the frame's computed value (tokens.ts); each tagged view's id is its testID.
import { useEffect, useRef, useState, type ComponentRef, type ReactNode, type Ref } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { T as Text, useBigText } from './text-size.tsx';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from './Icon.tsx';
import type { NativeIcon } from './icon-paths.ts';
import { lk } from './look.ts';
import { color, type } from './tokens.ts';

/** DK-50 option B bar: the teal bar under the status bar, a text button each side and the title between (Cancel, title, Save). */
export function NavBar(props: { id: string; title: string; left: { id: string; label: string; onPress: () => void }; right: { id: string; label: string; onPress: () => void; disabled?: boolean } }) {
  const top = useSafeAreaInsets().top;
  if (useBigText()) {
    // 14.2 item 2: at the largest sizes the 2 buttons share the first line and the title wraps under them, so no word is cut.
    return (
      <View style={[s.nav, { paddingTop: top }]}>
        <View {...lk(props.id, s.navrowBig)}>
          <BarButton {...props.left} strong={false} />
          <BarButton {...props.right} strong />
          <Text {...lk(`${props.id}.title`, s.navTitleBig)} accessibilityRole="header">{props.title}</Text>
        </View>
      </View>
    );
  }
  return (
    <View style={[s.nav, { paddingTop: top }]}>
      <View {...lk(props.id, s.navrow)}>
        <BarButton {...props.left} strong={false} />
        <Text {...lk(`${props.id}.title`, s.navTitle)} accessibilityRole="header" numberOfLines={1}>{props.title}</Text>
        <BarButton {...props.right} strong />
      </View>
    </View>
  );
}

function BarButton(props: { id: string; label: string; onPress: () => void; strong: boolean; disabled?: boolean }) {
  return (
    <Pressable {...lk(props.id, [s.tb, props.disabled ? s.off : null])} onPress={props.onPress} disabled={props.disabled}
      accessibilityRole="button" accessibilityState={{ disabled: !!props.disabled }}>
      <Text {...lk(`${props.id}.text`, props.strong ? s.tbStrongText : s.tbText)}>{props.label}</Text>
    </Pressable>
  );
}

/** DK-54 field: label, the input box with its icon, and a hint or a field message under it. */
export function Field(props: { id: string; label: string; icon: NativeIcon; state: 'focus' | 'rest' | 'bad' | 'locked'; input: TextInputProps; below?: ReactNode; inputRef?: Ref<ComponentRef<typeof TextInput>>; right?: ReactNode }) {
  const box = props.state === 'focus' ? s.inpFocus : props.state === 'bad' ? s.inpBad : props.state === 'locked' ? s.inpLocked : s.inpRest;
  // The 3 px ring of a focused or refused field (the kit's outline) is a border on a view around the box, never the box's own `outline`
  // style: once a field has drawn that outline, React Native on iOS gives no field the keyboard focus again (fix pass 1 probe 5, F-1105).
  const ring = props.state === 'focus' ? s.ringFocus : props.state === 'bad' ? s.ringBad : null;
  return (
    <View {...lk(props.id, s.fld)}>
      <Text {...lk(`${props.id}.label`, s.label)}>{props.label}</Text>
      <View style={[s.ring, ring]}>
        <View {...lk(`${props.id}.inp`, [s.inp, box])}>
          <Icon id={`${props.id}.icon`} name={props.icon} size={18} color={color.ink500} />
          <TextInput ref={props.inputRef} {...props.input} {...lk(`${props.id}.value`, props.state === 'locked' ? s.valueLocked : s.value)} />
          {props.right}
        </View>
      </View>
      {props.below}
    </View>
  );
}

export function Hint(props: { id: string; text: string; center?: boolean; marginTop?: number }) {
  return <Text {...lk(props.id, [s.hint, props.center ? s.center : null, { marginTop: props.marginTop ?? 6 }])}>{props.text}</Text>;
}

/** DK-56 wide secondary button (.sbtn.wide), its ghost form, and its busy form with the kit spinner. */
export function WideButton(props: { id: string; label: string; icon?: NativeIcon | undefined; ghost?: boolean; disabled?: boolean; busy?: boolean; onPress: () => void }) {
  const fg = props.ghost ? (props.disabled ? color.ink500 : color.teal800) : color.ink800;
  return (
    <Pressable {...lk(props.id, [s.sbtn, props.ghost ? s.ghost : s.solid])} onPress={props.onPress} disabled={props.disabled || props.busy}
      accessibilityRole="button" accessibilityState={{ disabled: !!props.disabled, busy: !!props.busy }}>
      {props.busy ? <Spinner id={`${props.id}.spin`} /> : props.icon ? <Icon id={`${props.id}.icon`} name={props.icon} size={16} color={color.teal700} /> : null}
      <Text {...lk(`${props.id}.text`, [s.sbtnText, { color: fg }])}>{props.label}</Text>
    </Pressable>
  );
}

/** The phone's Reduce Motion setting, read at once and followed while the screen is open (true until the first read answers, so nothing turns early). */
export function useReduceMotion(): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (live) setOn(v); });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setOn);
    return () => { live = false; sub.remove(); };
  }, []);
  return on;
}

/** The kit's busy ring (.r1-spin.dark): 16 px, a 2 px ring in --ink-300 with its top quarter in --teal-700, turning. */
function Spinner(props: { id: string }) {
  const turn = useRef(new Animated.Value(0)).current;
  const reduce = useReduceMotion();
  useEffect(() => {
    if (reduce) return; // Reduce Motion (14.2 item 5): the ring stands still; the button's label and busy state still say it is working
    const a = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true }));
    a.start();
    return () => a.stop();
  }, [turn, reduce]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return <Animated.View {...lk(props.id, s.spin)} style={[s.spin, { transform: [{ rotate }] }]} />;
}

/**
 * DK-56 message boxes: the green Connected box (.okmsg) and the red error box (.errbox). A link is the last line of the text; with `own`
 * it is its own control under the words (a button iOS reaches by itself, F-1105: a link nested in a line of text is no accessibility element).
 */
export function Message(props: { id: string; tone: 'ok' | 'bad'; icon: NativeIcon; text: string; link?: { label: string; onPress: () => void; own?: boolean } }) {
  const ok = props.tone === 'ok';
  if (props.link?.own) {
    return (
      <View {...lk(props.id, [s.msg, ok ? s.ok : s.bad])} accessibilityLiveRegion="polite">
        <Icon id={`${props.id}.icon`} name={props.icon} size={18} color={ok ? color.okText : color.badText} strokeWidth={ok ? 2.6 : 1.9} marginTop={1} />
        <View style={s.msgText}>
          <Text {...lk(`${props.id}.text`, ok ? s.okText : s.badText)} accessibilityRole="alert">{props.text}</Text>
          <Pressable {...lk(`${props.id}.link`, s.msgOwnLink)} onPress={props.link.onPress} accessibilityRole="link" accessibilityLabel={props.link.label}>
            <Text style={s.msgLink}>{props.link.label}</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  return (
    <View {...lk(props.id, [s.msg, ok ? s.ok : s.bad])} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Icon id={`${props.id}.icon`} name={props.icon} size={18} color={ok ? color.okText : color.badText} strokeWidth={ok ? 2.6 : 1.9} marginTop={1} />
      <Text {...lk(`${props.id}.text`, [s.msgText, ok ? s.okText : s.badText])}>
        {props.text}
        {props.link ? <Text {...lk(`${props.id}.link`, s.msgLink)} onPress={props.link.onPress} accessibilityRole="link">{`\n${props.link.label}`}</Text> : null}
      </Text>
    </View>
  );
}

/** DK-57 field message (.r1-fmsg) under a field that holds no address. */
export function FieldMessage(props: { id: string; text: string }) {
  return (
    <View {...lk(props.id, s.fmsg)} accessibilityRole="alert">
      <Icon id={`${props.id}.icon`} name="alert" size={18} color={color.badText} marginTop={1} />
      <Text {...lk(`${props.id}.text`, s.fmsgText)}>{props.text}</Text>
    </View>
  );
}

/** DK-56 settings row in its group (.grp.setg .row.set): icon, key, value and chevron; opens the next screen. */
export function SettingsRow(props: { id: string; icon: NativeIcon; label: string; value: string; onPress: () => void; bare?: boolean }) {
  const big = useBigText();
  const row = (
      <Pressable {...lk(props.id, s.row)} onPress={props.onPress} accessibilityRole="button" accessibilityValue={{ text: props.value }}>
        <Icon id={`${props.id}.icon`} name={props.icon} size={19} color={color.teal700} />
        {big ? (
          // 14.2 item 2: at the largest sizes the value goes under its key and wraps, so a long address is never cut or pushed off the screen.
          <View style={s.rowBig}>
            <Text {...lk(`${props.id}.key`, s.rowKeyBig)}>{props.label}</Text>
            <Text {...lk(`${props.id}.value`, s.rowValue)}>{props.value}</Text>
          </View>
        ) : (
          <>
            <Text {...lk(`${props.id}.key`, s.rowKey)}>{props.label}</Text>
            <Text {...lk(`${props.id}.value`, s.rowValue)} numberOfLines={1}>{props.value}</Text>
          </>
        )}
        <Icon id={`${props.id}.chev`} name="chevRight" size={16} color={color.ink400} />
      </Pressable>
  );
  // bare: the row sits in a group the caller draws (the sign-in screen's Language and Server rows share 1 group card).
  return props.bare ? row : <View {...lk(`${props.id}.grp`, s.setg)}>{row}</View>;
}

const s = StyleSheet.create({
  nav: { backgroundColor: color.teal900, paddingHorizontal: 8, paddingBottom: 8 },
  navrow: { flexDirection: 'row', alignItems: 'center', columnGap: 8, rowGap: 8, height: 44 },
  navrowBig: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: 8, rowGap: 8 },
  navTitleBig: { ...type(700, 17, 23.8, color.white), flexBasis: '100%', textAlign: 'center' },
  navTitle: { ...type(700, 17, 23.8, color.white), flex: 1, textAlign: 'center' },
  tb: { minHeight: 44, minWidth: 64, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  off: { opacity: 0.45 },
  tbText: type(400, 16, 22.4, color.teal100),
  tbStrongText: type(750, 16, 22.4, color.orange300),
  fld: {},
  label: { ...type(650, 13.5, 18.9, color.ink800), marginBottom: 5 },
  inp: {
    minHeight: 48, backgroundColor: color.white, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, columnGap: 10, rowGap: 10,
    flexDirection: 'row', alignItems: 'center', overflow: 'hidden',
  },
  inpRest: { borderColor: color.ink400 },
  inpFocus: { borderColor: color.teal600 },
  inpBad: { borderColor: color.badLine },
  ring: { margin: -3, borderWidth: 3, borderRadius: 15, borderColor: 'transparent' },
  ringFocus: { borderColor: color.teal100 },
  ringBad: { borderColor: color.badBg },
  inpLocked: { borderColor: color.ink400, backgroundColor: '#f3f4f6' },
  value: { ...type(400, 17, 23.8, color.ink900), flex: 1, padding: 0 },
  valueLocked: { ...type(400, 17, 23.8, '#374151'), flex: 1, padding: 0 },
  hint: type(400, 12.5, 17.5, color.ink600),
  center: { textAlign: 'center' },
  sbtn: {
    marginTop: 10, minHeight: 44, borderWidth: 1, borderRadius: 11, paddingVertical: 3, paddingHorizontal: 6, columnGap: 6, rowGap: 6,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  solid: { backgroundColor: color.white, borderColor: color.ink300 },
  ghost: { borderColor: 'transparent' },
  sbtnText: { ...type(650, 15, 18, color.ink800), textAlign: 'center' },
  spin: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: color.ink300, borderTopColor: color.teal700 },
  msg: { marginTop: 10, borderWidth: 1, borderRadius: 11, paddingVertical: 10, paddingHorizontal: 12, columnGap: 9, rowGap: 9, flexDirection: 'row', overflow: 'hidden' },
  ok: { backgroundColor: color.okBg, borderColor: color.okLine },
  bad: { backgroundColor: color.badBg, borderColor: color.badLine },
  msgText: { flexShrink: 1 },
  okText: type(600, 14, 19.6, color.okText),
  msgLink: { ...type(650, 14, 19.6, color.teal700), textDecorationLine: 'underline' },
  msgOwnLink: { alignSelf: 'flex-start' },
  badText: type(400, 14, 19.6, color.badText),
  fmsg: { marginTop: 6, flexDirection: 'row', columnGap: 6, rowGap: 6 },
  fmsgText: { ...type(550, 13.5, 18.9, color.badText), flexShrink: 1 },
  setg: { marginTop: 6, backgroundColor: color.white, borderWidth: 1, borderColor: color.ink200, borderRadius: 12, overflow: 'hidden' },
  row: { paddingVertical: 7, paddingHorizontal: 12, columnGap: 8, rowGap: 8, flexDirection: 'row', alignItems: 'center', minHeight: 46 },
  rowKey: { ...type(600, 15, 21, color.ink900), flex: 1 },
  rowValue: type(400, 15, 21, color.ink600),
  rowBig: { flex: 1, minWidth: 0 },
  rowKeyBig: type(600, 15, 21, color.ink900),
});
