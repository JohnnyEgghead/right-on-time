// SPDX-License-Identifier: AGPL-3.0-or-later
// The flat drawings of the 5 booking site pages (DK-122, option C: "Each of the 5 pages gets its own drawing"), as the frame draws them in brand
// colors: the house of Comfort Club (house()) and the flame, snowflake, drop and home of the other 4 (art()). Decorative, so hidden from
// screen readers. Fixed constants, 520 by 520 as the frame draws them; the page's sheet sizes the box.
import type { ReactNode } from 'react';
import type { MenuArt } from './model.ts';

const HOUSE = (
  <>
    <circle cx="260" cy="270" r="230" fill="#e2f2f6" />
    <path d="M90 250 L260 110 L430 250" fill="none" stroke="#0f5e73" strokeWidth="16" strokeLinejoin="round" strokeLinecap="round" />
    <rect x="120" y="240" width="280" height="200" rx="10" fill="#fff" stroke="#0f5e73" strokeWidth="8" />
    <rect x="150" y="300" width="88" height="110" rx="8" fill="#fdebdc" stroke="#c1550d" strokeWidth="6" />
    <path d="M194 386c-14 0-22-9-22-21 0-14 13-20 15-32 9 6 14 14 13 22 4-3 6-8 6-12 6 6 10 13 10 21 0 13-9 22-22 22z" fill="#f07a26" />
    <rect x="282" y="300" width="88" height="110" rx="8" fill="#e2f2f6" stroke="#12738b" strokeWidth="6" />
    <path d="M326 322v66M300 340l52 30M300 370l52-30" stroke="#12738b" strokeWidth="6" strokeLinecap="round" />
    <circle cx="420" cy="140" r="44" fill="#f07a26" />
    <path d="M402 140l12 12 24-26" fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
  </>
);

const SHAPES: Record<Exclude<MenuArt, 'house'>, ReactNode> = {
  flame: (
    <>
      <circle cx="260" cy="270" r="230" fill="#e2f2f6" />
      <path d="M260 400c-56 0-92-38-92-88 0-58 54-84 62-134 38 26 58 60 54 92 16-12 24-32 24-50 26 26 44 56 44 92 0 52-38 88-92 88z" fill="#f07a26" />
      <path d="M262 400c-26 0-42-18-42-40 0-26 24-38 28-60 18 12 26 28 24 42 8-6 12-14 12-22 12 12 20 26 20 42 0 22-18 38-42 38z" fill="#fdebdc" />
    </>
  ),
  snow: (
    <>
      <circle cx="260" cy="270" r="230" fill="#e2f2f6" />
      <g stroke="#12738b" strokeWidth="16" strokeLinecap="round">
        <path d="M260 140v260M148 205l224 130M148 335l224-130" />
        <path d="M230 160l30 24 30-24M230 380l30-24 30 24" />
      </g>
    </>
  ),
  drop: (
    <>
      <circle cx="260" cy="270" r="230" fill="#e2f2f6" />
      <path d="M260 120c0 0-110 120-110 190 0 62 48 106 110 106s110-44 110-106c0-70-110-190-110-190z" fill="#12738b" />
      <path d="M214 320c0 28 20 50 46 54" fill="none" stroke="#e2f2f6" strokeWidth="12" strokeLinecap="round" />
    </>
  ),
  home: (
    <>
      <circle cx="260" cy="270" r="230" fill="#e2f2f6" />
      <path d="M110 270 L260 150 L410 270" fill="none" stroke="#0f5e73" strokeWidth="16" strokeLinejoin="round" strokeLinecap="round" />
      <rect x="140" y="260" width="240" height="160" rx="10" fill="#fff" stroke="#0f5e73" strokeWidth="8" />
      <rect x="236" y="330" width="48" height="90" rx="6" fill="#f07a26" />
    </>
  ),
};

export function Art({ art }: { art: MenuArt }) {
  return (
    <svg viewBox="0 0 520 520" aria-hidden="true">
      {art === 'house' ? HOUSE : SHAPES[art]}
    </svg>
  );
}
