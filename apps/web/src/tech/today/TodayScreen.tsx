// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-TEC-02 Today, live (UI-SPECIFICATION 8; FR-TECH-1, FR-TECH-2, FR-TECH-9, FR-TECH-12): reads API-100, keeps the last good
// answer on the phone for an open with no signal ("Last updated"), applies the phone's waiting items to the list at once
// (section 4.5 rule 6), and opens the confirm sheets. Every status action is an item entered through the page's item engine
// (useOutbox.ts) and sent when online; nothing here calls a write itself.
import type { TodayAnswer } from '@bw/api';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../shell/intl.tsx';
import { techReads, useTechData, type TechReads } from '../data.ts';
import { NotReadyError } from '../engine.ts';
import { forgetShell } from '../session.ts';
import { TodayShell } from '../TodayShell.tsx';
import { techOutbox, useOwnOutbox } from '../useOutbox.ts';
import { useOwedSignatures } from '../job/owed.ts';
import { applyWaiting, askedSheet, directionsMinutes, NO_NEW_DAY, nextJob, trackNewDay, type NewDayTrack } from './model.ts';
import type { SheetKind } from './TodayView.tsx';

const ITEM: Record<SheetKind, 'on_my_way' | 'arrived' | 'no_one_home'> = { omw: 'on_my_way', arrived: 'arrived', noh: 'no_one_home' };

/** F-1333: the Directions button's read of API-104 goes through leg(), which keeps the answer as the destination's last route read (rule 11). */
export function legReader(reads: Pick<TechReads, 'leg'>): (toJob: number) => Promise<{ leg: { track: unknown; minutes: number } }> {
  return async (toJob) => {
    const got = await reads.leg(toJob);
    if (got.kind !== 'leg') throw new Error('no leg');
    return { leg: got.leg };
  };
}

/**
 * The day is the technician app's one read (../data.ts: on open, on focus, when the connection is back, every 60 s, after a send), kept as
 * the one saved day (../local.ts) and compared for the one day-changed notice (../DayNotices.tsx, which honors the Notifications switch).
 * `initial` is the day the server carried in the page: it paints at once and becomes the saved day.
 */
export function TodayScreen({ initial }: { initial: TodayAnswer | null }) {
  const t = useT();
  const outbox = useOwnOutbox();
  const reads = useTechData();
  const [notice, setNotice] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ kind: SheetKind; jobNumber: number } | null>(null);

  useEffect(() => {
    if (initial) techReads().adopt({ at: initial.asOf, data: initial });
  }, [initial]);

  const day = initial !== null && !reads.settled ? initial : (reads.day?.data ?? null);
  const loading = day === null && !reads.settled;
  // F-1019: any failed read is shown: with a saved day above it, and with nothing saved when the phone has signal (CMP-12 with Try again).
  const failed = reads.failed && (day !== null || outbox.online);

  // A send that just finished changed the server's side of the day: read it again.
  const sending = useRef(outbox.sending);
  useEffect(() => {
    if (sending.current && !outbox.sending) void techReads().refresh();
    sending.current = outbox.sending;
  }, [outbox.sending]);

  // The session ended (401, on a send or on a read of the day): the sign-in page, the waiting items kept (UD-20).
  useEffect(() => {
    // F-1101: the server ended the session, so the phone drops the person's kept pages too (as a sign-out does), then opens sign-in.
    if (outbox.signedOut || reads.signedOut) void forgetShell().then(() => window.location.assign('/tech/sign-in'));
  }, [outbox.signedOut, reads.signedOut]);

  const owedSignatures = useOwedSignatures(outbox.waiting);
  const jobs = useMemo(() => applyWaiting(day?.jobs ?? [], outbox.waiting, outbox.lastSent), [day, outbox.waiting, outbox.lastSent]);

  // CTL-TEC-02-03: the Directions button's minutes are API-104's drive time for the next job from the van's position (FR-TECH-13). Read with
  // signal, again with each read of the day (the van moves); none offline, and none for an approximate route (no baked track).
  const nextNo = nextJob(jobs)?.jobNumber ?? null;
  const readAt = reads.day?.at ?? null;
  const [drive, setDrive] = useState<{ job: number; minutes: number | null } | null>(null);
  useEffect(() => {
    let live = true;
    // F-1333: through techReads().leg(), which keeps the answer as this destination's last route read (rule 11), as the native app does.
    void directionsMinutes(legReader(techReads()), nextNo, outbox.online).then((d) => live && setDrive(d));
    return () => {
      live = false;
    };
  }, [nextNo, readAt, outbox.online]);

  // F-1135: a read that answers a later date than the list shown is New day until the next read of that date answers.
  const [track, setTrack] = useState<NewDayTrack>(NO_NEW_DAY);
  const dayDate = day?.date ?? null;
  useEffect(() => {
    setTrack((prev) => trackNewDay(prev, dayDate, readAt));
  }, [dayDate, readAt]);

  const open = sheet ? jobs.find((j) => j.jobNumber === sheet.jobNumber) : undefined;

  // A sheet the job screen asked for opens once its job is in the day; the address bar drops the ask, so a reload opens no sheet.
  const asked = useRef<{ kind: SheetKind; jobNumber: number } | null | undefined>(undefined);
  useEffect(() => {
    if (asked.current === undefined) {
      asked.current = askedSheet(window.location.search);
      if (asked.current) window.history.replaceState(null, '', window.location.pathname);
    }
    const a = asked.current;
    if (a && jobs.some((j) => j.jobNumber === a.jobNumber)) {
      asked.current = null;
      setSheet(a);
    }
  }, [jobs]);

  const confirm = async () => {
    if (!sheet || !open) return;
    const { kind } = sheet;
    setSheet(null);
    try {
      await techOutbox().enter({ jobNumber: open.jobNumber, baseVersion: open.version, body: { kind: ITEM[kind] } });
    } catch (e) {
      if (e instanceof NotReadyError) setNotice(t('tech.sheet.notReady'));
      else throw e;
    }
  };

  return (
    <TodayShell
      owedSignatures={owedSignatures} day={day} jobs={jobs} loading={loading} online={outbox.online} savedAt={day?.asOf ?? null} failed={failed} failedAt={reads.failedAt ?? null} notice={notice} newDay={track.newDayAt !== null && day !== null} driveMinutes={drive && drive.job === nextNo ? drive.minutes : null}
      sheet={sheet && open ? { kind: sheet.kind, job: open } : null}
      onRefresh={() => void techReads().refresh()} onOpen={(kind, job) => setSheet({ kind, jobNumber: job.jobNumber })}
      onCancel={() => setSheet(null)} onConfirm={() => void confirm()}
    />
  );
}
