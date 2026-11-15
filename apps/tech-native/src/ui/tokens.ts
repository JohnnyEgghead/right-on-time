// SPDX-License-Identifier: AGPL-3.0-or-later
// The kit values the native shell draws with (DK-117 mockups/pages/r1-ios-b.html, option B; DK-50, DK-53, DK-54, DK-56, DK-57,
// DK-59 in docs/design/kit.css), each copied from the frame's computed value (light theme only, kit section 3.4). The look values
// comparator (ci/look-values/native-compare.ts) reads the drawn views back and compares them with the frames; no value here is a
// contrast pick (OA-84).
import type { TextStyle } from 'react-native';
import { inter, type FontWeight } from './fonts.ts';

export const color = {
  white: '#ffffff',
  screen: '#f2f4f6',
  ink900: '#111827',
  ink800: '#1f2937',
  ink600: '#4b5563',
  ink500: '#616774',
  ink400: '#838c9b',
  ink300: '#d1d5db',
  ink200: '#e5e7eb',
  teal900: '#0a3a48',
  teal800: '#0c4b5d',
  teal700: '#0f5e73',
  teal600: '#12738b',
  teal100: '#e2f2f6',
  orange500: '#f07a26',
  orange300: '#f9b47f',
  okBg: '#d9f3e3',
  okLine: '#1f9d55',
  okText: '#13633a',
  badBg: '#fde1e1',
  badLine: '#d42f2f',
  badText: '#9b1c1c',
} as const;

/** A text style: Inter at a CSS weight, a size and a line height, in px (iOS points). */
export const type = (weight: FontWeight, size: number, lineHeight: number, fg: string): TextStyle => ({
  fontFamily: inter(weight), fontSize: size, lineHeight, color: fg,
});
