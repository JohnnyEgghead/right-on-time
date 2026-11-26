// SPDX-License-Identifier: AGPL-3.0-or-later
// The values the Today stack, its confirm sheets and the sign-in screen draw with beyond the shell's kit (ui/tokens.ts), each copied from
// the frame's computed value in DK-117 (mockups/pages/r1-ios-b.html, light theme): the job status colors (--st-*), the orange and teal
// steps the next job card uses. No value here is a contrast pick (OA-84).
export const tone = {
  ink700: '#374151',
  ink150: '#eceef1',
  ink100: '#f3f4f6',
  teal200: '#b9e0e9',
  teal50: '#f1f8fa',
  orange700: '#b4480c',
  orange600: '#c1550d',
  orange100: '#fdebdc',
  orange50: '#fff6ee',
  schedBorder: '#b8c2cc',
  schedInk: '#334155',
  wayBg: '#dbe8fe',
  wayInk: '#1745a8',
  riskBg: '#fff1cf',
  riskLine: '#d48806',
  riskInk: '#7a4a00',
  syncDot: '#86efac',
  glass: 'rgba(255, 255, 255, 0.12)',
  glassLine: 'rgba(255, 255, 255, 0.22)',
  glassTrack: 'rgba(255, 255, 255, 0.18)',
} as const;
