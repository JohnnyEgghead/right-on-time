// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-CUS-01 Book a visit, drawn (DK-118 on a wide screen, DK-119 on a phone; UI-SPECIFICATION CTL-CUS-01-01 to CTL-CUS-01-19). Pure: the
// state in, the page out, the handlers passed in, so the release page (BookingScreen) and the harness previews draw the same markup.
// The page's own rules are the frames' last style blocks (styles/page-booking.css, page-booking-phone.css), copied; the adaptations are
// styles/app/booking.css.
import type { OnlineAvailabilityAnswer, OnlineDay, OnlineWindow } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { Fragment, type ReactNode } from 'react';
import type { Shown } from '../job/model.ts';
import { Icon } from '../shell/Icon.tsx';
import { useT, type ClientT } from '../shell/intl.tsx';
import {
  dayName, dayShort, dayStrip, firstPickable, hasMobile, houseNumber, isFourHour, monthGrid, monthTitle, pickable, phoneText, serviceIcon,
  serviceLine, serviceWithPrice, stepComplete, textsOn, windowLabel, addressLine, addMonthsTo, dayLong, STEPS, type Cell, type Draft, type Lang, type ServiceItem,
  type StepNumber, type Street, type Nearest, optionWords, roomWords,
} from './model.ts';

export type StreetState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'results'; streets: Street[] } | { kind: 'none' } | { kind: 'error' };
export type AvailState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; data: OnlineAvailabilityAnswer } | { kind: 'error' };

/** SCR-CUS-02 Window just taken: the answer's open windows beside the page, in place of the details (CTL-CUS-02-01 to CTL-CUS-02-06). */
interface TakenProps {
  filled: { date: string; windowId: string; start: string; end: string };
  options: Nearest[];
  /** The picked option, `<date>|<windowId>`. */
  picked: string | null;
  busy: boolean;
  onPick(key: string): void;
  onBook(): void;
  onOtherDay(): void;
}

export interface ViewProps {
  layout: 'wide' | 'phone';
  taken?: TakenProps | undefined;
  step: StepNumber;
  draft: Draft;
  services: ServiceItem[] | 'loading' | 'error';
  street: StreetState;
  avail: AvailState;
  /** The calendar's month, "YYYY-MM". */
  month: string;
  today: string;
  /** The picked street's branch's office phone (the No match and No days words); the default branch's before a street is picked. */
  phone: string;
  branchName: string | null;
  booking: boolean;
  /** A refusal or note shown in the open step (booking_closed, rule_refused, validation_failed). */
  shown: Shown | null;
  /** Fields the customer tried to leave with a problem (the step's Continue was pressed). */
  invalid: { street?: boolean; house?: boolean; name?: boolean; mobile?: boolean };
  on: {
    service(id: string): void;
    streetText(text: string): void;
    pickStreet(s: Street): void;
    house(text: string): void;
    retryStreets(): void;
    month(delta: number): void;
    day(date: string): void;
    window(id: string): void;
    name(text: string): void;
    mobile(text: string): void;
    textsOn(on: boolean): void;
    language(l: Lang): void;
    change(step: StepNumber): void;
    next(): void;
    back(): void;
    confirm(): void;
    retryServices(): void;
    retryDays(): void;
  };
}

const H = {
  service: 'booking.h.service', address: 'booking.h.address', day: 'booking.h.day', windowTwo: 'booking.h.window.two', windowFour: 'booking.h.window.four', details: 'booking.h.details',
} as const satisfies Record<string, MessageKey>;
const STEP_KEYS: Record<StepNumber, { name: MessageKey; short: MessageKey }> = {
  1: { name: 'booking.step.service', short: 'booking.step.service' },
  2: { name: 'booking.step.address', short: 'booking.step.address' },
  3: { name: 'booking.step.day', short: 'booking.step.day' },
  4: { name: 'booking.step.window', short: 'booking.step.windowShort' },
  5: { name: 'booking.step.details', short: 'booking.step.detailsShort' },
  6: { name: 'booking.step.confirm', short: 'booking.step.confirm' },
};

