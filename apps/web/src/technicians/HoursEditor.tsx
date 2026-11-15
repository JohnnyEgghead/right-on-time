// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Working hours in the panel and in Add technician (UI-SPECIFICATION CTL-OFC-07-10, CTL-OFC-41-06; FR-DISP-33; MD-52). DK-92 draws the hours as text: that
// text stays the resting state, and pressing it opens this editor in place, with no Edit link (MD-52). Each weekday is Off, or a start and an end
// time; the end not after the start is a field message. A technician has 1 shift (SPECIFICATIONS section 3: `shift_start`, `shift_end`), so a time typed in
// 1 row moves every working row, and the note says so. Saturday is the `saturdays` pattern over the branch's half day (FR-BOOK-10), Sunday is always off.
import type { MessageKey } from '@bw/i18n';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { hoursText, weekProblem, withDayOff, type TechData, type TechRow, type WorkWeek } from './model.ts';

/** What makes the drawn hours open the editor: the whole list is 1 control, so its tap target is the list. Its name is the hours it shows; the hint says what a press does. */
export function opensEditor(hint: string, open?: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    title: hint,
    'aria-description': hint,
    onClick: () => open?.(),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open?.();
      }
    },
  };
}

export interface HoursEditorProps {
  week: WorkWeek;
  /** The branch's Saturday half day, shown beside the pattern. */
  saturday: TechData['saturdayHours'];
  ctl: string;
  disabled?: boolean;
  onChange?: (week: WorkWeek) => void;
}

export function HoursEditor({ week, saturday, ctl, disabled = false, onChange }: HoursEditorProps) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const problem = weekProblem(week);
  const day = (n: number) => t(`time.weekday.${n}` as MessageKey);
  // Pressing the drawn hours replaced them: the focus moves to the editor that took their place.
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[role="checkbox"]')?.focus();
  }, []);
  const toggle = (n: number, off: boolean) => { if (!disabled) onChange?.(withDayOff(week, n, !off)); };
  return (
    <>
      {problem ? <div className="r1-fmsg bw-tc-hoursmsg" role="alert"><Icon name="alert" />{t(problem === 'days' ? 'technicians.hours.noDays' : 'technicians.hours.endAfter')}</div> : null}
      <div ref={box} className="hrs bw-tc-hrsedit" role="group" aria-label={t('technicians.col.hours')} data-ctl={ctl}>
        {[1, 2, 3, 4, 5].map((n) => {
          const off = !week.days.includes(n);
          return (
            <div key={n} {...(off ? { className: 'off' } : {})}>
              <span>{day(n)}</span>
              <div className="cks bw-tc-cks0">
                <span
                  role="checkbox"
                  tabIndex={0}
                  aria-checked={off}
                  aria-label={t('technicians.hours.dayOff', { day: day(n) })}
                  {...(off ? { className: 'on' } : {})}
                  onClick={() => toggle(n, off)}
                  onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                      e.preventDefault();
                      toggle(n, off);
                    }
                  }}
                >
                  {t('technicians.hours.off')}
                </span>
              </div>
              {off ? null : (
                <>
                  <input className="r1-input" type="time" aria-label={t('technicians.hours.start', { day: day(n) })} value={week.start} disabled={disabled} onChange={(e) => onChange?.({ ...week, start: e.target.value })} />
                  <input className="r1-input" type="time" aria-label={t('technicians.hours.end', { day: day(n) })} value={week.end} disabled={disabled} onChange={(e) => onChange?.({ ...week, end: e.target.value })} />
                </>
              )}
            </div>
          );
        })}
        <div {...(week.saturdays === 'none' ? { className: 'off' } : {})}>
          <span>{day(6)}</span>
          <select className="r1-input" aria-label={t('technicians.hours.saturdays')} value={week.saturdays} disabled={disabled} onChange={(e) => onChange?.({ ...week, saturdays: e.target.value as TechRow['saturdays'] })}>
            <option value="none">{t('technicians.hours.off')}</option>
            <option value="even_weeks">{t('technicians.hours.even')}</option>
            <option value="odd_weeks">{t('technicians.hours.odd')}</option>
          </select>
          {week.saturdays !== 'none' && saturday ? <small>{hoursText(saturday.start, saturday.end)}</small> : null}
        </div>
        <div className="off"><span>{day(7)}</span><span>{t('technicians.hours.off')}</span></div>
      </div>
      <p className="r1-note bw-tc-hoursnote">{t('technicians.hours.oneShift')}</p>
    </>
  );
}
