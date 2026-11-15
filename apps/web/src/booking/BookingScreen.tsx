// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-CUS-01 Book a visit at `/book` and SCR-CUS-02 Window just taken, in place on the same route (DK-118 to DK-120; UI-SPECIFICATION section 9;
// FR-BOOK-1 to FR-BOOK-16): holds the draft, reads API-110, API-111 and API-112 as each step opens, books through API-113 and opens
// `/book/done/<bookingToken>` (SCR-CUS-03). A window that filled answers `window_full` with the nearest open windows: the page then shows
// them beside the input it kept. The draft survives a reload and the language switch (UIS.FR-STATE-4) in session storage; nothing typed goes
// into a URL (NFR-05).
import '../../styles/page-booking.css';
import '../../styles/page-booking-taken.css';
import '../../styles/page-booking-phone.css';
import '../../styles/app/booking.css';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OnlineAvailabilityAnswer } from '@bw/api';
import type { Shown } from '../job/model.ts';
import { BookingFrame } from '../shell/BookingFrame.tsx';
import { BRANCHES, branchById } from '../shell/branches.ts';
import { dayShort, emptyDraft, firstOpenStep, houseNumber, mobileDigits, monthOf, readKept, stepComplete, textsOn, writeKept, type Draft, type Lang, type Nearest, type StepNumber, type Street } from './model.ts';
import { useT } from '../shell/intl.tsx';
import { bookingApi, browserZone, type BookingApi } from './api.ts';
import { useLayout } from './layout.ts';
import { BookingView, type AvailState, type StreetState, type ViewProps } from './BookingView.tsx';

const DEBOUNCE_MS = 200;
/** The frame's order of the services (DK-118); one it does not draw follows, in the API's order. */
const ORDER = ['furnace_tune_up', 'ac_tune_up', 'heating_or_ac_fix', 'plumbing_repair', 'water_heater', 'thermostat'];
const rank = (id: string): number => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);

interface Taken { filled: { date: string; windowId: string; start: string; end: string }; options: Nearest[]; picked: string | null }

