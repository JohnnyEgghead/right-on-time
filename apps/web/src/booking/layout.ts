// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Which layout the booking pages draw: the phone's below PHONE_MAX_WIDTH, the computer's above (FR-BOOK-4).
import { useEffect, useState } from 'react';
import { PHONE_MAX_WIDTH } from './model.ts';

/** The phone layout is chosen by the viewport's width, once mounted (the first paint is the wide one). */
export function useLayout(): 'wide' | 'phone' {
  const [layout, setLayout] = useState<'wide' | 'phone'>('wide');
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH}px)`);
    const set = () => setLayout(mq.matches ? 'phone' : 'wide');
    set();
    mq.addEventListener('change', set);
    return () => mq.removeEventListener('change', set);
  }, []);
  return layout;
}
