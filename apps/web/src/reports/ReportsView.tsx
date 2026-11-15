// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-11 Reports (frame mockups/pages/office-reports.html, DK-96; FR-REP-1 to FR-REP-8, NFR-06): the view takes API-50's answer and the
// page's interaction state, so the preview routes draw each state the frame shows with the frame's own data, and ReportsScreen feeds it the live
// ones. Markup and classes are the frame's, so its page-local sheet (styles/page-office-reports.css, a byte copy) styles it.
import '../shell/css/office.ts';
import '../../styles/page-office-reports.css';
import '../../styles/app/reports.css';
import type { ReactNode } from 'react';
import { OfficeFrame } from '../shell/Frames.tsx';
import { Icon } from '../shell/Icon.tsx';
import { useT, type ClientT } from '../shell/intl.tsx';
import { ErrorPanel } from '../shell/Panels.tsx';
import type { FrameData } from '../shell/frame-data.ts';
import type { Me, OfficeTopBarProps } from '../shell/OfficeTopBar.tsx';
import { BRANCHES } from '../shell/branches.ts';
import {
  isEmptyReport,
  barAxis, dayText, decimal, fallbackWeeks, fixed1, goalPct, initialsOf, linePath, meterClass, num, pct, periodSpan, rangeText, rateAxis, spanText, spreadLabels, weekEnd,
  type Filters, type Report,
} from './model.ts';

export type ReportsState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: Report };
export type ChartId = 'onTime' | 'calls' | 'noOneHome';

export interface ReportsUi {
  exporting: boolean;
  exportFailed: boolean;
  /** The charts shown as their data table (CTL-OFC-11-07). */
  tables: Record<ChartId, boolean>;
  /** The chart tip shown (CTL-OFC-11-13): its text and the chart it sits in. */
  tip: { chart: ChartId; text: string } | null;
  /** The week selects hold an inverted range (CTL-OFC-11-11). */
  weekOrder: boolean;
}

export const IDLE_UI: ReportsUi = { exporting: false, exportFailed: false, tables: { onTime: false, calls: false, noOneHome: false }, tip: null, weekOrder: false };

export interface ReportsHandlers {
  onBranch?: (id: string) => void;
  onTechnician?: (id: string) => void;
  onFrom?: (week: string) => void;
  onTo?: (week: string) => void;
  onExport?: () => void;
  onTable?: (chart: ChartId) => void;
  onTip?: (chart: ChartId, text: string | null) => void;
  onRetry?: () => void;
}

const BRANCH_NAMES: Record<string, string> = Object.fromEntries(BRANCHES.map((b) => [b.id, b.name]));
const branchName = (id: string): string => BRANCH_NAMES[id] ?? id;
const SERIES = ['bw-rp-s1', 'bw-rp-s2', 'bw-rp-s3'] as const;
const COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)'] as const;
const TEXT = '#4b5563';

/** The frame's `.sel` box with a native select over it. */
function Pick({ ctl, label, valueText, value, onChange, disabled, children }: {
  ctl?: string; label: string; valueText: string; value: string; onChange?: ((v: string) => void) | undefined; disabled?: boolean; children: ReactNode;
}) {
  return (
    <span className={disabled ? 'sel dis' : 'sel'} aria-disabled={disabled || undefined} {...(ctl ? { 'data-ctl': ctl } : {})}>
      <span className="k">{label}</span>
      <b>{valueText}</b>
      <Icon name="chevDown" />
      <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange?.(e.target.value)}>
        {children}
      </select>
    </span>
  );
}

function Sim({ tile }: { tile?: boolean }) {
  const t = useT();
  return (
    <div className={tile ? 'sim bw-rp-tilesim' : 'sim'} data-ctl="CTL-OFC-11-01">
      <span className="chip test">{t('reports.label.simulated')}</span>
      <span>{t('reports.label.explain')}</span>
    </div>
  );
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="bw-rp-skel-rows" role="status">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className={i === 0 ? 'r1-skel bw-rp-skel' : 'r1-skel'} />
      ))}
    </div>
  );
}

