// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1688 (useBigText ignored the in-app Text size, so Larger on a phone at 1.1 drew big text with the standard layout)
import { describe, expect, it } from 'vitest';
import { historyScrollY } from '../screens/job/model.ts';
import { BIG_TEXT_SCALE, isBigText } from './big-text.ts';

describe('isBigText (14.2 item 2: the phone scale times the Text size share)', () => {
  it('is the phone scale alone at Standard', () => {
    expect(isBigText(1.29, 'standard')).toBe(false);
    expect(isBigText(BIG_TEXT_SCALE, 'standard')).toBe(true);
  });
  it('multiplies by the Large and Larger shares', () => {
    expect(isBigText(1.2, 'large')).toBe(true); // 1.35
    expect(isBigText(1.1, 'larger')).toBe(true); // 1.375
    expect(isBigText(1.1, 'large')).toBe(false); // 1.2375
    expect(isBigText(1, 'larger')).toBe(false); // 1.25
  });
});

describe('historyScrollY (F-1688)', () => {
  it('adds the body offset in the outer scroll to the heading offset in the body', () => {
    expect(historyScrollY(180, 420)).toBe(600);
    expect(historyScrollY(0, 420)).toBe(420);
  });
  it('waits until both are laid out', () => {
    expect(historyScrollY(null, 420)).toBeNull();
    expect(historyScrollY(180, null)).toBeNull();
  });
});