/** CTL-CUS-01-17: the intro under the title; a picked 4-hour day says 4-hour. */
function Intro({ four }: { four: boolean }) {
  const t = useT();
  return <p data-ctl="CTL-CUS-01-17">{t(four ? 'booking.intro.four' : 'booking.intro.two')}</p>;
}

/** CTL-CUS-01-01: the step progress in the hero (wide). */
function StepsBar({ step }: { step: StepNumber }) {
  const t = useT();
  return (
    <div className="steps" data-ctl="CTL-CUS-01-01" role="group" aria-label={t('booking.progress', { n: step, name: t(STEP_KEYS[step].name) })}>
      {STEPS.map((s, i) => (
        <Fragment key={s}>
          {i > 0 ? <span className="line" /> : null}
          <span className={`step${s < step ? ' ok' : s === step ? ' cur' : ''}`} aria-current={s === step ? 'step' : undefined}>
            <span className="n">{s < step ? <Icon name="check" sw={3} /> : s}</span>
            {t(STEP_KEYS[s].name)}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

function Message({ kind, icon, children, ctl }: { kind: 'bad' | 'info'; icon: 'search' | 'calendar' | 'alert'; children: ReactNode; ctl?: string }) {
  return (
    <div className={`msg ${kind}`} role="alert" {...(ctl ? { 'data-ctl': ctl } : {})}>
      <Icon name={icon} />
      <span>{children}</span>
    </div>
  );
}

const shownText = (t: ClientT, s: Shown): string => t(s.key as MessageKey, s.values);

// --- The 5 steps' fields ------------------------------------------------------------------------------------------------------------------

function ServiceTiles({ p }: { p: ViewProps }) {
  const t = useT();
  const { services, draft } = p;
  if (services === 'error') {
    return <Message kind="bad" icon="alert">{t('booking.services.error')} <button type="button" className="bw-link" onClick={p.on.retryServices}>{t('booking.retry')}</button></Message>;
  }
  if (services === 'loading') {
    return (
      <div className="svc" aria-busy="true" role="status" aria-label={t('booking.loading')}>
        {Array.from({ length: 6 }, (_, i) => (
          <div className="tile" key={i}><span className="r1-skel bw-skel-ico" /><span className="r1-skel" /><span className="r1-skel bw-skel-60" /></div>
        ))}
      </div>
    );
  }
  return (
    <div className="svc" role="radiogroup" aria-label={t('booking.h.service')} data-ctl="CTL-CUS-01-03">
      {services.map((s) => {
        const on = draft.serviceId === s.serviceId;
        return (
          <button key={s.serviceId} type="button" role="radio" aria-checked={on} className={`tile${on ? ' sel' : ''}`} onClick={() => p.on.service(s.serviceId)}>
            {on ? <span className="tick"><Icon name="check" sw={3} /></span> : null}
            <span className="ico"><Icon name={serviceIcon(s.serviceId)} /></span>
            <b>{t(s.screenLabelKey as MessageKey)}</b>
            <span>{serviceLine(t, s)}</span>
          </button>
        );
      })}
    </div>
  );
}

function AddressFields({ p }: { p: ViewProps }) {
  const t = useT();
  const { draft, street } = p;
  const none = street.kind === 'none';
  return (
    <>
      <div className="addr2">
        <div className="f" data-ctl="CTL-CUS-01-04">
          <label htmlFor="bw-street">{t('booking.street.label')}</label>
          <div className={`in${none || p.invalid.street ? ' bad' : ''}`}>
            <Icon name="search" />
            <input
              id="bw-street" className="bw-field" type="text" autoComplete="off" role="combobox" aria-expanded={street.kind === 'results'} aria-controls="bw-street-list"
              placeholder={t('booking.street.placeholder')} value={draft.streetText} onChange={(e) => p.on.streetText(e.target.value)}
            />
          </div>
          {street.kind === 'results' ? (
            <div className="res" role="listbox" id="bw-street-list" aria-label={t('booking.street.results')}>
              {street.streets.map((s) => (
                <button key={s.streetId} type="button" role="option" aria-selected={draft.street?.streetId === s.streetId} className="bw-opt" onClick={() => p.on.pickStreet(s)}>
                  {s.name}
                  <small>{`${s.city} ${s.zip}`}</small>
                </button>
              ))}
            </div>
          ) : street.kind === 'loading' ? (
            <div className="hint" role="status">{t('booking.loading')}</div>
          ) : (
            <div className="hint">{p.branchName && draft.street ? t('booking.street.hint', { branch: p.branchName }) : t('booking.street.hintEmpty')}</div>
          )}
        </div>
        <div className="f" data-ctl="CTL-CUS-01-14">
          <label htmlFor="bw-house">{t('booking.house.label')}</label>
          <div className={`in${p.invalid.house ? ' bad' : ''}`}>
            <input id="bw-house" className="bw-field" type="text" inputMode="numeric" autoComplete="off" value={draft.house} disabled={draft.street === null}
              aria-invalid={p.invalid.house ? true : undefined} onChange={(e) => p.on.house(e.target.value)} />
          </div>
          {p.invalid.house ? <div className="hint" role="alert">{t('booking.house.bad')}</div> : null}
        </div>
      </div>
      {none ? <Message kind="bad" icon="search" ctl="CTL-CUS-01-04">{t('booking.street.none', { text: draft.streetText.trim(), phone: p.phone })}</Message> : null}
      {street.kind === 'error' ? <Message kind="bad" icon="alert">{t('booking.street.failed')} <button type="button" className="bw-link" onClick={p.on.retryStreets}>{t('booking.retry')}</button></Message> : null}
    </>
  );
}

function Calendar({ p }: { p: ViewProps }) {
  const t = useT();
  const { avail, month, today, draft } = p;
  if (avail.kind === 'loading' || avail.kind === 'idle') return <div className="r1-skel bw-skel-cal" role="status" aria-busy="true" aria-label={t('booking.loading')} />;
  if (avail.kind === 'error') {
    return <Message kind="bad" icon="alert">{t('booking.day.error')} <button type="button" className="bw-link" onClick={p.on.retryDays}>{t('booking.retry')}</button></Message>;
  }
  const days = new Map(avail.data.days.map((d) => [d.date, d] as const));
  if (firstPickable(avail.data.days) === null) return <Message kind="info" icon="calendar" ctl="CTL-CUS-01-05">{t('booking.day.none', { phone: p.phone })}</Message>;
  const cells = monthGrid(month, today, days);
  const first = addMonthsTo(today.slice(0, 7), 0);
  const last = avail.data.days.at(-1)?.date.slice(0, 7) ?? first;
  return (
    <div data-ctl="CTL-CUS-01-05">
      <div className="mh">
        <b>{monthTitle(t, month)}</b>
        <span className="arr">
          <button type="button" className="bw-arr" aria-label={t('booking.cal.prev')} disabled={month <= first} onClick={() => p.on.month(-1)}><Icon name="chevLeft" /></button>
          <button type="button" className="bw-arr" aria-label={t('booking.cal.next')} disabled={month >= last} onClick={() => p.on.month(1)}><Icon name="chevRight" /></button>
        </span>
      </div>
      <div className="grid7" role="group" aria-label={t('booking.cal.name')}>
        {([7, 1, 2, 3, 4, 5, 6] as const).map((w) => <div className="wd" key={w}>{t(`time.weekday.${w}` as MessageKey)}</div>)}
        {cells.map((c, i) => <DayCell key={c.date ?? `b${i}`} c={c} p={p} selected={c.date !== null && c.date === draft.date} />)}
      </div>
      <div className="callg"><span><i />{t('booking.cal.legendFew')}</span><span>{t('booking.cal.legendSunday')}</span></div>
    </div>
  );
}

function DayCell({ c, p, selected }: { c: Cell; p: ViewProps; selected: boolean }) {
  const t = useT();
  if (c.date === null || c.kind === null) return <div />;
  const k = c.kind;
  const cls = selected ? 'd sel' : k === 'past' ? 'd off' : k === 'today' ? 'd today' : k === 'open' ? 'd open' : k === 'few' ? 'd open few' : 'd closed';
  // The accessible name starts with the visible text (the day number, "Today") and ends with the day's word (CTL-CUS-01-19).
  const label = `${c.day}${k === 'today' ? ` ${t('booking.cal.today')}` : ''}, ${dayName(t, c.date, k)}`;
  if (!pickable(k)) {
    return (
      <button type="button" className={cls} disabled aria-label={label} {...(k === 'past' ? { 'data-ctl': 'CTL-CUS-01-19' } : {})}>
        {c.day}
        {k === 'today' ? <>{' '}<small>{t('booking.cal.today')}</small></> : null}
      </button>
    );
  }
  return (
    <button type="button" className={cls} aria-pressed={selected} aria-label={label} onClick={() => p.on.day(c.date as string)}>{c.day}</button>
  );
}

function Windows({ p, day }: { p: ViewProps; day: OnlineDay | undefined }) {
  const t = useT();
  const { draft } = p;
  const all = day?.windows ?? [];
  const full = all.length > 0 && all.every((w) => w.state === 'full');
  return (
    <>
      <div className="wins" role="radiogroup" aria-label={t('booking.window.group', { day: draft.date ? dayShort(t, draft.date) : '' })} data-ctl="CTL-CUS-01-06">
        {all.map((w) => <WindowRow key={w.windowId} w={w} on={draft.windowId === w.windowId} pick={() => p.on.window(w.windowId)} />)}
      </div>
      {full && draft.date ? <Message kind="info" icon="calendar">{t('booking.day.allFull', { day: dayShort(t, draft.date) })}</Message> : null}
    </>
  );
}

export function WindowRow({ w, on, pick }: { w: OnlineWindow; on: boolean; pick(): void }) {
  const t = useT();
  const full = w.state === 'full';
  const word = full ? t('booking.window.full') : on ? t('booking.window.selected') : w.placesLeft !== null ? t('booking.window.left', { n: w.placesLeft }) : t('booking.window.open');
  const cls = `win${full ? ' full' : on ? ' sel' : w.placesLeft !== null ? ' few' : ''}`;
  return (
    <button type="button" role="radio" aria-checked={on} aria-disabled={full ? true : undefined} disabled={full} className={cls} onClick={pick}>
      <span className="radio" />
      {windowLabel(w)}
      <span className="r">{word}</span>
    </button>
  );
}

function Details({ p }: { p: ViewProps }) {
  const t = useT();
  const { draft } = p;
  const mobile = hasMobile(draft);
  const ticked = textsOn(draft);
  return (
    <>
      <div className="demo" data-ctl="CTL-CUS-01-09"><Icon name="info" />{t('booking.demo')}</div>
      <div className="f" data-ctl="CTL-CUS-01-07">
        <label htmlFor="bw-name">{t('booking.name.label')}</label>
        <div className={`in${p.invalid.name ? ' bad' : ''}`}>
          <input id="bw-name" className="bw-field" type="text" autoComplete="off" value={draft.name} maxLength={120} aria-invalid={p.invalid.name ? true : undefined} onChange={(e) => p.on.name(e.target.value)} />
        </div>
        {p.invalid.name ? <div className="hint" role="alert">{t('booking.name.empty')}</div> : null}
      </div>
      <div className="f" data-ctl="CTL-CUS-01-08">
        <label htmlFor="bw-mobile">{t('booking.mobile.label')}</label>
        <div className={`in${p.invalid.mobile ? ' bad' : ''}`}>
          <input id="bw-mobile" className="bw-field" type="tel" inputMode="tel" autoComplete="off" value={draft.mobile} maxLength={30} aria-invalid={p.invalid.mobile ? true : undefined} onChange={(e) => p.on.mobile(e.target.value)} />
        </div>
        <div className="hint">{p.invalid.mobile ? t('booking.mobile.bad') : t('booking.mobile.hint')}</div>
      </div>
      <div className="chk">
        <button type="button" role="checkbox" aria-checked={ticked} aria-disabled={!mobile ? true : undefined} disabled={!mobile} className="bw-chk" data-ctl="CTL-CUS-01-15" onClick={() => p.on.textsOn(!ticked)} aria-label={t('booking.texts.label')}>
          <span className={`bx${ticked ? '' : ' off'}`}>{ticked ? <Icon name="check" sw={3} /> : null}</span>
        </button>
        {t('booking.texts.label')}
        <span className={`sel bw-overlay${ticked ? '' : ' dis'}`} data-ctl="CTL-CUS-01-16">
          {t(`language.name.${draft.textLanguage}` as MessageKey)}
          <Icon name="chevDown" />
          <select value={draft.textLanguage} disabled={!ticked} aria-label={t('booking.texts.language')} onChange={(e) => p.on.language(e.target.value as Lang)}>
            <option value="en">{t('language.name.en')}</option>
            <option value="es">{t('language.name.es')}</option>
          </select>
        </span>
      </div>
      {!mobile ? <div className="hint">{t('booking.texts.need')}</div> : null}
    </>
  );
}

function Summary({ p }: { p: ViewProps }) {
  const t = useT();
  const { draft, services, avail } = p;
  const svc = services !== 'loading' && services !== 'error' ? services.find((s) => s.serviceId === draft.serviceId) : undefined;
  const day = avail.kind === 'ready' ? avail.data.days.find((d) => d.date === draft.date) : undefined;
  const w = day?.windows.find((x) => x.windowId === draft.windowId);
  const house = houseNumber(draft.house);
  return (
    <div className="sum" data-ctl="CTL-CUS-01-12">
      <div className="li"><span>{t('booking.sum.service')}</span><b>{svc ? serviceWithPrice(t, svc) : ''}</b></div>
      <div className="li"><span>{t('booking.sum.day')}</span><b>{draft.date ? dayLong(t, draft.date) : ''}</b></div>
      <div className="li"><span>{t('booking.sum.arrives')}</span><b>{w ? windowLabel(w) : ''}</b></div>
      <div className="li"><span>{t('booking.sum.name')}</span><b>{draft.name.trim()}</b></div>
      <div className="li"><span>{t('booking.sum.address')}</span><b>{draft.street && house ? addressLine(house, draft.street) : ''}</b></div>
      <div className="li"><span>{t('booking.sum.texts')}</span>
        <b>{textsOn(draft) ? t('booking.sum.textsOn', { phone: phoneText(draft.mobile), language: t(`booking.language.${draft.textLanguage}` as MessageKey) }) : t('booking.sum.textsOff')}</b>
      </div>
    </div>
  );
}

function Continue({ p }: { p: ViewProps }) {
  const t = useT();
  const ok = stepComplete(p.step, p.draft);
  const why = p.step === 2 ? t('booking.street.pick') : p.step === 3 ? t('booking.day.pickFirst') : p.step === 4 ? t('booking.window.pick') : null;
  return (
    <>
      <div className="contb">
        {p.step > 1 ? <button type="button" className="k" data-ctl="CTL-CUS-01-11" onClick={p.on.back}><Icon name="chevLeft" />{t('booking.back')}</button> : null}
        <button type="button" className={`go${ok ? '' : ' dis'}`} aria-disabled={!ok ? true : undefined} data-ctl="CTL-CUS-01-10" onClick={p.on.next}>{t('booking.continue')}<Icon name="chevRight" /></button>
      </div>
      {!ok && why ? <div className="hint bw-right">{why}</div> : null}
    </>
  );
}

function Box({ n, p, title, small, children, cls }: { n: StepNumber; p: ViewProps; title: MessageKey; small?: ReactNode; children: ReactNode; cls?: string }) {
  const t = useT();
  const finished = n < p.step && !p.taken;
  return (
    <section className={cls ? `box ${cls}` : 'box'} aria-labelledby={`bw-h${n}`}>
      <h2 id={`bw-h${n}`}><span className="n">{n}</span>{t(title)}{small}{finished ? <button type="button" className="chg" data-ctl="CTL-CUS-01-02" aria-label={t('booking.change.step', { name: t(STEP_KEYS[n].name) })} onClick={() => p.on.change(n)}>{t('booking.change')}</button> : null}</h2>
      {children}
    </section>
  );
}


/** The right column of SCR-CUS-02: what happened, the nearest open windows, and what the customer has so far. */
function TakenPanel({ p, k }: { p: ViewProps; k: TakenProps }) {
  const t = useT();
  const { draft, services } = p;
  const svc = services !== 'loading' && services !== 'error' ? services.find((s) => s.serviceId === draft.serviceId) : undefined;
  const house = houseNumber(draft.house);
  const picked = k.options.find((o) => `${o.date}|${o.windowId}` === k.picked);
  const ready = picked !== undefined && !k.busy;
  return (
    <>
      <section className="alert" role="alert" data-ctl="CTL-CUS-02-01">
        <div className="t">
          <Icon name="alert" />
          <div>
            <h2>{t('booking.taken.title', { window: windowLabel(k.filled) })}</h2>
            <p>{t(k.options.length > 0 ? 'booking.taken.body' : 'booking.taken.bodyNone')}</p>
          </div>
        </div>
      </section>
      {k.options.length > 0 ? (
        <section className="box">
          <h2>{t('booking.taken.h')}</h2>
          <div className="alts" role="radiogroup" aria-label={t('booking.taken.h')} data-ctl="CTL-CUS-02-02">
            {k.options.map((o) => {
              const key = `${o.date}|${o.windowId}`;
              const on = key === k.picked;
              return (
                <button key={key} type="button" role="radio" aria-checked={on} className={`alt${on ? ' sel' : ''}`} onClick={() => k.onPick(key)}>
                  <span className="radio" />
                  <div><b>{t('booking.taken.windowLine', { day: dayShort(t, o.date), window: windowLabel(o) })}</b><small data-ctl="CTL-CUS-02-05">{optionWords(t, k.filled, o)}</small></div>
                  <span data-ctl="CTL-CUS-02-05" className={`r${o.placesLeft !== null ? ' few' : ''}`}>{roomWords(t, o)}</span>
                </button>
              );
            })}
          </div>
          <button type="button" className={`go${ready ? ' on' : ''}${k.busy ? ' busy' : ''}`} aria-disabled={!ready ? true : undefined} aria-describedby="bw-why" aria-busy={k.busy ? true : undefined} data-ctl="CTL-CUS-02-03" onClick={() => (ready ? k.onBook() : undefined)}>
            {k.busy ? <span className="r1-spin" /> : null}{k.busy ? t('booking.booking') : t('booking.taken.book')}
          </button>
          <div className="why" id="bw-why">{picked ? '' : t('booking.taken.pick')}</div>
          <button type="button" className="other" data-ctl="CTL-CUS-02-04" onClick={k.onOtherDay}><Icon name="calendar" />{t('booking.taken.otherDay')}</button>
        </section>
      ) : (
        <section className="box bw-mt-12">
          <button type="button" className="other" data-ctl="CTL-CUS-02-04" onClick={k.onOtherDay}><Icon name="calendar" />{t('booking.taken.otherDay')}</button>
        </section>
      )}
      <section className="box" data-ctl="CTL-CUS-02-06">
        <h2>{t('booking.taken.so')}<small>{t('booking.noAccount')}</small></h2>
        <div className="sum">
          <div className="li"><span>{t('booking.sum.service')}</span><b>{svc ? serviceWithPrice(t, svc) : ''}</b></div>
          <div className="li"><span>{t('booking.sum.address')}</span><b>{draft.street && house ? `${house} ${draft.street.name}, ${draft.street.city}` : ''}</b></div>
          <div className="li"><span>{t('booking.sum.day')}</span><b>{draft.date ? dayLong(t, draft.date) : ''}</b></div>
          <div className="li"><span>{t('booking.sum.arrives')}</span>{picked ? <b>{windowLabel(picked)}</b> : <b className="none">{t('booking.taken.notChosen')}</b>}</div>
        </div>
      </section>
    </>
  );
}

// --- Wide ---------------------------------------------------------------------------------------------------------------------------------

function Wide({ p }: { p: ViewProps }) {
  const t = useT();
  const { step, draft, avail } = p;
  const day = avail.kind === 'ready' ? avail.data.days.find((d) => d.date === draft.date) : undefined;
  const four = isFourHour(day);
  const message = p.shown ? <Message kind="bad" icon="alert" ctl="CTL-CUS-01-13">{shownText(t, p.shown)}</Message> : null;
  const calendar = (
    <Box n={3} p={p} title={H.day} cls="cal">
      <Calendar p={p} />
      {step === 3 && !p.taken ? <>{message}<Continue p={p} /></> : null}
    </Box>
  );
  const windows = (
    <Box n={4} p={p} title={four ? H.windowFour : H.windowTwo} small={draft.date ? <small data-ctl="CTL-CUS-01-18">{dayShort(t, draft.date)}</small> : null}>
      <Windows p={p} day={day} />
      <div className="winnote">{t('booking.window.note')}</div>
      {step === 4 && !p.taken ? <Continue p={p} /> : null}
    </Box>
  );
  return (
    <>
      <section className="hero">
        <div><h1>{t('booking.title')}</h1><Intro four={four} /></div>
        <StepsBar step={step} />
      </section>
      <div className="main">
        <div className="left">
          <Box n={1} p={p} title={H.service}><ServiceTiles p={p} />{step === 1 ? <Continue p={p} /> : null}</Box>
          {step >= 2 && !p.taken ? <Box n={2} p={p} title={H.address}><AddressFields p={p} />{step === 2 ? <Continue p={p} /> : null}</Box> : null}
          {step >= 4 ? <div className="pick">{calendar}{windows}</div> : step === 3 ? calendar : null}
        </div>
        <div className="right">
          {p.taken ? <TakenPanel p={p} k={p.taken} /> : null}
          {step >= 5 && !p.taken ? <Box n={5} p={p} title={H.details} small={<small>{t('booking.noAccount')}</small>}><Details p={p} />{step === 5 ? <Continue p={p} /> : null}</Box> : null}
          {step >= 6 && !p.taken ? (
            <section className="box" aria-labelledby="bw-h6">
              <h2 id="bw-h6"><span className="n">6</span>{t('booking.h.confirm')}</h2>
              <Summary p={p} />
              {message}
              <div className="cbtns">
                <button type="button" className="back" data-ctl="CTL-CUS-01-11" disabled={p.booking} aria-disabled={p.booking ? true : undefined} onClick={p.on.back}><Icon name="chevLeft" />{t('booking.back')}</button>
                <button type="button" className={`confirm${p.booking ? ' busy' : ''}`} data-ctl="CTL-CUS-01-13" aria-busy={p.booking ? true : undefined} disabled={p.booking} onClick={p.on.confirm}>
                  {p.booking ? <span className="r1-spin" /> : <Icon name="check" sw={2.6} />}
                  {p.booking ? t('booking.booking') : t('booking.confirm')}
                </button>
              </div>
              <div className="fine">{t(textsOn(draft) ? 'booking.fine' : 'booking.fineOff')}</div>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}

// --- Phone --------------------------------------------------------------------------------------------------------------------------------

function Phone({ p }: { p: ViewProps }) {
  const t = useT();
  const { step, draft, avail, services } = p;
  const day = avail.kind === 'ready' ? avail.data.days.find((d) => d.date === draft.date) : undefined;
  const four = isFourHour(day);
  const svc = services !== 'loading' && services !== 'error' ? services.find((s) => s.serviceId === draft.serviceId) : undefined;
  const house = houseNumber(draft.house);
  const message = p.shown ? <Message kind="bad" icon="alert" ctl="CTL-CUS-01-13">{shownText(t, p.shown)}</Message> : null;
  const days = avail.kind === 'ready' ? new Map(avail.data.days.map((d) => [d.date, d] as const)) : new Map<string, OnlineDay>();
  const stripFrom = draft.date ? (draft.date > p.today ? (draft.date > addDays1(p.today) ? addDaysBack(draft.date) : draft.date) : p.today) : p.today;
  const chosen = (label: ReactNode, to: StepNumber, name: MessageKey) => (
    <div className="chosen">
      <span className="tick"><Icon name="check" sw={3} /></span>
      <span>{label}</span>
      <button type="button" className="ch" data-ctl="CTL-CUS-01-02" aria-label={t('booking.change.step', { name: t(name) })} onClick={() => p.on.change(to)}>{t('booking.change')}</button>
    </div>
  );
  return (
    <div className="bw-ph">
      <div className="pg">
                <div className="prog" data-ctl="CTL-CUS-01-01" role="group" aria-label={t('booking.progress', { n: step, name: t(STEP_KEYS[step].name) })}>
          <div className="t"><b role="heading" aria-level={1}>{t(STEP_KEYS[step].name)}</b><span>{t('booking.progress.short', { n: step })}</span></div>
          <div className="bars">{STEPS.map((s) => <i key={s} className={s < step ? 'ok' : s === step ? 'cur' : undefined} />)}</div>
          <div className="bl">{STEPS.map((s) => <span key={s} className={s === step ? 'cur' : undefined}>{t(STEP_KEYS[s].short)}</span>)}</div>
        </div>
        {p.taken ? <div className="body"><TakenPanel p={p} k={p.taken} /></div> : null}
        {!p.taken ? (
        <div className="body">
          {step >= 3 && svc ? chosen(<><b>{t(svc.screenLabelKey as MessageKey)}</b>{`, ${t(svc.priceTextKey as MessageKey)}`}</>, 1, 'booking.step.service') : null}
          {step >= 3 && draft.street && house ? chosen(<><b>{`${house} ${draft.street.name}`}</b>{`, ${draft.street.city}`}</>, 2, 'booking.step.address') : null}
          {step === 1 ? <><h2>{t('booking.h.service')}</h2><ServiceTiles p={p} /></> : null}
          {step === 2 ? <><h2>{t('booking.h.address')}</h2><AddressFields p={p} /></> : null}
          {step === 3 ? <><h2>{t('booking.h.day')}</h2><Calendar p={p} />{message}</> : null}
          {step === 4 ? (
            <>
              <div className="days" data-ctl="CTL-CUS-01-05">
                {dayStrip(stripFrom, p.today, days).map((d) => {
                  const k = d.kind;
                  const sel = d.date === draft.date;
                  return (
                    <button key={d.date} type="button" className={`day${sel ? ' sel' : k === 'few' ? ' few' : ''}`} aria-pressed={sel} disabled={!pickable(k)} aria-label={`${t(`time.weekday.${weekdayOf(d.date)}` as MessageKey)} ${Number(d.date.slice(8, 10))}, ${dayName(t, d.date, k)}`} onClick={() => p.on.day(d.date)}>
                      <small>{t(`time.weekday.${weekdayOf(d.date)}` as MessageKey)}</small>{' '}<b>{Number(d.date.slice(8, 10))}</b>
                    </button>
                  );
                })}
              </div>
              <h2>{t(four ? 'booking.h.window.four' : 'booking.h.window.two')}{draft.date ? <small data-ctl="CTL-CUS-01-18">{dayShort(t, draft.date)}</small> : null}</h2>
              <Windows p={p} day={day} />
              <div className="note">{t('booking.window.noteShort')}</div>
            </>
          ) : null}
          {step === 5 ? <><h2>{t('booking.h.details')}<small>{t('booking.noAccount')}</small></h2><Details p={p} /></> : null}
          {step === 6 ? (
            <>
              <h2>{t('booking.h.confirm')}</h2>
              <Summary p={p} />
              {message}
              <div className="note">{t(textsOn(draft) ? 'booking.fine' : 'booking.fineOff')}</div>
            </>
          ) : null}
        </div>
        ) : null}
        {!p.taken ? (
        <div className="foot">
          {step > 1 ? <button type="button" className="back" data-ctl="CTL-CUS-01-11" disabled={p.booking} onClick={p.on.back}><Icon name="chevLeft" />{t('booking.back')}</button> : null}
          {step < 6 ? (
            <button type="button" className={`go bw-go-ph${stepComplete(step, draft) ? '' : ' dis'}`} aria-disabled={!stepComplete(step, draft) ? true : undefined} data-ctl="CTL-CUS-01-10" onClick={p.on.next}>{t('booking.continue')}<Icon name="chevRight" /></button>
          ) : (
            <button type="button" className={`go bw-go-ph${p.booking ? ' busy' : ''}`} data-ctl="CTL-CUS-01-13" aria-busy={p.booking ? true : undefined} disabled={p.booking} onClick={p.on.confirm}>
              {p.booking ? <span className="r1-spin" /> : <Icon name="check" sw={2.6} />}{p.booking ? t('booking.booking') : t('booking.confirm')}
            </button>
          )}
        </div>
        ) : null}
      </div>
    </div>
  );
}

const weekdayOf = (date: string): number => {
  const w = new Date(`${date}T00:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
};
const addDays1 = (date: string): string => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const addDaysBack = (date: string): string => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export function BookingView(p: ViewProps) {
  return p.layout === 'phone' ? <Phone p={p} /> : <Wide p={p} />;
}

