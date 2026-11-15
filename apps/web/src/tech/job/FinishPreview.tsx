// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Harness build only: SCR-TEC-07 Finish job in each state its frames show (DK-112), on fixed data (preview-fixtures.ts), for the look comparator and the
// page walkers. Never a release route.
import type { FINISH_PREVIEWS } from '../preview-names.ts';
import { CLOCK_RUNNING } from '../../shell/preview-fixtures.ts';
import { FinishScreen, type FinishScreenProps } from './FinishScreen.tsx';
import { registerPreviewFiles } from './files.ts';
import { FINISH, ON_SITE_NOTES, OUT, PARTS, PREVIEW_FILES } from './preview-fixtures.ts';

registerPreviewFiles(PREVIEW_FILES);
registerPreviewFiles(new Map([['00000000-0000-4000-8000-0000000000a4', PREVIEW_FILES.get('00000000-0000-4000-8000-0000000000a2')!]]));

const view = { kind: 'job' as const, job: ON_SITE_NOTES, fromPhone: false };
const NOW = Date.parse('2026-09-15T16:50:00Z');
const S: Record<(typeof FINISH_PREVIEWS)[number], NonNullable<FinishScreenProps['fixed']>> = {
  signed: { view, draft: FINISH.signed, parts: PARTS, demoNowMs: NOW },
  editing: { view, draft: FINISH.editing, parts: PARTS, demoNowMs: NOW, focusLine: 1 },
  'no-parts-list': { view, outbox: { ...OUT.synced, online: false }, draft: FINISH.empty, parts: null, find: 'filter', demoNowMs: NOW },
  invalid: { view, draft: FINISH.empty, parts: PARTS, msg: 'parts', demoNowMs: NOW },
  confirming: { view, draft: FINISH.confirming, parts: PARTS, confirming: true, demoNowMs: NOW },
  restored: { view, draft: FINISH.restored, parts: PARTS, restored: true, demoNowMs: NOW },
};

export function FinishPreview({ name }: { name: (typeof FINISH_PREVIEWS)[number] }) {
  return <FinishScreen jobNumber={24830} fixed={{ clock: { ...CLOCK_RUNNING, demoNow: '2026-09-15T12:50:00-04:00[America/New_York]' }, mini: name !== 'signed', ...S[name] }} />;
}
