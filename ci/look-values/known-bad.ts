// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds the known-bad fixture: a copy of the office-board frame page with exactly
// 2 deliberate changes. Generated at run time so it cannot drift from the frame page.
import { readFileSync, writeFileSync } from 'node:fs';
import type { SelectorPair } from './compare.ts';

export const FRAME = 'mockups/pages/office-board.html';

/** Pairs that cover both planted defects. */
export const KNOWN_BAD_PAIRS: SelectorPair[] = [
  { app: '.btn.sm' },
  { app: '.btn.primary' },
  { app: '.topbar' },
];

const EDITS: { from: string; to: string }[] = [
  // padding: 0 10px -> 0 12px (+2 px) on .btn.sm
  { from: '.btn.sm { height: 30px; padding: 0 10px;', to: '.btn.sm { height: 30px; padding: 0 12px;' },
  // color: #ffffff -> #fefefe (1 step per channel) on .btn.primary
  { from: 'border-color: var(--teal-700); color: #fff; }', to: 'border-color: var(--teal-700); color: #fefefe; }' },
];

export function writeKnownBad(outFile: string, frame = FRAME): void {
  let html = readFileSync(frame, 'utf8');
  for (const e of EDITS) {
    if (html.split(e.from).length !== 2) throw new Error(`known-bad edit target not found exactly once: ${e.from}`);
    html = html.replace(e.from, e.to);
  }
  writeFileSync(outFile, html);
}
