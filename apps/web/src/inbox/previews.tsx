// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-INB-01 and SCR-CUS-06 in each state their frames show, with the frames' own data, for the harness build's preview routes
// (apps/web/app/shell-preview/inbox, reschedule). Client components, because the views take handlers and a server page cannot pass a
// function. Never read by a release route.
import { useState } from 'react';
import { ShellIntl } from '../shell/intl.tsx';
import { APP_INFO, CLOCK_RUNNING } from '../shell/preview-fixtures.ts';
import { InboxView, type InboxState } from './InboxView.tsx';
import { ENDED_PREVIEW, INBOX_DATA, LIVE_PREVIEW, MOVED, NO_OTHER_DATA, RESCHEDULE_DATA, type InboxPreviewName, type ReschedulePreviewName } from './preview-data.ts';
import { RescheduleView, type RescheduleState } from './RescheduleView.tsx';

const FIXED = { clock: CLOCK_RUNNING, appInfo: APP_INFO, fixed: true };
const STATE: Record<InboxPreviewName, InboxState> = {
  success: 'ready', loading: 'loading', empty: 'ready', nomobile: 'ready', textsoff: 'ready', sending: 'ready', notvalid: 'not_valid', error: 'error',
  ended: 'ready', notsent: 'ready', newtext: 'ready', spanish: 'ready', late: 'ready',
};

export function InboxPreview({ name }: { name: InboxPreviewName }) {
  const [draft, setDraft] = useState('');
  const view = (
    <InboxView
      {...FIXED} state={STATE[name]} data={INBOX_DATA[name]} draft={draft} onDraft={setDraft}
      busy={name === 'sending' ? 'c' : null} failed={name === 'notsent' ? { body: 'C' } : null} newText={name === 'newtext'}
      preview={async () => (name === 'ended' ? ENDED_PREVIEW : LIVE_PREVIEW)}
    />
  );
  // DK-127: the Spanish frame's page is the same screen in Spanish; the preview route forces the language (the walkers run both on every route).
  return name === 'spanish' ? <ShellIntl lang="es">{view}</ShellIntl> : view;
}

const RSTATE: Record<ReschedulePreviewName, RescheduleState> = {
  choosing: 'choosing', loading: 'loading', noother: 'choosing', saving: 'saving', changed: 'changed', kept: 'kept', ended: 'ended', notvalid: 'not_valid', filled: 'choosing',
};

export function ReschedulePreview({ name }: { name: ReschedulePreviewName }) {
  const [day, setDay] = useState<string | null>(name === 'choosing' || name === 'saving' || name === 'filled' ? '2026-10-21' : null);
  const [win, setWin] = useState<string | null>(name === 'choosing' || name === 'saving' ? 'b10' : null);
  return (
    <RescheduleView
      {...FIXED} state={RSTATE[name]} data={name === 'noother' ? NO_OTHER_DATA : name === 'loading' || name === 'ended' || name === 'notvalid' ? null : RESCHEDULE_DATA}
      phone="(614) 555-0100" pickedDay={day} pickedWindow={win} onPickDay={(d) => { setDay(d); setWin(null); }} onPickWindow={setWin}
      moved={name === 'changed' ? MOVED : null} filled={name === 'filled' ? new Set(['b14']) : new Set()} notice={name === 'filled' ? 'window_full' : null}
    />
  );
}