const text = (x: number, y: number, t: string, anchor: 'start' | 'middle' | 'end' = 'middle', size = 12, weight = 500, fill = TEXT, ctl?: string) => (
  <text key={`${x}-${y}-${t}`} x={x} y={y} textAnchor={anchor} fontSize={size} fontWeight={weight} fill={fill} {...(ctl ? { 'data-ctl': ctl } : {})}>{t}</text>
);

/** Every other week label when the weeks are many, counted back from the last, so labels do not overlap. */
const labelled = (i: number, n: number, max: number): boolean => n <= max || (n - 1 - i) % 2 === 0;

/** F-1597: how far (in the chart's own units) a pointer can be from a mark and still reach it. */
const NEAR = 9;

function LineChart({ d, on, t }: { d: Report; on: ReportsHandlers; t: ClientT }) {
  const lang = t.lang;
  const W = 820, H = 236, L = 44, R = 136, Tp = 12, B = 26;
  const n = d.weeks.length;
  const axis = rateAxis(d.onTime.flatMap((l) => l.points.map((p) => p.rate)));
  const x = (i: number) => (n === 1 ? L + (W - L - R) / 2 : L + ((W - L - R) * i) / (n - 1));
  const y = (v: number) => Tp + (H - Tp - B) * (1 - (v - axis.lo) / (axis.hi - axis.lo));
  const before = periodSpan(d.weeks, d.periods.before);
  const after = periodSpan(d.weeks, d.periods.after);
  const mid = before && after ? (x(before.last) + x(after.first)) / 2 : null;
  const span = (s: { first: number; last: number }) => rangeText(d.weeks[s.first]!, d.weeks[s.last]!, t);
  const goal = t(d.goals.onTime.labelKey, { goal: goalPct(d.goals.onTime.rate, lang) });
  const alt = t('reports.chart.onTime.alt', {
    periods: before && after ? t('reports.chart.periods', { before: span(before), after: span(after) }) : '',
    goal,
  }).replace(/\s+\./, '.').replace(/ {2,}/g, ' ');
  // F-1597: 2 lines' marks can end a few px apart, and the one drawn later covers the other, so the pointer never reached the covered one
  // from its own element. The chart takes the pointer itself: the mark nearest to it (within NEAR) opens its tip. Focus still opens a mark's own.
  const marks = d.onTime.flatMap((line) =>
    line.points.flatMap((p, i) => (p.rate === null ? [] : [{ cx: x(i), cy: y(p.rate), text: t('reports.tip.branchWeek', { branch: branchName(line.branch), week: dayText(p.week, t), value: pct(p.rate, lang, t) }) }])),
  );
  const nearest = (e: { clientX: number; clientY: number; currentTarget: SVGSVGElement }) => {
    const m = e.currentTarget.getScreenCTM();
    if (!m) return;
    const at = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    let best: (typeof marks)[number] | null = null;
    let bestD = NEAR * NEAR;
    for (const k of marks) {
      const dd = (k.cx - at.x) ** 2 + (k.cy - at.y) ** 2;
      if (dd < bestD) { best = k; bestD = dd; }
    }
    if (best) on.onTip?.('onTime', best.text);
  };
  const tip = (text: string) => ({
    tabIndex: 0, role: 'img', 'aria-label': text, 'data-ctl': 'CTL-OFC-11-13',
    onFocus: () => on.onTip?.('onTime', text), onBlur: () => on.onTip?.('onTime', null),
  });
  const ends = spreadLabels(
    d.onTime.flatMap((line, k) => {
      const last = line.points[n - 1];
      return last && last.rate !== null ? [{ key: `${k}`, y: y(last.rate) + 4 }] : [];
    }),
  );
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={alt} data-ctl="CTL-OFC-11-06" onMouseMove={nearest}>
      {mid !== null && before && after ? (
        <>
          <rect x={L} y={Tp} width={mid - L} height={H - Tp - B} fill="var(--ink-100)" />
          <line x1={mid} x2={mid} y1={Tp} y2={H - B} stroke="#616774" strokeWidth="1.5" strokeDasharray="3 3" />
          {text((L + mid) / 2, Tp + 14, t('reports.chart.before', { range: span(before) }), 'middle', 12, 650, '#374151')}
          {text((mid + x(n - 1)) / 2, Tp + 14, t('reports.chart.after', { range: span(after) }), 'middle', 12, 650, '#374151')}
          {text(mid + 4, H - B - 6, t('reports.chart.pilotStarts'), 'start', 11, 600, '#4b5563')}
        </>
      ) : null}
      {axis.ticks.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R + 10} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
          {text(L - 8, y(v) + 4, `${v}%`, 'end', 12)}
        </g>
      ))}
      {d.weeks.map((w, i) => (labelled(i, n, 8) ? text(x(i), H - 8, dayText(w, t), 'middle', 12) : null))}
      <line x1={L} x2={W - R + 10} y1={y(d.goals.onTime.rate)} y2={y(d.goals.onTime.rate)} stroke="#111827" strokeWidth="1.5" strokeDasharray="5 4" />
      {text(L + 6, y(d.goals.onTime.rate) - 6, goal, 'start', 12, 650, '#111827')}
      {d.onTime.map((line, k) => (
        <g key={line.branch}>
          <path d={linePath(line.points.map((p, i) => ({ x: x(i), y: p.rate === null ? null : y(p.rate) })))} fill="none" stroke={COLORS[k % 3]} strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" />
          {line.points.map((p, i) =>
            p.rate === null ? null : (
              <circle key={p.week} cx={x(i)} cy={y(p.rate)} r="4" fill={COLORS[k % 3]} stroke="#fff" strokeWidth="2" {...tip(t('reports.tip.branchWeek', { branch: branchName(line.branch), week: dayText(p.week, t), value: pct(p.rate, lang, t) }))} />
            ),
          )}
        </g>
      ))}
      {ends.map((e) => {
        const line = d.onTime[Number(e.key)]!;
        const last = line.points[n - 1]!;
        return text(W - R + 16, e.y, `${branchName(line.branch)} ${fixed1(last.rate, lang, t)}`, 'start', 12.5, 600, '#1f2937', 'CTL-OFC-11-14');
      })}
    </svg>
  );
}

