// SPDX-License-Identifier: AGPL-3.0-or-later
// The kit sheet, cut at its DK anchors (UI-DESIGN-KIT 0.1: "unit sections (DK-49 to DK-68) load only on their unit's
// pages"). styles/kit/kit.css stays the byte-identical copy of docs/design/kit.css; the slices are byte ranges of it,
// never edited and never re-derived: every page loads the shared slice (the file head with its @import of the tokens,
// and DK-7 to DK-48); a unit's pages also load that unit's slice. The native unit (DK-49 to DK-59) is the iPhone app's
// look and has no web slice. The slices sit beside kit.css, so its relative @import and font url resolve unchanged.
//   node apps/web/src/kit-slices.ts         write the slices from styles/kit/kit.css
//   node apps/web/src/kit-slices.ts check   exit 1 when a committed slice differs from its cut
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const KIT_DIR = path.resolve(import.meta.dirname, '../styles/kit');

// 1 slice per mockup source file (UI-DESIGN-KIT 1.1), because each frame page loads its own set of those files, in
// kit order: the shared pages base, r1-common and r1-shr; the office pages base, office, r1-common and r1-office (and
// options or r1-single); the phone pages base, phone and r1-common (src/shell/css/*.ts hold each surface's set).
export const SLICES = [
  { file: 'kit.base.css', from: 0, to: 13 }, // from 0: the head before DK-7 (title comment, @import of the tokens)
  { file: 'kit.office.css', from: 14, to: 18 },
  { file: 'kit.phone.css', from: 19, to: 19 },
  { file: 'kit.options.css', from: 20, to: 21 },
  { file: 'kit.r1-common.css', from: 22, to: 38 },
  { file: 'kit.r1-office.css', from: 39, to: 46 },
  { file: 'kit.r1-single.css', from: 47, to: 47 },
  { file: 'kit.r1-shr.css', from: 48, to: 48 },
  { file: 'kit.unit-gate.css', from: 60, to: 63 },
  { file: 'kit.unit-pbs.css', from: 64, to: 65 },
  { file: 'kit.unit-booking.css', from: 66, to: 68 },
] as const;

export const NATIVE_ONLY = { from: 49, to: 59 };

const ANCHOR = /^\/\* ---------- DK-(\d+) /gm;

/** The byte offset where each DK section starts, in file order. */
export function anchors(kit: string): { dk: number; at: number }[] {
  return [...kit.matchAll(ANCHOR)].map((m) => ({ dk: Number(m[1]), at: m.index }));
}

export function cut(kit: string, from: number, to: number): string {
  const a = anchors(kit);
  const start = from === 0 ? 0 : a.find((x) => x.dk === from)?.at;
  const after = a.find((x) => x.dk > to)?.at ?? kit.length;
  if (start === undefined) throw new Error(`kit-slices: no DK-${from} anchor in kit.css`);
  return kit.slice(start, after);
}

export function slices(kit: string): Record<string, string> {
  return Object.fromEntries(SLICES.map((s) => [s.file, cut(kit, s.from, s.to)]));
}

if (import.meta.main) {
  const kit = readFileSync(path.join(KIT_DIR, 'kit.css'), 'utf8');
  const want = slices(kit);
  if (process.argv[2] === 'check') {
    const bad = Object.entries(want).filter(([f, text]) => readFileSync(path.join(KIT_DIR, f), 'utf8') !== text);
    for (const [f] of bad) console.error(`kit-slices: ${f} differs from its cut of kit.css (run node apps/web/src/kit-slices.ts)`);
    process.exit(bad.length ? 1 : 0);
  }
  for (const [f, text] of Object.entries(want)) writeFileSync(path.join(KIT_DIR, f), text);
  console.log(`kit-slices: wrote ${Object.keys(want).join(', ')}`);
}
