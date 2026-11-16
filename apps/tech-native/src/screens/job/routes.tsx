// SPDX-License-Identifier: AGPL-3.0-or-later
// The job screens' places in the app's navigation (SD-47 Native app: a stack per tab, native sheets over them; nav.ts names them):
// Job and Finish job on Today's stack, Waiting to send on Me's, and the note, photo and status sheets on the root stack, over the tabs
// (the status sheet is the app's 1 confirm sheet, today/Sheets.tsx, which Today's card opens too).
// Tabs.tsx and App.tsx register these lists as they are; this file is the job screens' only entry into them.
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import type { ComponentType } from 'react';
import { FinishScreen } from './FinishScreen.tsx';
import { JobScreen } from './JobScreen.tsx';
import { NoteSheet } from './NoteSheet.tsx';
import { PhotoSheet } from './PhotoSheet.tsx';
import { StatusSheet } from '../today/Sheets.tsx';
import { WaitingScreen } from './WaitingScreen.tsx';
import { SHORT_DETENTS, TALL_DETENTS } from '../../ui/sheet-detents.ts';

export interface ScreenEntry { name: string; component: ComponentType; options?: NativeStackNavigationOptions }

/** The screens each tab's stack holds beside its root. */
export const TAB_SCREENS: Record<string, ScreenEntry[]> = {
  // Finish job holds the signature pad: a finger signing left to right is not the back swipe (iOS 26 pops from anywhere in the
  // content), so the screen leaves only by its Job button (CTL-TEC-07-10), which keeps the entries.
  Today: [{ name: 'Job', component: JobScreen }, { name: 'Finish', component: FinishScreen, options: { gestureEnabled: false, fullScreenGestureEnabled: false } }],
  Me: [{ name: 'Waiting', component: WaitingScreen }],
};

/** The tall sheets of DK-117 and the confirm sheet (.nsheet); their heights are ui/sheet-detents.ts's, which the status sheet reads too. */
const TALL: NativeStackNavigationOptions = { presentation: 'formSheet', sheetAllowedDetents: TALL_DETENTS, sheetGrabberVisible: true, sheetCornerRadius: 14 };
const SHORT: NativeStackNavigationOptions = { presentation: 'formSheet', sheetAllowedDetents: SHORT_DETENTS, sheetGrabberVisible: true, sheetCornerRadius: 14 };

/** The sheets on the root stack, over the tabs (signed in only). */
export const ROOT_SCREENS: ScreenEntry[] = [
  { name: 'JobNote', component: NoteSheet, options: TALL },
  { name: 'JobPhoto', component: PhotoSheet, options: TALL },
  { name: 'JobStatus', component: StatusSheet, options: SHORT },
];