function BarChart({ chart, label, weeks, values, fmt, goal, left, on, t }: {
  chart: ChartId; label: string; weeks: readonly string[]; values: readonly (number | null)[]; fmt: (v: number) => string; goal?: number; left: number; on: ReportsHandlers; t: ClientT;
}) {
  const W = 488, H = 222, R = 10, Tp = 16, B = 26;
  const n = weeks.length;
  const axis = barAxis(Math.max(goal ?? 0, ...values.map((v) => v ?? 0)));
  const bw = (W - left - R) / n;
  const y = (v: number) => Tp + (H - Tp - B) * (1 - v / axis.top);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} data-ctl={chart === 'calls' ? 'CTL-OFC-11-08' : 'CTL-OFC-11-09'}>
      {axis.ticks.map((v) => (
        <g key={v}>
          <line x1={left} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
          {text(left - 8, y(v) + 4, fmt(v), 'end', 12)}
        </g>
      ))}
      {values.map((v, i) => {
        const x = left + bw * i + bw * 0.18;
        const w = bw * 0.64;
        const last = i === n - 1;
        const value = v ?? 0;
        const top = y(value);
        const base = y(0);
        const tipText = t('reports.tip.week', { week: dayText(weeks[i]!, t), value: v === null ? t('reports.value.none') : fmt(v) });
        return (
          <g key={weeks[i]}>
            <path
              d={`M${x} ${base} V${top + 4} Q${x} ${top} ${x + 4} ${top} H${x + w - 4} Q${x + w} ${top} ${x + w} ${top + 4} V${base} Z`}
              fill="var(--bar)" {...(last ? {} : { fillOpacity: '.55' })} tabIndex={0} role="img" aria-label={tipText} data-ctl="CTL-OFC-11-13"
              onMouseEnter={() => on.onTip?.(chart, tipText)} onFocus={() => on.onTip?.(chart, tipText)} onBlur={() => on.onTip?.(chart, null)}
            />
            {labelled(i, n, 8) ? text(x + w / 2, H - 8, dayText(weeks[i]!, t), 'middle', 11.5) : null}
            {last && v !== null ? text(x + w / 2, top - 6, fmt(v), 'middle', 12, 650, '#1f2937', 'CTL-OFC-11-14') : null}
          </g>
        );
      })}
      {goal !== undefined ? <line x1={left} x2={W - R} y1={y(goal)} y2={y(goal)} stroke="#111827" strokeWidth="1.5" strokeDasharray="5 4" /> : null}
      <line x1={left} x2={W - R} y1={y(0)} y2={y(0)} stroke="#838c9b" />
    </svg>
  );
}

