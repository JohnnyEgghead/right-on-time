// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-04 New job at `/office/jobs/new?customer=<customerId>&date=<day>` (DK-89; UI-SPECIFICATION SCR-OFC-04; FR-DISP-8, FR-DISP-28,
// FR-DISP-29): holds the picks, reads API-34, API-35, API-110, API-29 and API-30 as each step opens, creates the job through API-28 and
// opens its page (SCR-OFC-03), which shows CMP-11's words about the confirmation text. The search text stays in page state (NFR-05). Any
// error leaves every field as it was (UIS.FR-STATE-4); a window or technician that filled is marked and its list re-read.
import '../shell/css/office.ts';
import '../../styles/page-office-new-job.css';
import '../../styles/app/new-job.css';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ServicesAnswer } from '@bw/api';
import { CustomerFormDialog } from '../customers/CustomerFormDialog.tsx';
import { Dialog } from '../customers/ui.tsx';
import { firstName } from '../customers/model.ts';
import { refusalShown, type Refusal, type Shown } from '../job/model.ts';
import { spanText } from '../board/model.ts';
import { OfficeFrame } from '../shell/Frames.tsx';
import { BRANCHES } from '../shell/branches.ts';
import { useT } from '../shell/intl.tsx';
import { newJobApi, type NewJobApi } from './api.ts';
import { confirmationKey, hasInput, NO_PICKS, offeredDays, writeHandoff, type Day, type Picks } from './model.ts';
import { NewJobView, type CustomerState, type SearchState, type TechState } from './NewJobView.tsx';

const DEBOUNCE_MS = 200;

/** The refusal words of Schedule: API-28's own codes first, then the job writes' shared ones (time_overlap names the block). */
function scheduleShown(r: Refusal): Shown {
  return r.code === 'technician_no_room' ? { key: 'newjob.refused.technicianNoRoom' } : refusalShown(r, spanText);
}

export interface NewJobScreenProps {
  /** The `customer` query value, already checked as an id (CTL-OFC-06-01, CTL-OFC-05-14). */
  customerId?: string | undefined;
  /** The `date` query value, already checked as a day (CTL-OFC-02-05). */
  date?: string | undefined;
  /** Tests: a stand-in for the calls. */
  api?: NewJobApi;
}

