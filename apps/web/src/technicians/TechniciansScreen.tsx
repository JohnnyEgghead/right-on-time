// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-07 Technicians at `/office/technicians?branch=<id>` (UI-SPECIFICATION 2.3; FR-DISP-33, FR-TEXT-11; Roles O, M: the page gate of the policy
// table refuses anyone else). Reads API-31 for the branch, checks a typed name in texts through API-32 after a short pause, saves the panel through
// API-33, and opens SCR-OFC-41 (API-147) and SCR-OFC-42 (API-148); Remove on a time off span is API-169 with no confirm step (OI-44). The search
// text stays in this page's state, never in the URL or a log (NFR-05); only the branch is in the URL.
import { createClient, type TextCheckAnswer } from '@bw/api';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OfficeFrame } from '../shell/Frames.tsx';
import { useAnnounce } from '../shell/Announcer.tsx';
import { BRANCHES } from '../shell/branches.ts';
import { useT } from '../shell/intl.tsx';
import { useBranch } from '../shell/useBranch.ts';
import { techApi, type TechApi } from './api.ts';
import { AddTechnicianDialog, AddTimeOffDialog } from './Dialogs.tsx';
import { windowText } from '../board/model.ts';
import {
  draftOf, filterRows, firstName, offDayJobsText, sameWeek, START_FILTERS, type DraftEdit, type Filters, type NameCheckState, type TechData, type TechRow, type TechSkill,
  weekOf,
} from './model.ts';
import { TechniciansView, type TechState } from './TechniciansView.tsx';

/** The name is checked once typing has paused this long (CTL-OFC-07-03: "as typed, after a short pause"). */
const TYPING_PAUSE_MS = 300;

const branchOfParam = (v: string | null): string | null => (BRANCHES.some((b) => b.id === v) ? v : null);

type Open = null | 'add' | 'timeoff';

