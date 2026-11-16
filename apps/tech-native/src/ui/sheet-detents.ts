// SPDX-License-Identifier: AGPL-3.0-or-later
// The native sheets' heights (DK-117), in 1 place: the routes that open the sheets (screens/job/routes.tsx) and a sheet that changes its
// own height while it is up (today/Sheets.tsx at the largest text) read the same values, so a sheet going back to its route's height goes
// back to the height the route opened it at (F-1733: the status sheet went back to a fixed 0.32 that was not its route's, and the On my
// way sheet's Cancel button sat under the bottom of the screen).
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';

type Detents = NonNullable<NativeStackNavigationOptions['sheetAllowedDetents']>;

/** The tall sheets of DK-117 (.nsheet.tall: from 64 pt under the top of an 844 pt screen). */
export const TALL_DETENTS: Detents = [0.92];
/** The confirm sheet (.nsheet) is as tall as its content: Today's On my way sheet adds the arrival line and the text preview. */
export const SHORT_DETENTS: Detents = 'fitToContents';
