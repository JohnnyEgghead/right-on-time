// SPDX-License-Identifier: AGPL-3.0-or-later
// The rule for the largest text sizes (kept free of react-native so a unit test can load it).
import { TEXT_PERCENT, type TextSize } from '../screens/mapme/model.ts';

/**
 * True when the phone's own text size (Settings, Display, Text Size, with Larger Accessibility Sizes) makes text much larger than the frames
 * draw it (14.2 item 2): screens then let their top part scroll with the rest, stack side-by-side rows and let text wrap. At the default size
 * and the next few steps it is false and every screen is drawn exactly as the frames draw it.
 */
export const BIG_TEXT_SCALE = 1.3;

/** The rule: the phone's text scale times the in-app Text size share (the Me screen's setting scales on top of it, 14.2 item 2) reaches BIG_TEXT_SCALE. */
export const isBigText = (fontScale: number, size: TextSize): boolean => fontScale * (TEXT_PERCENT[size] / 100) >= BIG_TEXT_SCALE;