export function TechniciansScreen({ api: given }: { api?: TechApi } = {}) {
  const t = useT();
  const announce = useAnnounce();
  const params = useSearchParams();
  const topBranch = useBranch();
  const api = useMemo(() => given ?? techApi(typeof window === 'undefined' ? undefined : createClient({ baseUrl: window.location.origin })), [given]);
  const [pickedBranch, setPickedBranch] = useState<string | null>(() => branchOfParam(params.get('branch')));
  const [filters, setFilters] = useState<Filters>(START_FILTERS);
  const [data, setData] = useState<TechData | null>(null);
  const [state, setState] = useState<TechState>('loading');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftEdit | null>(null);
  const [check, setCheck] = useState<NameCheckState>({ step: 'idle' });
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const branch = pickedBranch ?? topBranch;
  const seq = useRef(0);
  const closedByPerson = useRef(false);

  // A move in the top bar is a new list: the page's own Branch pick is dropped (not on the first run, which keeps the address's ?branch).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setPickedBranch(null);
  }, [topBranch]);

  const read = useCallback(async (): Promise<boolean> => {
    if (!branch) return false;
    const mine = ++seq.current;
    const r = await api.list(branch);
    if (mine !== seq.current) return true;
    if (!r.ok) {
      setState((s) => (s === 'ready' ? s : 'error'));
      return false;
    }
    setData(r.data);
    setState('ready');
    return true;
  }, [api, branch]);

  useEffect(() => {
    setData((d) => (d && branch && d.branch !== branch ? null : d));
    setState((s) => (s === 'error' ? 'loading' : s));
    setSelectedId(null);
    closedByPerson.current = false;
    void read();
  }, [branch, read]);

  // The first technician listed is open in the panel until the person closes it or picks another (the frame's Success state).
  useEffect(() => {
    if (!data || closedByPerson.current) return;
    if (selectedId === null || !data.technicians.some((r) => r.id === selectedId)) setSelectedId(filterRows(data.technicians, filters)[0]?.id ?? null);
  }, [data, selectedId]);

  const row: TechRow | null = data?.technicians.find((r) => r.id === selectedId) ?? null;
  const rowKey = row ? `${row.id}|${row.nameInTexts}|${row.van?.id ?? ''}|${[...row.skills].sort().join()}|${JSON.stringify(weekOf(row))}` : '';
  // The panel holds the saved values again whenever the technician, or what is saved of them, changes. F-905: reset in the render that
  // shows the change, never in an effect after it, so no frame shows a technician with another one's draft (a tick pressed in that frame
  // toggled the other draft's value, and Save there would write it to this technician).
  const [draftKey, setDraftKey] = useState('');
  if (draftKey !== rowKey) {
    setDraftKey(rowKey);
    setDraft(row ? draftOf(row) : null);
    setCheck({ step: 'idle' });
    setNotice(null);
  }

  // CTL-OFC-07-03: the typed name is checked after a pause (API-32); the newest answer only is shown.
  const typed = draft?.name ?? '';
  const saved = row?.nameInTexts ?? '';
  const checks = useRef(0);
  useEffect(() => {
    if (!row || typed === saved) {
      setCheck({ step: 'idle' });
      return;
    }
    const mine = ++checks.current;
    setCheck({ step: 'checking' });
    const id = window.setTimeout(async () => {
      const r = await api.check(typed);
      if (mine !== checks.current) return;
      setCheck(r.ok ? { step: 'done', answer: r.data } : { step: 'failed' });
    }, TYPING_PAUSE_MS);
    return () => window.clearTimeout(id);
  }, [typed, saved, row, api]);

  const save = async () => {
    if (!row || !draft || saving) return;
    setSaving(true);
    setNotice(null);
    const edit: Parameters<TechApi['edit']>[1] = {};
    if (draft.name !== row.nameInTexts) edit.nameInTexts = draft.name;
    if (draft.vanId !== (row.van?.id ?? null)) edit.vanId = draft.vanId;
    if ([...draft.skills].sort().join() !== [...row.skills].sort().join()) edit.skills = draft.skills;
    if (!sameWeek(draft.week, weekOf(row))) edit.workingHours = draft.week;
    const r = await api.edit(row.id, edit);
    setSaving(false);
    if (r.ok) {
      // A job left on a day no longer worked stays where it is (no text moves it, F-764): the office is told which, and reassigns it on the board.
      const jobs = r.data.offDayJobs;
      announce(jobs.length === 0 ? t('technicians.saved') : t('technicians.savedJobs', { name: firstName(row.name), count: jobs.length, jobs: offDayJobsText(jobs, t, windowText) }));
      await read();
      return;
    }
    if (r.code === 'text_value_breaks_limit') {
      const d = r.detail as { problem?: TextCheckAnswer['problem']; length?: number; limit?: number; chars?: string[] };
      setCheck({ step: 'done', answer: { ok: false, problem: d.problem ?? 'breaks_template', characters: d.chars ?? [], length: d.length ?? draft.name.length, maximum: d.limit ?? 10 } });
    } else setNotice(t('technicians.write.failed'));
  };

  const removeSpan = async (spanId: string) => {
    if (!row || removing) return;
    setRemoving(spanId);
    setNotice(null);
    const r = await api.removeTimeOff(row.id, spanId);
    setRemoving(null);
    if (r.ok) {
      announce(t('technicians.timeOff.removed'));
      await read();
    } else if (r.code === 'not_found') {
      await read();
      setNotice(t('technicians.timeOff.gone'));
    } else setNotice(t('technicians.write.failed'));
  };

  const pickBranch = (id: string) => {
    setPickedBranch(id);
    try {
      window.history.replaceState(null, '', `/office/technicians?branch=${id}`);
    } catch {
      // the address bar is only a convenience
    }
  };

  const dialogs = !data ? null : open === 'add' ? (
    <AddTechnicianDialog api={api} data={data} branch={branch ?? 'columbus'} onClose={() => setOpen(null)} onAdded={() => void read()} />
  ) : open === 'timeoff' && row ? (
    <AddTimeOffDialog api={api} row={row} onClose={() => setOpen(null)}
      onSaved={(toast) => { setOpen(null); announce(toast); void read(); }} />
  ) : null;

  return (
    <OfficeFrame screen="SCR-OFC-07" bar={{ currentPath: '/office/technicians' }}>
      <TechniciansView
        state={branch ? state : 'loading'}
        data={data}
        branch={branch ?? 'columbus'}
        filters={filters}
        selectedId={selectedId}
        draft={draft}
        check={check}
        saving={saving}
        removing={removing}
        notice={notice}
        extra={dialogs}
        handlers={{
          query: (query) => setFilters((f) => ({ ...f, query })),
          branch: pickBranch,
          filterSkill: (skill) => setFilters((f) => ({ ...f, skill })),
          working: (v) => setFilters((f) => ({ ...f, working: v === 'today' || v === 'off' ? v : '' })),
          app: (v) => setFilters((f) => ({ ...f, app: v === 'waiting' || v === 'clear' ? v : '' })),
          select: (id) => { closedByPerson.current = false; setSelectedId(id); },
          close: () => { closedByPerson.current = true; setSelectedId(null); },
          addTechnician: () => setOpen('add'),
          addTimeOff: () => setOpen('timeoff'),
          removeTimeOff: (id) => void removeSpan(id),
          name: (name) => setDraft((d) => (d ? { ...d, name } : d)),
          van: (vanId) => setDraft((d) => (d ? { ...d, vanId } : d)),
          skill: (s: TechSkill) => setDraft((d) => (d && data ? { ...d, skills: data.skills.filter((x) => (x === s ? !d.skills.includes(x) : d.skills.includes(x))) } : d)),
          hoursOpen: () => setDraft((d) => (d ? { ...d, hoursOpen: true } : d)),
          week: (week) => setDraft((d) => (d ? { ...d, week } : d)),
          cancel: () => { if (row) { setDraft(draftOf(row)); setCheck({ step: 'idle' }); setNotice(null); } },
          save: () => void save(),
          retry: async () => { setState('loading'); await read(); },
        }}
      />
    </OfficeFrame>
  );
}