/** A chart's data table: the screen-reader view (CTL-OFC-11-07), with the goal line repeated (FR-REP-6). */
function DataTable({ head, rows, goal, shown }: { head: string[]; rows: string[][]; goal?: string; shown: boolean }) {
  // Always in the page: shown on request (CTL-OFC-11-07) and, on a phone, in place of the chart (reports.css).
  return (
    <div className={shown ? 'bw-rp-scroll bw-rp-dt on' : 'bw-rp-scroll bw-rp-dt'}>
      <table className="t">
        {goal ? <caption>{goal}</caption> : null}
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} className={i === 0 ? undefined : 'r'}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]}>
              {r.map((c, i) => (
                <td key={i} className={i === 0 ? undefined : 'r'}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableToggle({ chart, ui, on }: { chart: ChartId; ui: ReportsUi; on: ReportsHandlers }) {
  const t = useT();
  return (
    <span
      className="tbt" role="button" tabIndex={0} aria-pressed={ui.tables[chart]} data-ctl="CTL-OFC-11-07" onClick={() => on.onTable?.(chart)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          on.onTable?.(chart);
        }
      }}
    >
      {ui.tables[chart] ? t('reports.chart.showChart') : t('reports.chart.showTable')}
    </span>
  );
}

/** The chart's panel. A tip opens on a point or bar and stays until the pointer leaves the panel, which holds the tip, so the pointer can reach it from any mark (CTL-OFC-11-13). */
function ChartPanel({ chart, on, children }: { chart: ChartId; on: ReportsHandlers; children: ReactNode }) {
  return <div className="panel" onMouseLeave={() => on.onTip?.(chart, null)}>{children}</div>;
}

function Tip({ ui, chart }: { ui: ReportsUi; chart: ChartId }) {
  return ui.tip && ui.tip.chart === chart ? (
    <div className="r1-pop in bw-rp-tip" role="tooltip" data-ctl="CTL-OFC-11-13">{ui.tip.text}</div>
  ) : null;
}

export function ReportsBody({ state, filters, ui, on }: { state: ReportsState; filters: Filters; ui: ReportsUi; on: ReportsHandlers }) {
  const t = useT();
  const lang = t.lang;
  const d = state.kind === 'ready' ? state.data : null;
  // F-741: the week selects stay on Loading and Error, on weeks made from the address.
  const weeks = d ? d.choices.weeks : fallbackWeeks(filters);
  const fromWeek = filters.from || (d ? d.fromWeek : (weeks[0] as string));
  const toWeek = filters.to || (d ? d.toWeek : (weeks.at(-1) as string));

  const scope = filters.branch === 'all' ? t('reports.filter.allBranches') : branchName(filters.branch);
  const header = (
    <div className="rh">
      <div>
        <h1>{t('reports.title')}</h1>
        <Sim />
      </div>
      <div className="filters">
        <Pick ctl="CTL-OFC-11-02" label={t('reports.filter.branch')} valueText={scope} value={filters.branch} onChange={on.onBranch}>
          <option value="all">{t('reports.filter.allBranches')}</option>
          {BRANCHES.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </Pick>
        <span className="wks" data-ctl="CTL-OFC-11-11">
          <Pick label={t('reports.filter.from')} valueText={dayText(fromWeek, t)} value={fromWeek} onChange={on.onFrom}>
            {weeks.map((w) => (
              <option key={w} value={w}>{dayText(w, t)}</option>
            ))}
          </Pick>
          <Pick label={t('reports.filter.to')} valueText={dayText(weekEnd(toWeek), t)} value={toWeek} onChange={on.onTo}>
            {weeks.map((w) => (
              <option key={w} value={w}>{dayText(weekEnd(w), t)}</option>
            ))}
          </Pick>
        </span>
        <Pick
          ctl="CTL-OFC-11-03" label={t('reports.filter.technician')} disabled={filters.branch === 'all'}
          valueText={d && filters.technician !== 'all' ? (d.choices.technicians.find((x) => x.id === filters.technician)?.name ?? t('reports.filter.allTechnicians')) : t('reports.filter.allTechnicians')}
          value={filters.technician} onChange={on.onTechnician}
        >
          <option value="all">{t('reports.filter.allTechnicians')}</option>
          {(d?.choices.technicians ?? []).map((x) => (
            <option key={x.id} value={x.id}>{x.name}</option>
          ))}
        </Pick>
        {ui.exporting ? (
          <button type="button" className="btn busy primary bw-rp-export" aria-busy="true" aria-disabled="true" data-ctl="CTL-OFC-11-04">
            <span className="r1-spin" />
            {t('reports.exporting')}
          </button>
        ) : (
          <button type="button" className="btn primary bw-rp-export" data-ctl="CTL-OFC-11-04" disabled={!d || ui.weekOrder} onClick={on.onExport}>
            <Icon name="sheet" />
            {t('reports.export')}
          </button>
        )}
        {ui.weekOrder ? (
          <div className="r1-fmsg bw-rp-fmsg" role="alert">
            <Icon name="alert" />
            {t('reports.filter.weekOrder')}
          </div>
        ) : null}
        {ui.exportFailed ? (
          <div className="r1-fmsg bw-rp-fmsg" role="alert">
            <Icon name="alert" />
            {t('reports.exportFailed')}
          </div>
        ) : null}
      </div>
    </div>
  );

  if (state.kind === 'loading') {
    return (
      <div className="viz-root">
        {header}
        <div className="bw-rp-state">
          <Skeleton rows={5} />
        </div>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="viz-root">
        {header}
        <div className="bw-rp-state">
          <ErrorPanel title={t('reports.error.title')} hint={t('reports.error.hint')} onRetry={() => on.onRetry?.()} />
        </div>
      </div>
    );
  }
  const r = state.data;
  if (isEmptyReport(r)) {
    return (
      <div className="viz-root">
        {header}
        <div className="bw-rp-state">
          <p className="r1-note bw-rp-note">{t('reports.empty')}</p>
        </div>
      </div>
    );
  }

  const h = r.headline;
  const lastWeek = dayText(h.week, t);
  const callsScope = r.branch === 'all' ? t('reports.scope.all') : branchName(r.branch);
  const none = t('reports.value.none');
  const onTimeLines = r.onTime;

  return (
    <div className="viz-root">
      {header}
      <div className="wrap">
        <div className="kpis" data-ctl="CTL-OFC-11-05">
          <div className="kpi">
            <div className="l">{t('reports.kpi.onTime', { week: lastWeek })}</div>
            <div className="v bw-rp-teal">{pct(h.onTime.rate, lang, t)}</div>
            <div className="s">{t('reports.kpi.onTimeSub', { goal: goalPct(r.goals.onTime.rate, lang), before: pct(h.onTime.before, lang, t), after: pct(h.onTime.after, lang, t) })}</div>
          </div>
          <div className="kpi">
            <div className="l">{t('reports.kpi.calls')}</div>
            <div className="v">{num(h.calls.count, lang, t)}</div>
            <div className="s">
              {t(h.calls.perDay === null ? 'reports.kpi.callsSubNoDays' : 'reports.kpi.callsSub', { perDay: h.calls.perDay === null ? none : num(h.calls.perDay, lang, t), before: num(h.calls.before, lang, t), after: num(h.calls.after, lang, t) })}
            </div>
          </div>
          <div className="kpi">
            <div className="l">{t('reports.kpi.noOneHome')}</div>
            <div className="v">{pct(h.noOneHome.rate, lang, t)}</div>
            <div className="s">
              <span data-ctl="CTL-OFC-11-17">{t('reports.kpi.noOneHomeCount', { count: num(h.noOneHome.count, lang, t), visits: num(h.noOneHome.visits, lang, t), goal: goalPct(r.goals.noOneHome.rate, lang) })}</span>
              {` ${t('reports.kpi.noOneHomeSub', { before: pct(h.noOneHome.before, lang, t), after: pct(h.noOneHome.after, lang, t) })}`}
            </div>
          </div>
          <div className="kpi" data-ctl="CTL-OFC-11-12">
            <div className="l">{t('reports.kpi.lateTexts')}</div>
            <div className="v">{num(h.lateTexts, lang, t)}</div>
            <div className="s">{t('reports.kpi.lateTextsSub')}</div>
          </div>
        </div>

        <div className="grid">
          <div className="col">
            <ChartPanel chart="onTime" on={on}>
              <div className="ph">
                <h3>{t('reports.chart.onTime.title')}</h3>
                <span data-ctl="CTL-OFC-11-15">{t('reports.chart.onTime.sub')}</span>
                <div className="lg">
                  {onTimeLines.map((line, k) => (
                    <span key={line.branch}>
                      <i className={SERIES[k % 3]} />
                      {branchName(line.branch)}
                    </span>
                  ))}
                  <TableToggle chart="onTime" ui={ui} on={on} />
                </div>
              </div>
              <Tip ui={ui} chart="onTime" />
              {ui.tables.onTime ? null : <LineChart d={r} on={on} t={t} />}
              <DataTable
                shown={ui.tables.onTime}
                head={[t('reports.data.week'), ...onTimeLines.map((l) => branchName(l.branch))]}
                rows={r.weeks.map((w, i) => [dayText(w, t), ...onTimeLines.map((l) => pct(l.points[i]!.rate, lang, t))])}
                goal={t(r.goals.onTime.labelKey, { goal: goalPct(r.goals.onTime.rate, lang) })}
              />
            </ChartPanel>
            <div className="panel bw-rp-flush">
              <div className="ph">
                <h3 data-ctl="CTL-OFC-11-16">{t('reports.table.title', { scope, range: spanText(r.fromWeek, r.toWeek, t) })}</h3>
                <span>{t('reports.table.sorted')}</span>
              </div>
              <div className="bw-rp-scroll">
                <table className="t" data-ctl="CTL-OFC-11-10">
                  <thead>
                    <tr>
                      <th>{t('reports.table.technician')}</th>
                      <th className="r">{t('reports.table.visits')}</th>
                      <th>{t('reports.table.onTime')}</th>
                      <th className="r">{t('reports.table.minutesLate')}</th>
                      <th className="r">{t('reports.table.noOneHome')}</th>
                      <th className="r">{t('reports.table.calls')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.technicians.map((x) => (
                      <tr key={x.technicianId ?? x.name}>
                        <td>
                          <span className="who">
                            <span className="av">{initialsOf(x.name)}</span>
                            {x.name}
                          </span>
                        </td>
                        <td className="r">{num(x.visits, lang, t)}</td>
                        <td>
                          {pct(x.onTimeRate, lang, t)}
                          <span className="meter">
                            <i className={meterClass(x.onTimeRate)} />
                          </span>
                        </td>
                        <td className="r">{x.averageMinutesLate === null ? none : decimal(x.averageMinutesLate, lang)}</td>
                        <td className="r">{num(x.noOneHome, lang, t)}</td>
                        <td className="r">{num(x.calls, lang, t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div className="col">
            <ChartPanel chart="calls" on={on}>
              <div className="ph">
                <h3>{t('reports.chart.calls.title')}</h3>
                <span data-ctl="CTL-OFC-11-15">{t('reports.chart.calls.sub', { scope: callsScope })}</span>
                <TableToggle chart="calls" ui={ui} on={on} />
              </div>
              <Tip ui={ui} chart="calls" />
              {ui.tables.calls ? null : (
                <BarChart chart="calls" label={t('reports.chart.calls.alt')} weeks={r.weeks} values={r.calls.map((c) => c.calls)} fmt={(v) => num(v, lang, t)} left={46} on={on} t={t} />
              )}
              <DataTable
                shown={ui.tables.calls}
                head={[t('reports.data.week'), t('reports.chart.calls.title'), t('reports.data.perDay')]}
                rows={r.calls.map((c) => [dayText(c.week, t), num(c.calls, lang, t), num(c.perDay, lang, t)])}
              />
            </ChartPanel>
            <ChartPanel chart="noOneHome" on={on}>
              <div className="ph">
                <h3>{t('reports.chart.noOneHome.title')}</h3>
                <span data-ctl="CTL-OFC-11-15">{t('reports.chart.noOneHome.sub')}</span>
                <div className="lg">
                  <span>
                    <i className="bw-rp-goal" />
                    {t(r.goals.noOneHome.labelKey, { goal: goalPct(r.goals.noOneHome.rate, lang) })}
                  </span>
                </div>
                <TableToggle chart="noOneHome" ui={ui} on={on} />
              </div>
              <Tip ui={ui} chart="noOneHome" />
              {ui.tables.noOneHome ? null : (
                <BarChart
                  chart="noOneHome" label={t('reports.chart.noOneHome.alt', { goal: t(r.goals.noOneHome.labelKey, { goal: goalPct(r.goals.noOneHome.rate, lang) }) })}
                  weeks={r.weeks} values={r.noOneHome.map((w) => w.rate)} fmt={(v) => `${decimal(v, lang)}%`} goal={r.goals.noOneHome.rate} left={40} on={on} t={t}
                />
              )}
              <DataTable
                shown={ui.tables.noOneHome}
                head={[t('reports.data.week'), t('reports.kpi.noOneHome'), t('reports.data.visits')]}
                rows={r.noOneHome.map((w) => [dayText(w.week, t), pct(w.rate, lang, t), `${num(w.count, lang, t)} / ${num(w.visits, lang, t)}`])}
                goal={t(r.goals.noOneHome.labelKey, { goal: goalPct(r.goals.noOneHome.rate, lang) })}
              />
            </ChartPanel>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The office frame around the body: demo strip, top bar, footer. `frame` is a preview's fixed chrome. */
export function ReportsView({ state, filters, ui, on, frame }: { state: ReportsState; filters: Filters; ui: ReportsUi; on: ReportsHandlers; frame?: Omit<FrameData, 'screen' | 'children'> & { me?: Me; bar?: Omit<OfficeTopBarProps, 'me'> } }) {
  return (
    <OfficeFrame screen="SCR-OFC-11" bar={{ currentPath: '/office/reports' }} {...(frame ?? {})}>
      <ReportsBody state={state} filters={filters} ui={ui} on={on} />
    </OfficeFrame>
  );
}
