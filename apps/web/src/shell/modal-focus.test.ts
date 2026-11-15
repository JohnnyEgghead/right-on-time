// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { isTabStop, returnTarget, trapTarget } from './modal-focus.ts';

describe('trapTarget', () => {
  // why: NFR-06 Tab at the last stop of a modal goes to the first, Shift+Tab at the first goes to the last, so focus never leaves the dialog
  it('wraps at both ends of the ring', () => {
    expect(trapTarget(3, 2, false)).toBe(0);
    expect(trapTarget(3, 0, true)).toBe(2);
  });
  // why: NFR-06 inside the ring every Tab is the dialog's own move (Safari's Tab skips buttons, so the browser's move could leave the dialog)
  it('moves 1 stop at a time inside the ring', () => {
    expect(trapTarget(3, 1, false)).toBe(2);
    expect(trapTarget(3, 1, true)).toBe(0);
  });
  // why: NFR-06 focus that is outside the dialog is pulled in, and an empty dialog keeps focus where it is
  it('pulls focus in from outside and holds an empty ring', () => {
    expect(trapTarget(3, -1, false)).toBe(0);
    expect(trapTarget(3, -1, true)).toBe(2);
    expect(trapTarget(0, -1, false)).toBe(-1);
  });
});

describe('returnTarget', () => {
  const el = (isConnected = true) => ({ isConnected });
  const body = el();
  const none = () => false;
  // why: UI-SPECIFICATION 14.1 item 2 focus goes back to the control that opened the dialog when that control is still on the page
  it('returns the opener while it is on the page', () => {
    const opener = el();
    expect(returnTarget(opener, el(), body, none)).toBe(opener);
  });
  // why: UI-SPECIFICATION 14.1 item 2 the Finish button is unmounted while its confirm step is up, so focus goes to the stable target, never the body
  it('falls back to the stable target when the opener is gone, the body or inside the dialog', () => {
    const fallback = el();
    expect(returnTarget(el(false), fallback, body, none)).toBe(fallback);
    expect(returnTarget(body, fallback, body, none)).toBe(fallback);
    const own = el();
    expect(returnTarget(own, fallback, body, (e) => e === own)).toBe(fallback);
    expect(returnTarget(null, fallback, body, none)).toBe(fallback);
  });
  // why: UI-SPECIFICATION 14.1 item 2 with no usable opener and no stable target focus is left alone, not thrown to the body
  it('returns nothing when neither target is usable', () => {
    expect(returnTarget(null, el(false), body, none)).toBeNull();
    expect(returnTarget(body, undefined, body, none)).toBeNull();
  });
});

describe('isTabStop', () => {
  const el = (tabIndex: number, rects: number) => ({ tabIndex, getClientRects: () => ({ length: rects }) });
  // why: F-1476 a link or button that opted out with tabindex -1 must not become a Tab stop inside a trapped dialog, and a control that is not drawn is none either
  it('admits a drawn control in the Tab order and refuses tabindex -1 and an undrawn one', () => {
    expect(isTabStop(el(0, 1))).toBe(true);
    expect(isTabStop(el(2, 1))).toBe(true);
    expect(isTabStop(el(-1, 1))).toBe(false);
    expect(isTabStop(el(0, 0))).toBe(false);
  });
});
