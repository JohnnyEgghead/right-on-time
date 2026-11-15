// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// UI-SPECIFICATION 14.1 item 2 (NFR-06): a modal dialog or sheet keeps Tab inside while it is open, closes on Escape (when it can) and
// returns focus to the control that opened it. Dialogs that already move focus in on open use this for the Tab trap and the return;
// those without Escape pass onEscape. Focus moves in on open only when it is not already inside.
import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * The index Tab or Shift+Tab lands on inside a ring of `count` stops (-1 for an empty ring: keep focus where it is). The ring always
 * moves focus itself: Safari's Tab skips buttons by default, so leaving the move to the browser would step over them and out of the dialog.
 */
export function trapTarget(count: number, at: number, shift: boolean): number {
  if (count === 0) return -1;
  if (at < 0) return shift ? count - 1 : 0; // focus is outside the ring: pull it in
  return (at + (shift ? -1 : 1) + count) % count;
}

/** A drawn control that has not opted out of the Tab order: tabindex -1 on a link, button or field is no stop (F-1476; the selector's :not covers only [tabindex]). */
export const isTabStop = (e: { tabIndex: number; getClientRects(): { length: number } }): boolean => e.tabIndex >= 0 && e.getClientRects().length > 0;

/** Where focus goes when a dialog closes: the opener if it is still on the page and outside the dialog, else the stable fallback, else nowhere (never the body). */
export function returnTarget<T extends { isConnected: boolean }>(
  opener: T | null | undefined, fallback: T | null | undefined, body: unknown, inside: (e: T) => boolean,
): T | null {
  const usable = (e: T | null | undefined): e is T => Boolean(e && e.isConnected && e !== body && !inside(e));
  if (usable(opener)) return opener;
  return usable(fallback) ? fallback : null;
}

// WebKit never focuses a button on a click or tap, so document.activeElement is the body when a pointer-opened dialog mounts (F-1479). The
// control last pressed by pointer stands in as the opener then; any key press clears it, so a keyboard-opened dialog reads its focused opener.
let pressed: HTMLElement | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    pressed = e.target instanceof Element ? e.target.closest<HTMLElement>('button,a[href],input,select,textarea,summary,[tabindex]') : null;
  }, true);
  document.addEventListener('keydown', () => { pressed = null; }, true);
}

export function useModalFocus(root: RefObject<HTMLElement | null>, opts: { onEscape?: () => void; active?: boolean; returnTo?: RefObject<HTMLElement | null> } = {}) {
  const { onEscape, active = true, returnTo } = opts;
  const esc = useRef(onEscape);
  esc.current = onEscape;
  // The opener is read while rendering, before the commit moves focus in (autoFocus is applied at commit, ahead of any effect).
  // returnTo is the stable target for a dialog whose opener is gone when it closes (Finish unmounts its button during the confirm step).
  const opened = useRef<HTMLElement | null>(null);
  if (!active) opened.current = null;
  else if (!opened.current && typeof document !== 'undefined') {
    const focused = document.activeElement as HTMLElement | null;
    opened.current = focused && focused !== document.body ? focused : pressed;
  }
  useEffect(() => {
    if (!active) return undefined;
    const el = root.current;
    const opener = opened.current;
    const stops = () => Array.from(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(isTabStop);
    if (root.current && !root.current.contains(document.activeElement)) stops()[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && esc.current) {
        esc.current();
      } else if (e.key === 'Tab') {
        const list = stops();
        const to = trapTarget(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey);
        e.preventDefault();
        if (to >= 0) list[to]?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      returnTarget(opener, returnTo?.current, document.body, (e) => Boolean(el?.contains(e)))?.focus();
    };
  }, [root, active, returnTo]);
}
