// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Harness build only (the shell-preview routes tech-today and tech-frame): the Today screen on one of the frame's states, fixed
// (preview-data.ts), in its own module so the route loads only DK-107's page sheet.
import { APP_INFO } from '../../shell/preview-fixtures.ts';
import { TodayShell } from '../TodayShell.tsx';
import { previewState, type TodayPreviewName } from './preview-data.ts';

export function TodayPreview({ name }: { name: TodayPreviewName }) {
  const s = previewState(name);
  return (
    <TodayShell
      day={s.day} jobs={s.jobs} loading={s.loading} online={s.online} savedAt={s.savedAt} failed={s.failed} notice={s.notice} driveMinutes={s.driveMinutes}
      fixed={s.fixed} clock={s.clock} sheet={s.sheet} info={APP_INFO} mini={s.mini} newDay={s.newDay}
    />
  );
}
