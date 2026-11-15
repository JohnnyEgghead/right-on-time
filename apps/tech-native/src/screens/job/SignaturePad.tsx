// SPDX-License-Identifier: AGPL-3.0-or-later
// CTL-TEC-07-14 Customer signature, native (DK-117 .sigpad: "Sign here with a finger"): the finger's strokes drawn as they go (react-
// native-svg), each finished stroke handed to the finish screen, which keeps them on the phone at once (copies.ts) and makes SD-32's
// PNG from them at the finish (signature.ts). The pad's size in points goes with the strokes, so the PNG keeps the pad's shape.
import { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import { T as Text } from '../../ui/text-size.tsx';
import { lk } from '../../ui/look.ts';
import { color, type } from '../../ui/tokens.ts';
import { PEN, type Stroke } from './signature.ts';

/**
 * The strokes as round-capped segments, each a plain view (a pen-wide bar turned to its angle). The segments are the measured fix: with
 * react-native-svg paths the whole screen left the accessibility tree once a stroke existed, so XCUITest found nothing on SCR-TEC-07
 * (P6-NATIVE-JOB run 6). Why the paths did that was not root-caused; do not read a cause into the SVG view.
 */
function segments(strokes: readonly Stroke[]): { key: string; left: number; top: number; width: number; angle: number }[] {
  const out: { key: string; left: number; top: number; width: number; angle: number }[] = [];
  strokes.forEach((st, i) => {
    st.forEach((a, j) => {
      const b = st[j + 1] ?? (st.length === 1 ? a : null);
      if (!b) return;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const width = len + PEN;
      out.push({ key: `${i}-${j}`, left: (a.x + b.x) / 2 - width / 2, top: (a.y + b.y) / 2 - PEN / 2, width, angle: Math.atan2(b.y - a.y, b.x - a.x) });
    });
  });
  return out;
}

export function SignaturePad(props: { strokes: Stroke[]; hint: string; label: string; onStroke: (all: Stroke[], size: { width: number; height: number }) => void; onDrawing?: (on: boolean) => void }) {
  const [live, setLive] = useState<Stroke | null>(null);
  const size = useRef({ width: 366, height: 92 });
  const cur = useRef<Stroke>([]);
  const strokes = useRef(props.strokes);
  strokes.current = props.strokes;
  const onStroke = useRef(props.onStroke);
  onStroke.current = props.onStroke;
  const onDrawing = useRef(props.onDrawing);
  onDrawing.current = props.onDrawing;
  const end = () => {
    const done = cur.current;
    cur.current = [];
    setLive(null);
    onDrawing.current?.(false);
    if (done.length > 0) onStroke.current([...strokes.current, done], size.current);
  };
  const endRef = useRef(end);
  endRef.current = end;
  const pan = useMemo(() => PanResponder.create({
    // Captured, so no child (the hint, a drawn segment) takes the finger first.
    onStartShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponderCapture: () => true,
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    onPanResponderGrant: (e) => {
      onDrawing.current?.(true);
      cur.current = [{ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }];
      setLive([...cur.current]);
    },
    onPanResponderMove: (e) => {
      const { locationX: x, locationY: y } = e.nativeEvent;
      cur.current.push({ x: Math.max(0, Math.min(size.current.width, x)), y: Math.max(0, Math.min(size.current.height, y)) });
      setLive([...cur.current]);
    },
    // A stroke ends when the finger lifts, or when iOS takes the touch away (a scroll that began first): either way it is kept.
    onPanResponderRelease: () => endRef.current(),
    onPanResponderTerminate: () => endRef.current(),
  }), []);
  const all = live ? [...props.strokes, live] : props.strokes;
  return (
    <View {...lk('fin.sig', s.pad)} {...pan.panHandlers} accessible accessibilityRole="adjustable" accessibilityLabel={props.label}
      accessibilityValue={{ text: String(props.strokes.length) }}
      onLayout={(e) => { size.current = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height }; }}>
      {all.length === 0 ? <Text {...lk('fin.sig.text', s.hint)} pointerEvents="none">{props.hint}</Text> : null}
      {/* The drawn strokes take no touch and are hidden from accessibility: every touch stays on the pad. */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {segments(all).map((g) => (
          <View key={g.key} style={[s.seg, { left: g.left, top: g.top, width: g.width, transform: [{ rotate: `${g.angle}rad` }] }]} />
        ))}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  pad: { height: 92, borderWidth: 1, borderStyle: 'dashed', borderColor: color.ink300, borderRadius: 12, backgroundColor: color.white, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  hint: type(400, 14, 19.6, color.ink500),
  seg: { position: 'absolute', height: PEN, borderRadius: PEN / 2, backgroundColor: color.ink900 },
});
