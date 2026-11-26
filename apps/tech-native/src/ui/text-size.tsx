// SPDX-License-Identifier: AGPL-3.0-or-later
// The technician's Text size choice (CTL-TEC-10-09; FR-TECH-15, NFR-06) for the whole signed-in app (F-1072 item 6): 1 provider at the app's
// root (App.tsx, under the person's reads) and 1 text primitive, T, that every screen's text goes through. The Map, Directions, Parts and Me
// screens took it first (mapme/parts.tsx re-exports it); Today, the job screens, the sheets and the tab bar draw their text with it too.
import { createContext, useContext } from 'react';
import { StyleSheet, Text, useWindowDimensions, type TextProps, type TextStyle } from 'react-native';
import { TEXT_PERCENT, type TextSize } from '../screens/mapme/model.ts';
import { BIG_TEXT_SCALE, isBigText } from './big-text.ts';
import { lk } from './look.ts';

const Scale = createContext<TextSize>('standard');
export const TextSizeProvider = Scale.Provider;

/** The text size in force where this is read (Standard with no provider above, as signed out). */
const useTextSize = (): TextSize => useContext(Scale);

/** Text at the chosen size: the font size and the line height grow by the choice's share (Standard 100%, Large 112.5%, Larger 125%). */
export function T(props: TextProps & { lkId?: string }) {
  const pct = TEXT_PERCENT[useContext(Scale)] / 100;
  const { lkId, style, ...rest } = props;
  const flat = StyleSheet.flatten(style) as TextStyle | undefined;
  const scaled = pct === 1 || !flat ? style : { ...flat, ...(flat.fontSize ? { fontSize: flat.fontSize * pct } : {}), ...(flat.lineHeight ? { lineHeight: flat.lineHeight * pct } : {}) };
  const tag = lkId ? lk(lkId, scaled) : { style: scaled };
  return <Text {...rest} {...tag} />;
}

export { BIG_TEXT_SCALE, isBigText };
/** True at the largest text (14.2 item 2); the rule is isBigText in big-text.ts. */
export function useBigText(): boolean {
  return isBigText(useWindowDimensions().fontScale, useTextSize());
}
