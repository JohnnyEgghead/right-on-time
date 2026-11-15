// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-GATE-01 in place of a page, loaded on demand: the gate's sheets (kit.unit-gate, DK-60 to DK-63) hold generic rules (.lead, .btn .ic,
// body.r1 width) that must not reach any other page, and a static import in the root layout would put them on every one. next/dynamic
// splits the screen and its sheets into a chunk that loads only for the request that renders it.
import dynamic from 'next/dynamic';

const AccessCodeScreen = dynamic(() => import('./AccessCodeScreen.tsx').then((m) => m.AccessCodeScreen));

export function GateLoader() {
  return <AccessCodeScreen />;
}
