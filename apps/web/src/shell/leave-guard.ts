// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The one leave guard of an office screen (CTL-OFC-12-06, CTL-OFC-04-10, CTL-OFC-04-12; F-752): a page with unsaved typing arms it with the
// words it asks, and every path off the page asks through confirmLeave: the page's own tabs, the top bar's branch choice and its
// "see all" links. A full page load (a plain link, a reload, closing the tab) is the browser's own ask through beforeunload.
import { useEffect } from 'react';

let armed: string | null = null;

/** Arms the guard until the returned function is called; the last armed words win. Exported apart from the hook for the tests. */
export function armLeaveGuard(words: string): () => void {
  armed = words;
  const warn = (e: BeforeUnloadEvent) => {
    e.preventDefault();
  };
  window.addEventListener('beforeunload', warn);
  return () => {
    window.removeEventListener('beforeunload', warn);
    if (armed === words) armed = null;
  };
}

/** True when the person may leave: nothing is armed, or they chose to leave without saving. */
export function confirmLeave(): boolean {
  return armed === null || window.confirm(armed);
}

/** A page with unsaved typing passes the words to ask ("Leave without saving?"), or null when nothing is unsaved. */
export function useLeaveGuard(words: string | null): void {
  useEffect(() => (words === null ? undefined : armLeaveGuard(words)), [words]);
}