export function NewJobScreen({ customerId, date, api: given }: NewJobScreenProps) {
  const t = useT();
  const router = useRouter();
  const api = useMemo(() => given ?? newJobApi(), [given]);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchState>({ kind: 'idle' });
  const [customer, setCustomer] = useState<CustomerState>(customerId ? { kind: 'loading' } : { kind: 'none' });
  const [services, setServices] = useState<ServicesAnswer['services'] | 'loading' | 'error'>('loading');
  const [picks, setPicks] = useState<Picks>(NO_PICKS);
  const [wantedDate, setWantedDate] = useState<string | undefined>(date);
  const [days, setDays] = useState<Day[] | 'loading' | 'error' | null>(null);
  const [techs, setTechs] = useState<TechState>({ kind: 'waiting' });
  const [techsKey, setTechsKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [dialog, setDialog] = useState<'new' | 'leave' | null>(null);
  const searchSeq = useRef(0);
  const customerSeq = useRef(0);
  const daysSeq = useRef(0);
  const [today, setToday] = useState<string | null>(null);

  const detail = customer.kind === 'picked' ? customer.detail : null;
  const edit = (patch: Partial<Picks>) => {
    setPicks((p) => ({ ...p, ...patch }));
    setShown(null);
  };

  // API-110 once.
  const loadServices = useCallback(() => {
    setServices('loading');
    void api.services().then((r) => setServices(r.ok ? r.data.services : 'error'));
  }, [api]);
  useEffect(loadServices, [loadServices]);

  // API-10 once: the demo clock's day (CTL-OFC-04-13, CTL-OFC-04-19).
  useEffect(() => {
    void api.today().then(setToday);
  }, [api]);

  // API-35: the picked customer (a result, the New customer dialog's, or the page's `customer`).
  const pick = useCallback((id: string) => {
    const mine = ++customerSeq.current;
    setCustomer({ kind: 'loading' });
    void api.customer(id).then((r) => {
      if (mine !== customerSeq.current) return;
      if (!r.ok) return setCustomer({ kind: 'error' });
      setCustomer({ kind: 'picked', detail: r.data });
      // Equipment is the customer's own: a pick of another customer's does not carry over.
      setPicks((p) => (p.equipmentId !== null && !r.data.equipment.some((e) => e.id === p.equipmentId) ? { ...p, equipmentId: null } : p));
    });
  }, [api]);
  const retryCustomer = () => {
    if (customerId) pick(customerId);
    else setCustomer({ kind: 'none' });
  };
  const first = useRef(true);
  useEffect(() => {
    if (first.current && customerId) pick(customerId);
    first.current = false;
  }, [customerId, pick]);

  // API-34 as the office types (CTL-OFC-04-01): the newest answer wins, the text exactly as typed (trimmed only).
  const runSearch = useCallback(async (q: string) => {
    const mine = ++searchSeq.current;
    if (q.trim() === '') return setSearch({ kind: 'idle' });
    setSearch({ kind: 'searching' });
    const r = await api.search(q);
    if (mine !== searchSeq.current) return;
    setSearch(!r.ok ? { kind: 'error' } : r.data.customers.length === 0 ? { kind: 'none' } : { kind: 'hits', page: r.data });
  }, [api]);
  const onQuery = (q: string) => {
    setQuery(q);
    if (q.trim() === '') {
      searchSeq.current++;
      setSearch({ kind: 'idle' });
    }
  };
  useEffect(() => {
    if (query.trim() === '') return;
    const h = window.setTimeout(() => void runSearch(query), DEBOUNCE_MS);
    return () => window.clearTimeout(h);
  }, [query, runSearch]);

  // API-29: the days of the picked service in the customer's branch, the newest answer winning. A pick that is no longer offered is dropped.
  const branch = detail?.branch ?? null;
  const serviceId = picks.serviceId;
  const customerKey = detail?.id ?? null;
  const loadDays = useCallback(() => {
    const mine = ++daysSeq.current;
    if (!branch || !serviceId) return setDays(null);
    setDays('loading');
    void api.availability({ branch, serviceId }).then((r) => {
      if (mine !== daysSeq.current) return;
      if (!r.ok) return setDays('error');
      const offered = offeredDays(r.data.days);
      setDays(offered);
      setPicks((p) => {
        const day = offered.find((d) => d.date === p.day);
        const stillDay = day && day.state !== 'full';
        const win = stillDay ? day.windows.find((w) => w.windowId === p.windowId) : undefined;
        // The `date` the board sent (CTL-OFC-02-05) is picked once its day is offered and has room.
        const want = wantedDate ? offered.find((d) => d.date === wantedDate && d.state !== 'full') : undefined;
        if (!p.day && want) return { ...p, day: want.date };
        if (stillDay && win && win.state !== 'full') return p;
        return stillDay ? { ...p, windowId: null, technicianId: null } : { ...p, day: null, windowId: null, technicianId: null };
      });
    });
  }, [api, branch, serviceId, wantedDate]);
  useEffect(loadDays, [loadDays, customerKey]);

  // API-30: the technicians with room once the customer, service, day and window are picked.
  const day = picks.day;
  const windowId = picks.windowId;
  useEffect(() => {
    if (!customerKey || !branch || !serviceId || !day || !windowId) return setTechs({ kind: 'waiting' });
    let on = true;
    setTechs({ kind: 'loading' });
    void api.suggest({ branch, date: day, windowId, serviceId, customerId: customerKey }).then((r) => {
      if (!on) return;
      if (!r.ok) return setTechs({ kind: 'error' });
      setTechs({ kind: 'ready', technicians: r.data.technicians, serviceSkill: r.data.serviceSkill });
      // A technician picked for another window who has no room in this one is dropped.
      setPicks((p) => (p.technicianId !== null && !r.data.technicians.some((x) => x.id === p.technicianId && x.room) ? { ...p, technicianId: null } : p));
    });
    return () => { on = false; };
  }, [api, customerKey, branch, serviceId, day, windowId, techsKey]);

  const schedule = async () => {
    if (saving || !detail || !serviceId || !day || !windowId) return;
    setSaving(true);
    setShown(null);
    const r = await api.create({
      customerId: detail.id, serviceId, equipmentId: picks.equipmentId, problem: picks.problem.trim() === '' ? null : picks.problem.trim(),
      date: day, windowId, technicianId: picks.technicianId,
    });
    if (r.ok) {
      // The job page that opens states the server's answer about the confirmation text (CMP-11, GAP-10); the busy button stays until it does.
      writeHandoff({ jobNumber: r.data.job.jobNumber, key: confirmationKey(r.data.confirmationText), values: { n: r.data.job.jobNumber, name: firstName(detail.name) } });
      router.push(`/office/jobs/${r.data.job.jobNumber}`);
      return;
    }
    setSaving(false);
    setShown(scheduleShown(r));
    if (r.code === 'window_full') {
      // The window turns Full and its pick is dropped; the other fields keep their values.
      setDays((ds) => (Array.isArray(ds) ? ds.map((d) => (d.date === day ? { ...d, windows: d.windows.map((w) => (w.windowId === windowId ? { ...w, state: 'full' as const, left: 0 } : w)) } : d)) : ds));
      setPicks((p) => ({ ...p, windowId: null, technicianId: null }));
    } else if (r.code === 'technician_no_room') {
      setPicks((p) => ({ ...p, technicianId: null }));
      setTechsKey((k) => k + 1);
    }
  };

  const leave = () => {
    if (hasInput(query, customer.kind === 'none' ? null : customer, picks)) setDialog('leave');
    else router.push('/office/jobs');
  };
  const branchName = BRANCHES.find((b) => b.id === branch)?.name ?? branch ?? '';

  return (
    <OfficeFrame screen="SCR-OFC-04">
      <NewJobView
        query={query} search={search} customer={customer} services={services} picks={picks} days={days} techs={techs} saving={saving} shown={shown} branchName={branchName} today={today}
        on={{
          query: onQuery,
          pickHit: pick,
          retrySearch: () => void runSearch(query),
          retryCustomer,
          newCustomer: () => setDialog('new'),
          change: () => {
            customerSeq.current++;
            setCustomer({ kind: 'none' });
            setDays(null);
            setShown(null);
          },
          service: (id) => edit({ serviceId: id, day: null, windowId: null, technicianId: null }),
          equipment: (id) => edit({ equipmentId: id }),
          problem: (text) => edit({ problem: text }),
          day: (d) => { setWantedDate(undefined); edit({ day: d, windowId: null, technicianId: null }); },
          window: (id) => edit({ windowId: id, technicianId: null }),
          technician: (id) => edit({ technicianId: id }),
          retryDays: loadDays,
          retryTechs: () => setTechsKey((k) => k + 1),
          retryServices: loadServices,
          schedule: () => void schedule(),
          leave,
        }}
      />
      {dialog === 'new' ? <CustomerFormDialog mode="new" onClose={() => setDialog(null)} onSaved={(c) => { setDialog(null); pick(c.id); }} /> : null}
      {dialog === 'leave' ? (
        <Dialog
          screen="SCR-OFC-04" hosted={false} title={t('newjob.leave.title')} closeCtl="CTL-OFC-04-10" onClose={() => setDialog(null)}
          body={<p>{t('newjob.leave.body')}</p>}
          foot={<>
            <button type="button" className="btn" data-initial data-ctl="CTL-OFC-04-10" onClick={() => setDialog(null)}>{t('newjob.leave.stay')}</button>
            <button type="button" className="btn primary" data-ctl="CTL-OFC-04-10" onClick={() => router.push('/office/jobs')}>{t('newjob.leave.go')}</button>
          </>}
        />
      ) : null}
    </OfficeFrame>
  );
}
