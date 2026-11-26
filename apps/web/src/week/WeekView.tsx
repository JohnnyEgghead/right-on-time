// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-34 Week board, the screen below the office top bar (frame mockups/pages/office-board-week.html, DK-86; markup of its
// success frame and of its Loading, No technicians, Error and Live tiles). Technicians as rows, Monday to Saturday as columns,
// each cell the jobs booked of that day's capacity (FR-DISP-23, UC-15). Presentational: the container (WeekScreen.tsx) reads
// API-132 and keeps the event stream; the harness preview routes hand it fixed data. A read-only screen: no write path.
import './week-css.ts';
import type { MessageKey } from '@bw/i18n';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { branchById } from '../shell/branches.ts';
import { Icon } from '../shell/Icon.tsx';
import { useT, type ClientT } from '../shell/intl.tsx';
import { initials, shortName } from '../shell/OfficeTopBar.tsx';
import { ErrorPanel, LiveIndicator, type LiveState } from '../shell/Panels.tsx';
import {
  addDays, cellView, dateNumbers, dayBoardHref, fill, clockLabel, hourLabel, jobHref, joinList, percent, timeParts, tiles, weekHref, windowLabel, wireClock,
  type WeekData, type WeekDay, type WeekTech,
} from './week-model.ts';

export type WeekState = 'loading' | 'ready' | 'empty' | 'error';

export interface WeekViewProps {
  state: WeekState;
  data: WeekData | null;
  branch: string;
  /** The shown week's Monday. */
  week: string;
  liveState: LiveState;
  /** The demo time of the last read, as the page shows it ("10:28 AM"); null before the first read. */
  liveTime: string | null;
  /** Cells whose booked count the last re-read changed ("technician id|date"). */
  changed?: ReadonlySet<string>;
  /** CTL-OFC-34-01: the day the Day side opens (the day the week board came from, else the week's Monday). */
  dayFrom: string;
  onRetry?: () => Promise<unknown> | unknown;
  onRefresh?: () => void;
  /** CTL-OFC-34-15: the day's mode menu opens SCR-OFC-24 for that day on this screen (F-781). */
  onSwitchDay?: (date: string) => void;
}

const wdKey = (n: number) => `time.weekday.${n}` as MessageKey;
const moKey = (n: number) => `time.month.${n}` as MessageKey;

/** "Mon, Sep 14" / "lun, 14 de sep". */
export function dayText(t: ClientT, date: string): string {
  const n = dateNumbers(date);
  return t('week.date.short', { weekday: t(wdKey(n.weekday)), month: t(moKey(n.month)), day: n.day });
}
const dayOnlyText = (t: ClientT, date: string): string => {
  const n = dateNumbers(date);
  return t('week.date.dayOnly', { weekday: t(wdKey(n.weekday)), day: n.day });
};

/** A bar's fill. The width is set on the element after it mounts: the page's CSP (SPECIFICATIONS 11.5) refuses a style attribute in the HTML. */
function Bar({ pct, full }: { pct: number; full?: boolean }) {
  return (
    <div className="bar">
      <i
        className={full ? 'full' : ''}
        ref={(el) => {
          if (el) el.style.width = `${pct}%`;
        }}
      />
    </div>
  );
}

function Fill({ pct }: { pct: number }) {
  return (
    <i
      ref={(el) => {
        if (el) el.style.width = `${pct}%`;
      }}
    />
  );
}

