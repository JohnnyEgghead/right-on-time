// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-19 on the job's own dialogs (UI-SPECIFICATION SCR-OFC-19; FR-DISP-6, UD-6). A dialog sends the version it opened on, never a
// live re-read's (F-697), so version_conflict means another person really changed the job: SCR-OFC-19 replaces the dialog, names who,
// what and when, and its Anyway repeats the same call against the answer's currentVersion. The state lives in the dialog, so it behaves
// the same on every page that hosts one: the job page, the billing list (correction) and the call list (reschedule).
//
// Re-runs. Each send is 1 compare-and-write on the server; nothing is sent without a press. Anyway moves the version this dialog accepts
// to the answer's currentVersion, so a refusal that returns to the form (window_full, offline) and a later press send that version, not
// the one it opened on. An Anyway whose answer was lost and that did land comes back as a conflict naming the person who pressed it,
// and changes nothing.
import { useState, type ReactNode } from 'react';
import type { MessageKey } from '@bw/i18n';
import { conflictOf } from '../board/api.ts';
import { ConflictDialog } from '../board/Dialogs.tsx';
import { conflictWords, type Conflict } from '../board/model.ts';
import { useT } from '../shell/intl.tsx';
import type { Answer } from './api.ts';
import type { Refusal } from './model.ts';

type ConflictAction = 'reassign' | 'reschedule' | 'cancel' | 'finish' | 'correct' | 'edit';

/** What the busy primary says while Anyway runs (SCR-OFC-19 Resending): the dialog's own busy word. */
const BUSY: Record<ConflictAction, MessageKey> = {
  reassign: 'board.conflict.busy', reschedule: 'job.reschedule.saving', cancel: 'job.cancel.canceling', finish: 'job.finish.finishing', correct: 'job.finish.sendingAgain', edit: 'job.saving',
};

export interface VersionedWrite<T> {
  action: ConflictAction;
  /** The version the dialog opened on. */
  version: number;
  send: (version: number) => Promise<Answer<T>>;
  onSent: (data: T) => void;
  /** Every refusal but version_conflict goes back to the dialog, whose form is still as the person left it. */
  onRefused: (r: Refusal) => void;
  /** Keep their change: the host closes the dialog and re-reads (CTL-OFC-19-03). */
  onKeep: () => void;
}

interface Shown { conflict: Conflict | null; again: boolean; resending: boolean }

/** The write of a dialog that carries a job version. `conflict` is SCR-OFC-19 while it is up: the dialog returns it in place of itself. */
export function useVersionedWrite<T>(w: VersionedWrite<T>): { write: () => Promise<void>; conflict: ReactNode } {
  const t = useT();
  const [accepted, setAccepted] = useState<number | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);

  const run = async (version: number, resending: boolean) => {
    const r = await w.send(version);
    if (r.ok) {
      setShown(null);
      return w.onSent(r.data);
    }
    const conflict = conflictOf(r);
    if (conflict) return setShown({ conflict, again: resending, resending: false });
    // SCR-OFC-19 Gone: the job went while the person looked at the message.
    if (resending && r.code === 'not_found') return setShown({ conflict: null, again: false, resending: false });
    setShown(null);
    w.onRefused(r);
  };
  const anyway = () => {
    if (!shown?.conflict) return;
    const version = shown.conflict.currentVersion;
    setAccepted(version);
    setShown({ ...shown, resending: true });
    void run(version, true);
  };
  const words = (c: Conflict): string => {
    const who = conflictWords(c);
    const by = 'name' in who.who ? who.who.name : t(who.who.key);
    if (who.at === null) return t('job.conflict.unknown', { action: w.action });
    return t('job.conflict.message', { by, change: who.change, to: c.technician ?? t('board.conflict.unassignedRow'), at: who.at, action: w.action });
  };
  return {
    write: () => run(accepted ?? w.version, false),
    conflict: shown ? (
      <ConflictDialog subject="job" message={shown.conflict ? words(shown.conflict) : null} again={shown.again} resending={shown.resending} onAnyway={anyway} onKeep={w.onKeep}
        anywayLabel={t(`job.conflict.anyway.${w.action}` as MessageKey)} busyLabel={t(BUSY[w.action])} />
    ) : null,
  };
}
