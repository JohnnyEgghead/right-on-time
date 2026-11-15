// SPDX-License-Identifier: AGPL-3.0-or-later
// The look dump (G-LOOK-PARITY on the native app; P6-NATIVE-SHELL Acceptance "native values read from the view hierarchy"). Only when
// the app is launched with the argument "-bwLook 1" (XCUITest passes it; iOS puts launch arguments in NSUserDefaults, which RN's
// Settings reads). A screen in a frame's state calls dumpLook(state): the BwLook native module (modules/bw-look) walks the UIKit view
// hierarchy and reads, per tagged view (testID = accessibilityIdentifier), its size, background, uniform border and, for text, the
// font face actually drawn (family, weight class, size), the text color and the line height. Yoga's layout inputs a UIView does not
// hold (padding, gap, a one-sided border) come from the style the view was given, recorded here by lk(). The dump goes to
// Documents/bw-look/<state>.json, which the run script copies out of the simulator for ci/look-values/native-compare.ts.
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect } from 'react';
import { Settings, StyleSheet, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

// F-988: the look reader is a test rig seam. EXPO_PUBLIC_BW_RIG is read at bundle time (Metro inlines it), so a bundle made without it
// (the TestFlight archive, scripts/release/archive.sh) has LOOK_ON false and Metro drops the reader and its native module import.
export const LOOK_ON = process.env.EXPO_PUBLIC_BW_RIG === '1' && String(Settings.get('bwLook') ?? '') === '1';

const styles = new Map<string, Record<string, unknown>>();

/** A tagged element: its testID (the XCUITest and the dump read it) and its style, recorded in look mode. */
export function lk<S extends StyleProp<ViewStyle | TextStyle>>(id: string, style?: S): { testID: string; style: S | undefined } {
  if (LOOK_ON) styles.set(id, (StyleSheet.flatten(style) ?? {}) as Record<string, unknown>);
  return { testID: id, style };
}

const trace: string[] = [];

/** A line of the run's trace (bw-look/trace.txt): which dumps were asked for and written, in order; the evidence for a state with no dump. */
export function traceLook(line: string): void {
  if (!LOOK_ON) return;
  trace.push(line);
  try {
    const dir = new Directory(Paths.document, 'bw-look');
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const f = new File(dir, 'trace.txt');
    const before = f.exists ? f.textSync() : '';
    if (f.exists) f.delete();
    f.create();
    f.writeSync(`${before}${line}\n`);
  } catch {
    // the trace is evidence only
  }
}

export async function dumpLook(state: string): Promise<void> {
  if (!LOOK_ON) return;
  traceLook(`dump ${state}`);
  try {
    await writeLook(state);
  } catch (e) {
    // the run's evidence says why a state has no dump (run.sh copies *.txt beside the dumps)
    const dir = new Directory(Paths.document, 'bw-look');
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const f = new File(dir, `${state}.error.txt`);
    if (f.exists) f.delete();
    f.create();
    f.writeSync(String((e as Error)?.stack ?? e));
  }
}

async function writeLook(state: string): Promise<void> {
  const ids = [...styles.keys()];
  // A shipped bundle (no EXPO_PUBLIC_BW_RIG): this conditional folds to {} and Metro drops the native reader's import with it.
  const native: Record<string, unknown> = process.env.EXPO_PUBLIC_BW_RIG === '1' ? await (await import('../../modules/bw-look/index.ts')).readLook(ids) : {};
  const views: Record<string, { native: unknown; style: Record<string, unknown> }> = {};
  for (const id of ids) if (native[id]) views[id] = { native: native[id], style: styles.get(id) ?? {} };
  const dir = new Directory(Paths.document, 'bw-look');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const f = new File(dir, `${state}.json`);
  if (f.exists) f.delete();
  f.create();
  f.writeSync(JSON.stringify({ state, views }, null, 1));
}

/** Dumps the screen once it has rested in `state` (the fonts drawn, the layout settled); a new state dumps again. */
export function useLookDump(state: string | null): void {
  useEffect(() => {
    if (!LOOK_ON || state === null) return;
    const t = setTimeout(() => void dumpLook(state), 900);
    return () => clearTimeout(t);
  }, [state]);
}