export function WeekView(p: WeekViewProps) {
  const t = useT();
  const router = useRouter();
  const branch = branchById(p.branch);
  const d = p.data;
  const monday = p.week;
  const sunday = monday ? addDays(monday, 5) : '';
  const heading = (() => {
    if (!monday) return '';
    const n = dateNumbers(monday);
    return t('week.heading', { date: t('week.date.md', { month: t(moKey(n.month)), day: n.day }), year: n.year });
  })();
  const range = monday ? t('week.range', { from: dayText(t, monday), to: dayText(t, sunday) }) : '';
  const rangeText = p.liveState === 'live' && p.liveTime && monday ? t('week.rangeLive', { range, time: p.liveTime }) : range;
  const here = d ? monday <= d.today && d.today <= sunday : false;
  const thisWeek = d ? mondayContaining(d.today) : null;

  return (
    <>
      <div className="sumbar">
        <div className="datenav">
          <Link className="arrow" href={monday ? weekHref(p.branch, addDays(monday, -7)) : '#'} aria-label={t('week.prev')} data-ctl="CTL-OFC-34-02">
            <Icon name="chevLeft" />
          </Link>
          <span className="d" data-ctl="CTL-OFC-34-05">
            <b>{heading}</b>
            <span>{rangeText}</span>
          </span>
          <Link className="arrow" href={monday ? weekHref(p.branch, addDays(monday, 7)) : '#'} aria-label={t('week.next')} data-ctl="CTL-OFC-34-04">
            <Icon name="chevRight" />
          </Link>
        </div>
        <div className="tiles" data-ctl="CTL-OFC-34-13">
          {d && p.state !== 'error' ? <Tiles data={d} branchName={branch.name} /> : null}
        </div>
        {thisWeek && !here ? (
          <Link className="btn" href={weekHref(p.branch, thisWeek)} data-ctl="CTL-OFC-34-03">
            <Icon name="calendar" />
            {t('week.thisWeek')}
          </Link>
        ) : (
          <span className="btn dis" aria-disabled="true" data-ctl="CTL-OFC-34-03">
            <Icon name="calendar" />
            {t('week.thisWeek')}
          </span>
        )}
        <Link className="btn primary" href="/office/jobs/new" data-ctl="CTL-OFC-34-11">
          <Icon name="plus" />
          {t('week.newJob')}
        </Link>
      </div>

      <div className="work">
        <section className="panel boardp">
          <div className="ph">
            <h2>{t('week.technicians')}</h2>
            <span className="muted small" data-ctl="CTL-OFC-34-13">
              {d && p.state !== 'error' ? t('week.techCount', { count: d.technicians.length, branch: branch.name }) : null}
            </span>
            <div className="seg" role="radiogroup" aria-label={t('week.toggle.label')} data-ctl="CTL-OFC-34-01">
              <span
                role="radio"
                aria-checked="false"
                tabIndex={0}
                onClick={() => router.push(dayBoardHref(p.branch, p.dayFrom))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    router.push(dayBoardHref(p.branch, p.dayFrom));
                  }
                }}
              >
                {t('week.toggle.day')}
              </span>
              <span className="on" role="radio" aria-checked="true">
                {t('week.toggle.week')}
              </span>
            </div>
            <LiveIndicator state={p.liveState} {...(p.onRefresh ? { onRefresh: p.onRefresh } : {})} />
            <span className="grow" />
            <div className="lgd" data-ctl="CTL-OFC-34-12">
              <span>{t('week.legend.booked')}</span>
              <span>
                <i className="b" />
                {t('week.hasRoom')}
              </span>
              <span>
                <i className="b full" />
                {t('week.full')}
              </span>
              <span>
                <i className="b doff" />
                {t('week.dayOff')}
              </span>
              <span>
                <i className="b pkd2" />
                {t('week.legend.peak')}
              </span>
            </div>
          </div>
          {p.state === 'loading' ? (
            <div className="bw-wk-state" aria-busy="true">
              <div className="bw-wk-body">
                {[50, 0, 0, 0, 0, 0].map((w, i) => (
                  <span key={i} className={w ? `r1-skel bw-w-${w}` : 'r1-skel'} />
                ))}
              </div>
            </div>
          ) : null}
          {p.state === 'empty' ? (
            <div className="bw-wk-state">
              <div className="bw-wk-body">
                <p className="r1-note">{t('week.empty', { branch: branch.name })}</p>
              </div>
            </div>
          ) : null}
          {p.state === 'error' ? (
            <div className="bw-wk-state">
              <div className="bw-wk-body">
                <ErrorPanel title={t('week.error.title')} hint={t('week.error.hint')} onRetry={p.onRetry ?? (() => undefined)} />
              </div>
            </div>
          ) : null}
          {p.state === 'ready' && d ? <Grid data={d} branch={p.branch} changed={p.changed ?? new Set()} onSwitchDay={p.onSwitchDay} /> : null}
        </section>

        {p.state === 'ready' && d ? <Side data={d} /> : null}
      </div>
    </>
  );
}

/** The Monday of a date (the page's own week math; no device clock). */
function mondayContaining(date: string): string {
  return addDays(date, 1 - dateNumbers(date).weekday);
}