export function BookingScreen({ api: given, fresh = false }: { api?: BookingApi; fresh?: boolean }) {
  const t = useT();
  const router = useRouter();
  const api = useMemo(() => given ?? bookingApi(), [given]);
  const layout = useLayout();
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(t.lang));
  const [step, setStep] = useState<StepNumber>(1);
  const [services, setServices] = useState<ViewProps['services']>('loading');
  const [street, setStreet] = useState<StreetState>({ kind: 'idle' });
  const [avail, setAvail] = useState<AvailState>({ kind: 'idle' });
  const [month, setMonth] = useState('');
  const [booking, setBooking] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [invalid, setInvalid] = useState<ViewProps['invalid']>({});
  const [taken, setTaken] = useState<Taken | null>(null);
  const [restored, setRestored] = useState(false);
  const seq = useRef({ street: 0, avail: 0 });

  // Restore the kept draft once (a reload, or the language switch remounting the page); `fresh` is Book another visit: it starts empty.
  useEffect(() => {
    if (fresh) writeKept(null);
    const k = fresh ? null : readKept();
    if (k) {
      setDraft(k.draft);
      setStep(k.step);
    }
    setRestored(true);
  }, [fresh]);
  useEffect(() => {
    if (restored) writeKept({ draft, step, taken: null });
  }, [draft, step, restored]);

  // The text language follows the page's language until the customer picks one beside the box (CTL-CUS-01-16).
  useEffect(() => {
    setDraft((d) => (d.languagePicked || d.textLanguage === t.lang ? d : { ...d, textLanguage: t.lang }));
  }, [t.lang]);

  // API-110 once (the services bookable online).
  const loadServices = useCallback(() => {
    setServices('loading');
    void api.services().then((r) => setServices(r.ok ? [...r.data.services.filter((s) => s.bookableOnline)].sort((a, b) => rank(a.serviceId) - rank(b.serviceId)) : 'error'));
  }, [api]);
  useEffect(loadServices, [loadServices]);

  // API-111 after 2 characters, debounced; the text goes in the body, never the URL.
  const text = draft.streetText;
  const picked = draft.street;
  useEffect(() => {
    if (picked !== null) return;
    const q = text.trim();
    if (q.length < 2) {
      setStreet({ kind: 'idle' });
      return;
    }
    const mine = ++seq.current.street;
    const id = setTimeout(() => {
      setStreet({ kind: 'loading' });
      void api.streets(q).then((r) => {
        if (mine !== seq.current.street) return;
        setStreet(!r.ok ? { kind: 'error' } : r.data.streets.length === 0 ? { kind: 'none' } : { kind: 'results', streets: r.data.streets });
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [text, picked, api]);
  const retryStreets = () => setDraft((d) => ({ ...d, streetText: `${d.streetText} `.trimEnd() + (d.streetText.endsWith(' ') ? '' : ' ') }));

  // API-112 when the day step opens, and again when the page regains focus (CTL-CUS-01-06): a window that just filled shows Full.
  const streetId = draft.street?.streetId;
  const serviceId = draft.serviceId;
  const needsDays = (step >= 3 || taken !== null) && streetId !== undefined && serviceId !== null;
  const loadDays = useCallback((quiet: boolean) => {
    if (!streetId || !serviceId) return;
    const mine = ++seq.current.avail;
    if (!quiet) setAvail({ kind: 'loading' });
    void api.availability({ streetId, serviceId }).then((r) => {
      if (mine !== seq.current.avail) return;
      if (!r.ok) {
        if (!quiet) setAvail({ kind: 'error' });
        return;
      }
      setAvail({ kind: 'ready', data: r.data });
      // A picked window that filled meanwhile is dropped, its day stays (every other field keeps its value).
      setDraft((d) => {
        const day = r.data.days.find((x) => x.date === d.date);
        const w = day?.windows.find((x) => x.windowId === d.windowId);
        return d.windowId !== null && (!w || w.state === 'full') ? { ...d, windowId: null } : d;
      });
    });
  }, [api, streetId, serviceId]);
  useEffect(() => {
    if (needsDays) loadDays(false);
    else setAvail({ kind: 'idle' });
  }, [needsDays, loadDays]);
  useEffect(() => {
    if (!needsDays) return;
    const on = () => loadDays(true);
    window.addEventListener('focus', on);
    document.addEventListener('visibilitychange', on);
    return () => {
      window.removeEventListener('focus', on);
      document.removeEventListener('visibilitychange', on);
    };
  }, [needsDays, loadDays]);
  const today = avail.kind === 'ready' ? avail.data.today : '';
  useEffect(() => {
    if (today && month === '') setMonth(monthOf(draft.date ?? today));
  }, [today, month, draft.date]);

  const branch = branchById(draft.street?.branch ?? BRANCHES[0]?.id);
  const edit = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setShown(null);
    setInvalid({});
  };

  const next = () => {
    if (!stepComplete(step, draft)) {
      setInvalid({
        street: step === 2 && draft.street === null,
        house: step === 2 && draft.street !== null && houseNumber(draft.house) === null,
        name: step === 5 && draft.name.trim() === '',
        mobile: step === 5 && draft.mobile.trim() !== '' && mobileDigits(draft.mobile) === null,
      });
      return;
    }
    setInvalid({});
    setShown(null);
    setStep((s) => (s < 6 ? ((s + 1) as StepNumber) : s));
  };

  const input = (date: string, windowId: string) => ({
    serviceId: draft.serviceId as string, streetId: (draft.street as Street).streetId, houseNumber: houseNumber(draft.house) as number, date, windowId, name: draft.name.trim(),
    mobile: draft.mobile.trim() === '' ? null : draft.mobile.trim(), textsOn: textsOn(draft), textLanguage: draft.textLanguage as Lang, timeZone: browserZone(),
  });

  const book = async (date: string, windowId: string) => {
    setBooking(true);
    setShown(null);
    const r = await api.book(input(date, windowId));
    setBooking(false);
    if (r.ok) {
      writeKept(null);
      router.push(`/book/done/${encodeURIComponent(r.data.bookingToken)}`);
      return;
    }
    if (r.code === 'window_full') {
      const open = ((r.detail as { open?: Nearest[] }).open ?? []).slice(0, 3);
      const filledDay = avail.kind === 'ready' ? avail.data.days.find((d) => d.date === date) : undefined;
      const w = filledDay?.windows.find((x) => x.windowId === windowId);
      const start = taken && taken.filled.date === date && taken.filled.windowId === windowId ? taken.filled.start : w?.start ?? '';
      const end = taken && taken.filled.date === date && taken.filled.windowId === windowId ? taken.filled.end : w?.end ?? '';
      setTaken((cur) => ({ filled: cur?.filled ?? { date, windowId, start, end }, options: open, picked: null }));
      setDraft((d) => ({ ...d, date, windowId: null }));
      loadDays(true);
      return;
    }
    if (r.code === 'booking_closed') {
      setTaken(null);
      setDraft((d) => ({ ...d, windowId: null }));
      setStep(3);
      setShown({ key: 'booking.err.closed', values: { day: dayShort(t, date) } });
      loadDays(true);
      return;
    }
    if (r.code === 'rule_refused') setShown({ key: 'booking.err.refused', values: { phone: branch.officePhone } });
    else if (r.code === 'validation_failed') setShown({ key: 'booking.err.invalid' });
    else setShown({ key: 'booking.err.failed' });
  };

  const on: ViewProps['on'] = {
    service: (id) => {
      if (id !== draft.serviceId) edit({ serviceId: id, windowId: null });
    },
    streetText: (value) => edit({ streetText: value, street: null, date: null, windowId: null }),
    pickStreet: (s) => {
      setStreet({ kind: 'idle' });
      edit({ street: s, streetText: `${s.name}, ${s.city} ${s.zip}`, date: null, windowId: null });
    },
    house: (value) => edit({ house: value.replace(/\D/g, '').slice(0, 5) }),
    retryStreets,
    month: (delta) => setMonth((m) => {
      const y = Number(m.slice(0, 4));
      const mo = Number(m.slice(5, 7)) - 1 + delta;
      return `${y + Math.floor(mo / 12)}-${String(((mo % 12) + 12) % 12 + 1).padStart(2, '0')}`;
    }),
    day: (date) => edit({ date, windowId: null }),
    window: (id) => edit({ windowId: id }),
    name: (value) => edit({ name: value }),
    mobile: (value) => edit({ mobile: value }),
    textsOn: (value) => edit({ textsOn: value }),
    language: (l) => edit({ textLanguage: l, languagePicked: true }),
    change: (to) => {
      setTaken(null);
      setStep(to);
      setShown(null);
    },
    next,
    back: () => {
      setShown(null);
      setStep((s) => (s > 1 ? ((s - 1) as StepNumber) : s));
    },
    confirm: () => void book(draft.date as string, draft.windowId as string),
    retryServices: loadServices,
    retryDays: () => loadDays(false),
  };

  // A restored draft lands on its first incomplete step (a stale step beyond it would show empty fields).
  useEffect(() => {
    if (restored && step > firstOpenStep(draft)) setStep(firstOpenStep(draft));
    // only when the draft is restored: later edits move the step through the buttons
  }, [restored]);

  const view: ViewProps = {
    layout, step: taken ? 4 : step, draft, services, street, avail, month: month || (today ? monthOf(today) : ''), today, phone: branch.officePhone, branchName: draft.street ? branch.name : null,
    booking, shown, invalid, on,
    taken: taken ? {
      filled: taken.filled, options: taken.options, picked: taken.picked, busy: booking,
      onPick: (key) => setTaken((c) => (c ? { ...c, picked: key } : c)),
      onBook: () => {
        const [date, windowId] = (taken.picked ?? '|').split('|') as [string, string];
        if (!date || !windowId) return;
        setDraft((d) => ({ ...d, date, windowId }));
        void book(date, windowId);
      },
      onOtherDay: () => {
        setTaken(null);
        setStep(3);
        setDraft((d) => ({ ...d, windowId: null }));
      },
    } : undefined,
  };
  return (
    <BookingFrame screen="SCR-CUS-01" branch={branch}>
      <BookingView {...view} />
    </BookingFrame>
  );
}

export type { OnlineAvailabilityAnswer };
