// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Harness build only (the shell-preview route tech-frame): the Today shell with CMP-09 and the header's CMP-10 waiting count
// (DK-107), on the success and the offline, saved states, in its own module so the route loads only DK-107's page sheet.
import type { FRAME_PREVIEWS } from './preview-names.ts';
import { TodayPreview } from './today/TodayPreview.tsx';

export function FramePreview({ name }: { name: (typeof FRAME_PREVIEWS)[number] }) {
  return <TodayPreview name={name === 'today' ? 'success' : 'offline-saved'} />;
}