function Tiles({ data, branchName }: { data: WeekData; branchName: string }) {
  const t = useT();
  const s = tiles(data);
  const days = s.unassignedDates.length === 0 ? t('week.tile.unasNone') : s.unassignedDates.every((x) => x === data.today) ? t('week.tile.unasAllToday') : unassignedDays(t, s.unassignedDates);
  return (
    <>
      <div className="tile">
        <span className="num">{s.jobs}</span>
        <span className="lb">
          {t('week.tile.jobs')}
          <small>{t('week.tile.jobsSub', { branch: branchName })}</small>
        </span>
      </div>
      <div className="tile">
        <span className="num bw-wk-pct">{`${s.percent}%`}</span>
        <span className="lb">
          {t('week.tile.capacity')}
          <small>{t('week.tile.capacitySub', { count: s.open })}</small>
        </span>
      </div>
      <div className="tile peak">
        <span className="num">{s.peakDays}</span>
        <span className="lb">
          {t('week.tile.peak')}
          <small>{t('week.tile.peakSub')}</small>
        </span>
      </div>
      <div className="tile unas">
        <span className="num">{s.unassigned}</span>
        <span className="lb">
          {t('week.tile.unas')}
          <small>{days}</small>
        </span>
      </div>
    </>
  );
}

function unassignedDays(t: ClientT, dates: string[]): string {
  return joinList(dates.map((x) => t(wdKey(dateNumbers(x).weekday))), t.lang);
}

/** A cell's invisible whole-cell link to the day's board (the day header is the keyboard route; this one is for the pointer). */
function Hit({ branch, date }: { branch: string; date: string }) {
  return <Link className="bw-wk-hit" href={dayBoardHref(branch, date)} tabIndex={-1} aria-hidden="true" />;
}

