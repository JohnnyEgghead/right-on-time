// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Harness build only: SCR-TEC-04 Job and the SCR-TEC-06 Add photo sheet in each state its frames show (DK-110), on fixed data (preview-fixtures.ts), for the look comparator and the
// page walkers. Never a release route.
import type { JOB_PREVIEWS } from '../preview-names.ts';
import { CLOCK_RUNNING } from '../../shell/preview-fixtures.ts';
import { JobScreen, type JobScreenProps } from './JobScreen.tsx';
import { registerPreviewFiles } from './files.ts';
import { CANCELED, DONE, HAROLD, NO_ONE_HOME, ON_SITE, OUT, PREVIEW_FILES, W_PHOTO } from './preview-fixtures.ts';

registerPreviewFiles(PREVIEW_FILES);
registerPreviewFiles(new Map([[W_PHOTO.key, PREVIEW_FILES.get('00000000-0000-4000-8000-0000000000a3')!]]));

const S: Record<(typeof JOB_PREVIEWS)[number], { fixed: NonNullable<JobScreenProps['fixed']>; photo?: boolean }> = {
  success: { fixed: { view: { kind: 'job', job: HAROLD, fromPhone: false }, minutes: 12, clock: { ...CLOCK_RUNNING, demoNow: '2026-09-15T10:27:00-04:00[America/New_York]' } } },
  loading: { fixed: { view: { kind: 'loading' } } },
  offline: { fixed: { view: { kind: 'job', job: HAROLD, fromPhone: true }, outbox: OUT.offline1, me: 'Maria Santos' } },
  'not-on-phone': { fixed: { view: { kind: 'not_on_phone' }, outbox: { ...OUT.synced, online: false } } },
  'not-yours': { fixed: { view: { kind: 'not_yours' } } },
  done: { fixed: { view: { kind: 'job', job: DONE, fromPhone: false } } },
  'no-one-home': { fixed: { view: { kind: 'job', job: NO_ONE_HOME, fromPhone: false } } },
  canceled: { fixed: { view: { kind: 'job', job: CANCELED, fromPhone: false } } },
  'on-site': { fixed: { view: { kind: 'job', job: ON_SITE, fromPhone: false }, minutes: 11 } },
  menu: { fixed: { view: { kind: 'job', job: HAROLD, fromPhone: false }, menu: true, minutes: 12 } },
  viewer: { fixed: { view: { kind: 'job', job: HAROLD, fromPhone: false }, viewer: '00000000-0000-4000-8000-0000000000a3', minutes: 11 } },
  'photo-none': { photo: true, fixed: { view: { kind: 'job', job: HAROLD, fromPhone: false }, sheet: 'none' } },
  'photo-preview': { photo: true, fixed: { view: { kind: 'job', job: HAROLD, fromPhone: false }, sheet: 'preview' } },
  'photo-saved': { fixed: { view: { kind: 'job', job: HAROLD, fromPhone: false }, outbox: { ...OUT.synced, waiting: [W_PHOTO] }, me: 'Maria Santos', minutes: 11, photoSaved: true } },
  finished: { fixed: { view: { kind: 'job', job: ON_SITE, fromPhone: false }, outbox: { ...OUT.synced, waiting: [{ ...W_PHOTO, kind: 'finished', payload: { parts: [], noPartsUsed: true, laborMinutes: 129, workDone: [] }, demoTime: '2026-09-15T12:50:00-04:00[America/New_York]' } as never] }, finished: true, clock: { ...CLOCK_RUNNING, demoNow: '2026-09-15T12:50:00-04:00[America/New_York]' } } },
};

export function JobPreview({ name }: { name: (typeof JOB_PREVIEWS)[number] }) {
  const s = S[name];
  // DK-110 Offline, not saved draws another job (#24871), one never opened on this phone.
  return <JobScreen jobNumber={name === 'not-on-phone' ? 24871 : 24830} photo={s.photo ?? false} fixed={{ clock: CLOCK_RUNNING, mini: name !== 'success', ...s.fixed }} />;
}
