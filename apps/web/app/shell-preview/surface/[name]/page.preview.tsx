// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only: each surface's frame with its live reads (API-10 for the clock, API-02 for the footer, nothing
// fixed), for the stack Playwright test of FR-DEMO-1 (the demo time in every surface header) and FR-DISP-20 (a Call
// control on a phone and on a computer). The office frames get a sample user; ?me=live makes them read API-07.
import { notFound } from 'next/navigation';
import { Surface, type SurfaceName } from './surfaces.tsx';

// Here, not in surfaces.tsx: a value a server component imports from a 'use client' module is a client reference.
const SURFACES: readonly string[] = ['office', 'admin', 'pbs', 'booking', 'public', 'tech'] satisfies SurfaceName[];

export const dynamic = 'force-dynamic';

export default async function SurfacePreview({ params, searchParams }: { params: Promise<{ name: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { name } = await params;
  if (!SURFACES.includes(name)) notFound();
  const q = await searchParams;
  return <Surface name={name as SurfaceName} liveMe={q.me === 'live'} slashOff={q.slash === 'off'} />;
}