function Grid({ data, branch, changed, onSwitchDay }: { data: WeekData; branch: string; changed: ReadonlySet<string>; onSwitchDay: ((date: string) => void) | undefined }) {
  const t = useT();
  const today = data.today;
  return (
    <div className="bw-wk-scroll">
      <div className="wk" role="group" aria-label={t('week.grid')} data-ctl="CTL-OFC-34-06">
        <div className="corner">{t('week.col.technician')}</div>
        {data.days.map((day) => (
          <DayHeader key={day.date} day={day} today={today} branch={branch} onSwitchDay={onSwitchDay} />
        ))}

        <div className="who unas" data-ctl="CTL-OFC-34-08">
          <span className="av">{data.days.reduce((n, x) => n + x.unassigned, 0)}</span>
          <div>
            <div className="nm">{t('week.unas.label')}</div>
            <div className="sub" data-ctl="CTL-OFC-34-17">
              {t('week.unas.need')}
            </div>
          </div>
        </div>
        {data.days.map((day) => (
          <div key={day.date} className="c u">
            <div className="t">
              <b>{day.unassigned}</b>
              {t('week.unas.jobs', { count: day.unassigned })}
              {day.unassigned > 0 ? (
                <Link className="tag" href={dayBoardHref(branch, day.date)} data-ctl="CTL-OFC-34-17">
                  {t('week.unas.assign')}
                </Link>
              ) : null}
            </div>
          </div>
        ))}

        {data.technicians.map((tech) => (
          <TechRow key={tech.id} tech={tech} data={data} branch={branch} changed={changed} />
        ))}

        <div className="who tot" data-ctl="CTL-OFC-34-18">
          <div>
            <div className="nm">{t('week.tot.label')}</div>
            <div className="sub">{t('week.tot.sub')}</div>
          </div>
        </div>
        {data.days.map((day) => (
          <div key={day.date} className="c tot" data-ctl="CTL-OFC-34-18">
            <div className="t">
              <b>{day.booked}</b>
              {t('week.cell.of', { capacity: day.capacity })}
              <span className="w">{`${percent(day.booked, day.capacity)}%`}</span>
            </div>
            <div className="bar">
              <Fill pct={fill(day.booked, day.capacity)} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function modeLabel(t: ClientT, day: WeekDay): string {
  if (day.span) return t('week.mode.saturday', { start: hourLabel(day.span.start), end: hourLabel(day.span.end) });
  return t(day.mode === 'four_hour' ? 'week.mode.four' : 'week.mode.two');
}

function DayHeader({ day, today, branch, onSwitchDay }: { day: WeekDay; today: string; branch: string; onSwitchDay: ((date: string) => void) | undefined }) {
  const t = useT();
  const saturday = dateNumbers(day.date).weekday === 6;
  const cls = day.peak ? ' peak' : day.date === today ? ' today' : '';
  const text = dayText(t, day.date);
  return (
    <div className={`hd${cls}`}>
      <Link className="bw-wk-day" href={dayBoardHref(branch, day.date)} data-ctl="CTL-OFC-34-07">
        <b>
          {text}
          {day.date === today ? <span className="td">{t('week.tag.today')}</span> : null}
          {day.peak ? <span className="pk">{t('week.tag.peak')}</span> : null}
        </b>
      </Link>
      <span className="wsel" data-ctl="CTL-OFC-34-14">
        {modeLabel(t, day)}
        {day.date < today ? null : saturday ? (
          <span className="wmenu dis" role="img" aria-disabled="true" aria-describedby="satwhy" title={t('week.satWhy')} aria-label={t('week.modeMenu', { day: text })} data-ctl="CTL-OFC-34-15">
            <Icon name="chevDown" />
          </span>
        ) : (
          <button type="button" className="wmenu bw-btn-reset" aria-haspopup="dialog" aria-label={t('week.modeMenu', { day: text })} data-ctl="CTL-OFC-34-15" onClick={() => onSwitchDay?.(day.date)}>
            <Icon name="chevDown" />
          </button>
        )}
      </span>
    </div>
  );
}

function TechRow({ tech, data, branch, changed }: { tech: WeekTech; data: WeekData; branch: string; changed: ReadonlySet<string> }) {
  const t = useT();
  const skill = t(`week.skill.${tech.primarySkill}` as MessageKey);
  return (
    <>
      <div className="who">
        <span className="av">{initials(tech.name)}</span>
        <div>
          <div className="nm">{tech.name}</div>
          <div className="sub">{tech.van ? t('week.tech.sub', { van: tech.van, skill }) : skill}</div>
        </div>
      </div>
      {tech.cells.map((cell, i) => {
        const day = data.days[i]!;
        const v = cellView(cell, day, data.today, tech.installer);
        const chg = changed.has(`${tech.id}|${cell.date}`) ? ' chg' : '';
        if (v.kind === 'off') {
          return (
            <div key={cell.date} className="c off">
              {t('week.dayOff')}
              <Hit branch={branch} date={cell.date} />
            </div>
          );
        }
        if (v.kind === 'install') {
          return (
            <div key={cell.date} className={`c inst${v.classes}${chg}`}>
              <div className="t" data-ctl="CTL-OFC-34-16">
                <b>{v.installs}</b>
                {t('week.cell.install', { count: v.installs })}
                <span className="w full">{t('week.cell.allDay')}</span>
              </div>
              <Bar pct={100} full />
              <Hit branch={branch} date={cell.date} />
            </div>
          );
        }
        return (
          <div key={cell.date} className={`c${v.classes}${chg}`}>
            <div className="t">
              <b>{v.booked}</b>
              {t('week.cell.of', { capacity: v.capacity })}
              <span className={v.full && v.word !== 'done' ? 'w full' : 'w'} data-ctl="CTL-OFC-34-16">
                {v.word === 'done' ? t('week.cell.done') : v.word === 'full' ? t('week.full') : t('week.cell.open', { count: v.open })}
              </span>
            </div>
            <Bar pct={fill(v.booked, v.capacity)} full={v.full} />
            <Hit branch={branch} date={cell.date} />
          </div>
        );
      })}
    </>
  );
}

function Side({ data }: { data: WeekData }) {
  const t = useT();
  const peaks = data.days.filter((x) => x.peak);
  const sat = data.days.find((x) => dateNumbers(x.date).weekday === 6);
  const weekdayCaps = data.technicians.flatMap((x) => x.cells.filter((c) => c.capacity > 0 && !x.installer && dateNumbers(c.date).weekday < 6));
  const peakCap = Math.max(0, ...weekdayCaps.filter((c) => data.days.find((x) => x.date === c.date)?.peak).map((c) => c.capacity));
  const normalCap = Math.max(0, ...weekdayCaps.filter((c) => !data.days.find((x) => x.date === c.date)?.peak).map((c) => c.capacity));
  const windows = data.fourHourWindows.map((w) => windowLabel(timeParts(w.start), timeParts(w.end))).join(', ');
  // One sentence per switch record: peak days switched together (the same reason, person and time) share the sentence of the first.
  const records = peaks.filter((x, i) => x.reason && peaks.findIndex((y) => y.reason === x.reason && y.switchedBy === x.switchedBy && y.switchedAt === x.switchedAt) === i);
  const switched = records.map((x) => {
    const when = x.switchedAt ? wireClock(x.switchedAt) : null;
    const wn = when ? dateNumbers(when.date) : null;
    return t('week.peak.switched', {
      day: dayText(t, x.date),
      reason: x.reason ?? '',
      name: x.switchedBy ? shortName(x.switchedBy) : '',
      when: when && wn ? t('shell.clock.short', { weekday: t(wdKey(wn.weekday)), month: t(moKey(wn.month)), day: wn.day, time: clockLabel(when.hour, when.minute) }) : '',
    });
  });
  const unassigned = data.unassignedJobs;
  const uDays = [...new Set(unassigned.map((j) => j.day))];
  const uText = uDays.every((x) => x === data.today) ? t('week.tile.unasAllToday') : unassignedDays(t, uDays);
  const online = data.days.filter((x) => x.date >= data.today);
  return (
    <aside className="panel bw-wk-side">
      <div className="ph">
        <h2>{t('week.thisWeek')}</h2>
      </div>
      <div className="sec" data-ctl="CTL-OFC-34-09">
        <h3>
          {t('week.peak.title')} <span className="chip test">{t('week.peak.count', { count: peaks.length })}</span>
        </h3>
        {peaks.length > 0 ? (
          <div className="pkd">
            <b>{joinList(peaks.map((x) => dayText(t, x.date)), t.lang)}</b>
            <small>{[t('week.peak.windows', { windows }), ...switched].join(' ')}</small>
          </div>
        ) : (
          <p>{t('week.peak.none')}</p>
        )}
        <p>
          {peaks.length > 0 ? `${t('week.peak.note', { peak: peakCap, normal: normalCap })} ` : ''}
          {sat ? <span id="satwhy">{t('week.satWhyNote', { day: dayText(t, sat.date) })}</span> : null}
        </p>
        <div className="bw-wk-actions">
          <Link className="btn sm" href="/office/admin/windows" data-ctl="CTL-OFC-34-10">
            <Icon name="clock" />
            {t('week.peak.switch')}
          </Link>
        </div>
      </div>
      <div className="sec ul" data-ctl="CTL-OFC-34-19">
        <h3>
          {t('week.unasPanel.title')} <span className="chip unas">{t('week.unasPanel.chip', { count: unassigned.length, days: uText })}</span>
        </h3>
        <div>
          {unassigned.length === 0 ? <p>{t('week.unasPanel.none')}</p> : null}
          {unassigned.map((j) => (
            <Link key={j.jobNumber} className="r" href={jobHref(j.jobNumber)}>
              <span className="d">
                {t(wdKey(dateNumbers(j.day).weekday))}
                <small>{windowLabel(wireClock(j.window.start), wireClock(j.window.end))}</small>
              </span>
              <span className="x">
                <b>{j.customer}</b>
                <small>{t('week.unasPanel.sub', { area: j.area, service: serviceWord(t, j.service) })}</small>
              </span>
            </Link>
          ))}
        </div>
      </div>
      <div className="sec ob" data-ctl="CTL-OFC-34-20">
        <h3>{t('week.online.title')}</h3>
        <div>
          {online.map((x) => (
            <div key={x.date} className="r">
              <span className="d">{dayOnlyText(t, x.date)}</span>
              <span className="bar">
                <Fill pct={Math.round(percent(x.booked, x.capacity))} />
              </span>
              <span className="n">{x.openOnline > 0 ? t('week.online.open', { count: x.openOnline }) : t('week.online.closed')}</span>
            </div>
          ))}
        </div>
        <p>{t('week.online.note')}</p>
      </div>
    </aside>
  );
}

function serviceWord(t: ClientT, id: string): string {
  return t(`week.service.${id}` as MessageKey);
}
