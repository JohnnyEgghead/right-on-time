// SPDX-License-Identifier: AGPL-3.0-or-later
// The demo clock page's state shapes and its idle values, in a module with no 'use client' so the preview routes (server components) can read them.
import type { ClockAnswer } from '../shell/clock.ts';
import type { Place, Preset } from './model.ts';

export type Part<T> = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: T };
export interface ClockState {
  clock: Part<ClockAnswer>;
  presets: Part<Preset[]>;
}
export interface ClockUi {
  date: string;
  time: string;
  /** The control whose call is running (Jump, a preset or Pause shows no busy look in the frame: the controls are off while it runs). */
  busy: Place | null;
  /** state Refused: the message by the control that was pressed. */
  refused: { place: Place; text: string } | null;
  dialog: boolean;
  resetting: boolean;
  dialogMessage: string | null;
  /** Preview: the dialog is drawn inside its tile. */
  inline?: boolean;
  /** The demo time the world was reset to, kept after a world reset event (CTL-CMP-02-03, EVT-06). */
  resetTo?: string | null;
}
export const IDLE_UI: ClockUi = { date: '2026-09-15', time: '18:05', busy: null, refused: null, dialog: false, resetting: false, dialogMessage: null };

