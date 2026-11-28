// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-CUS-06 Change your visit time, live: the page reads the visit and the days the online rules offer by the reschedule link's token
// (API-117) and moves the visit with 1 confirm (API-118, SD-45). A link that has ended answers gone and the page says so with the office
// phone (OA-62). The token travels only in the paths of its own rows.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNewestAnswer } from '../shell/newest-answer.ts';
import { callPage, rows, type MovedVisit, type RescheduleData } from './api.ts';
import { RescheduleView, type RescheduleNotice, type RescheduleState } from './RescheduleView.tsx';

export function RescheduleScreen({ token }: { token: string }) {
  const [state, setState] = useState<RescheduleState>('loading');
  const [data, setData] = useState<RescheduleData | null>(null);
  const [phone, setPhone] = useState('');
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [pickedWindow, setPickedWindow] = useState<string | null>(null);
  const [filled, setFilled] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<RescheduleNotice>(null);
  const [moved, setMoved] = useState<MovedVisit | null>(null);
  const saving = useRef(false);

  const newest = useNewestAnswer();
  // K-05: a re-read of the offered days (after a refused move) shows the newest read's answer, however late an earlier one lands.
  const read = useCallback(async () => {
    await newest.run(() => callPage(rows.reschedulePage, { rescheduleToken: token }), (r) => {
      if (r.ok) {
        setData(r.data);
        setPhone(r.data.officePhone);
        setState('choosing');
      } else if (r.status === 410) {
        setPhone(r.officePhone ?? '');
        setState('ended');
      } else setState(r.status === 404 ? 'not_valid' : 'failed');
    });
  }, [token, newest]);

  useEffect(() => {
    void read();
  }, [read]);

  const confirm = async () => {
    if (saving.current || !pickedDay || !pickedWindow) return;
    saving.current = true;
    setNotice(null);
    setState('saving');
    const r = await callPage(rows.rescheduleVisit, { rescheduleToken: token, date: pickedDay, windowId: pickedWindow });
    saving.current = false;
    if (r.ok) {
      setMoved(r.data);
      setState('changed');
      return;
    }
    if (r.status === 410) {
      setPhone(r.officePhone ?? phone);
      setState('ended');
      return;
    }
    setState('choosing');
    if (r.code === 'window_full') {
      setFilled((was) => new Set([...was, pickedWindow]));
      setPickedWindow(null);
      setNotice('window_full');
    } else if (r.code === 'booking_closed') {
      setNotice('closed');
      void read();
    } else setNotice('failed');
  };

  return (
    <RescheduleView
      state={state} data={data} phone={phone} pickedDay={pickedDay} pickedWindow={pickedWindow} filled={filled} notice={notice} moved={moved}
      onPickDay={(d) => { setPickedDay(d); setPickedWindow(null); setNotice(null); }}
      onPickWindow={(w) => { setPickedWindow(w); setNotice(null); }}
      onConfirm={() => void confirm()} onKeep={() => setState('kept')} onRetry={() => void read()}
    />
  );
}
