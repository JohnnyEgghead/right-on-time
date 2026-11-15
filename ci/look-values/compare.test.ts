// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: tooling
import { describe, expect, it } from 'vitest';
import { BOX_TOLERANCE_PX, compareLook, normalizeText, PROPERTIES, textsDiffer, valuesDiffer } from './compare.ts';

// Browser-free: stays in the merge set (the unit-tests gate). The browser tests are compare.pw.test.ts.
describe('PROPERTIES', () => {
  it('covers each of the 10 briefed families, and a background image as well as a background color', () => {
    // reason: F-33; the briefed families are font, size, weight, line height, color, background, border, padding, gap, box size
    const has = (re: RegExp) => PROPERTIES.filter((p) => re.test(p));
    expect(has(/^font-family$/)).toHaveLength(1);
    expect(has(/^font-size$/)).toHaveLength(1);
    expect(has(/^font-weight$/)).toHaveLength(1);
    expect(has(/^line-height$/)).toHaveLength(1);
    expect(has(/^color$/)).toHaveLength(1);
    expect(has(/^background-color$/)).toHaveLength(1);
    expect(has(/^background-image$/)).toHaveLength(1);
    expect(has(/^border-(top|right|bottom|left)-(width|style|color)$/)).toHaveLength(12);
    expect(has(/^padding-(top|right|bottom|left)$/)).toHaveLength(4);
    expect(has(/^(row|column)-gap$/)).toHaveLength(2);
    expect(has(/^(width|height)$/)).toHaveLength(2);
    // nothing outside the families
    expect(PROPERTIES).toHaveLength(1 + 1 + 1 + 1 + 1 + 2 + 12 + 4 + 2 + 2);
  });
});

describe('compareLook', () => {
  it('refuses an empty pair list instead of reporting PASS for nothing', async () => {
    // reason: F-34; the API later UI tasks import must not pass a comparison that compared nothing
    await expect(compareLook({ appUrl: 'file:///x.html', framePath: 'x.html', pairs: [] })).rejects.toThrow(/pairs is empty/);
  });
});

describe('valuesDiffer (box tolerance, owner ruling ea38f588, F-482)', () => {
  it('passes a 0.4 px gap in width and height', () => {
    expect(valuesDiffer('width', '100px', '100.4px')).toBe(false);
    expect(valuesDiffer('height', '20.4px', '20px')).toBe(false);
  });
  it('still flags a 0.6 px gap', () => {
    expect(BOX_TOLERANCE_PX).toBe(0.5);
    expect(valuesDiffer('width', '100px', '100.6px')).toBe(true);
    expect(valuesDiffer('height', '20.6px', '20px')).toBe(true);
  });
  it('passes a gap across the old 0.01 rounding step (the WebKit label sizes)', () => {
    expect(valuesDiffer('width', '13.734px', '13.736px')).toBe(false);
    expect(valuesDiffer('width', '13.7325439453125px', '13.735107421875px')).toBe(false);
    expect(valuesDiffer('height', '10.014060974121094px', '10.01593017578125px')).toBe(false);
  });
  it('flags the planted +2 px size change', () => {
    expect(valuesDiffer('width', '60px', '62px')).toBe(true);
  });
  it('keeps every other property an exact comparison', () => {
    expect(valuesDiffer('padding-left', '10px', '10.1px')).toBe(true);
    expect(valuesDiffer('color', 'rgb(255, 255, 255)', 'rgb(254, 254, 254)')).toBe(true);
    expect(valuesDiffer('font-size', '14.62px', '14.62px')).toBe(false);
  });
});

describe('textsDiffer (F-1347)', () => {
  it('flags the F-1345 extra zone words', () => {
    // why: F-1347 "10 AM-12 PM EDT" against the frame's "10 AM-12 PM" compared equal on Chromium; the words must now differ
    expect(textsDiffer('10 AM-12 PM EDT', '10 AM-12 PM')).toBe(true);
  });
  it('ignores only whitespace runs and the ends', () => {
    expect(normalizeText('  10 AM-12 PM \n  Scheduled ')).toBe('10 AM-12 PM Scheduled');
    expect(textsDiffer('10 AM-12 PM\n  Scheduled', '10 AM-12 PM Scheduled')).toBe(false);
    expect(textsDiffer('aaaa', 'aaab')).toBe(true);
  });
});
