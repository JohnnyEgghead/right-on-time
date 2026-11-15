// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The side panel of SCR-OFC-07 (frame DK-92 `aside.det`): 1 technician's details, the name in texts with its check, van, skills, the week's hours,
// time off and the 3 actions (UI-SPECIFICATION CTL-OFC-07-03 to -07-12, -07-18 to -07-20, -07-24). It draws what it is given: the live screen
// holds the draft and the check, the preview states pass them fixed. The hours rest as the frame draws them; pressing them opens HoursEditor in place (CTL-OFC-07-10, MD-52).
import type { MessageKey } from '@bw/i18n';
import { clock } from '../jobs/jobs-model.ts';
import { BRANCHES } from '../shell/branches.ts';
import { Icon } from '../shell/Icon.tsx';
import { CallButton } from '../shell/CallButton.tsx';
import { useT } from '../shell/intl.tsx';
import { formatPhone } from '../customers/model.ts';
import { HoursEditor, opensEditor } from './HoursEditor.tsx';
import {
  appWord, initials, nameMessage, type DraftEdit, sameWeek, skillWord, spanText, weekHours, weekOf, weekProblem, type NameCheckState, type SkillWords, type TechData, type TechRow, type TechSkill,
  type WorkWeek,
} from './model.ts';

export interface PanelHandlers {
  name?: (value: string) => void;
  van?: (id: string | null) => void;
  skill?: (skill: TechSkill) => void;
  hoursOpen?: () => void;
  week?: (week: WorkWeek) => void;
  cancel?: () => void;
  save?: () => void;
  close?: () => void;
  addTimeOff?: () => void;
  removeTimeOff?: (spanId: string) => void;
}

export interface PanelProps {
  row: TechRow;
  data: TechData;
  draft: DraftEdit;
  check: NameCheckState;
  saving?: boolean;
  /** CTL-OFC-07-20: the span whose Remove is being answered. */
  removing?: string | null;
  words?: SkillWords;
  /** The one-line notice under the time off list (a span another person already removed). */
  notice?: string | null;
  handlers?: PanelHandlers;
}

/** CTL-OFC-07-03, -07-04: what the name field shows beneath it. */
function CheckLine({ draft, row, check }: { draft: DraftEdit; row: TechRow; check: NameCheckState }) {
  const t = useT();
  const changed = draft.name !== row.nameInTexts;
  if (changed && check.step === 'checking') {
    return <div className="chk bw-tc-muted" role="status" data-ctl="CTL-OFC-07-04"><span className="r1-spin dark bw-tc-spin12" />{t('technicians.name.checking')}</div>;
  }
  if (changed && check.step === 'failed') {
    return <div className="chk bad" role="status" data-ctl="CTL-OFC-07-04"><Icon name="alert" />{t('technicians.name.failed')}</div>;
  }
  if (changed && check.step === 'done') {
    const m = nameMessage(check.answer, t);
    return <div className={m.ok ? 'chk' : 'chk bad'} role="status" data-ctl="CTL-OFC-07-04"><Icon name={m.ok ? 'check' : 'alert'} />{m.text}</div>;
  }
  if (changed) return <div className="chk bw-tc-muted" role="status" data-ctl="CTL-OFC-07-04" />;
  return <div className="chk" role="status" data-ctl="CTL-OFC-07-04"><Icon name="check" />{t('technicians.name.fits')}</div>;
}

export function Panel({ row, data, draft, check, saving, removing, words, notice, handlers: h = {} }: PanelProps) {
  const t = useT();
  const saved = { name: row.nameInTexts, van: row.van?.id ?? null, skills: row.skills };
  const nameChanged = draft.name !== saved.name;
  const dirty = nameChanged || draft.vanId !== saved.van || [...draft.skills].sort().join() !== [...saved.skills].sort().join() || !sameWeek(draft.week, weekOf(row));
  const noSkills = draft.skills.length === 0;
  const canSave = dirty && !saving && !noSkills && (!nameChanged || (check.step === 'done' && check.answer.ok)) && weekProblem(draft.week) === null;
  const canCancel = (dirty || draft.hoursOpen) && !saving;
  const first = row.name.split(/\s+/)[0] ?? row.name;
  const vanText = (n: string | null) => (n ? t('technicians.van', { van: n }) : t('technicians.noVan'));
  const vanNow = data.vans.find((v) => v.id === draft.vanId) ?? null;
  const chip = row.rightNow;
  const apps = (['web', 'native'] as const).flatMap((kind) => (row.apps[kind] ? [{ kind, r: row.apps[kind]! }] : []));
  return (
    <aside className="det" aria-label={row.name}>
      <div className="top">
        <span className="av">{initials(row.name)}</span>
        <div>
          <b>{row.name}</b>
          <span className="s" data-ctl="CTL-OFC-07-24">{t('technicians.tenure', { van: vanText(row.van?.number ?? null), year: row.since })}</span>
        </div>
        <button type="button" className="x" aria-label={t('board.close')} onClick={h.close}>&times;</button>
      </div>
      <div className="dsc">
        <dl className="kv" data-ctl="CTL-OFC-07-19">
          <dt>{t('technicians.col.branch')}</dt>
          <dd>{branchName(row.branch)}</dd>
          <dt>{t('technicians.det.mobile')}</dt>
          <dd className="mob">
            {formatPhone(row.phone)}
            <CallButton name={first} fullName={row.name} number={formatPhone(row.phone)} className="btn sm call"><Icon name="phone" />{t('shell.call.label', { name: first })}</CallButton>
          </dd>
          <dt>{t('technicians.det.rightNow')}</dt>
          <dd>
            {chip ? (
              <>
                <span className={`chip ${chip.status === 'on_the_way' ? 'way' : chip.status === 'on_site' ? 'site' : 'sched'} bw-tc-chip22`} data-ctl="CTL-OFC-07-22">
                  <span className="dot" />
                  {t(chip.status === 'on_the_way' ? 'status.job.onTheWay' : chip.status === 'on_site' ? 'status.job.onSite' : 'technicians.betweenJobs')}
                </span>
                {chip.timing ? <span className={`chip ${chip.timing === 'late' ? 'late' : 'risk'} bw-tc-chip22`}><span className="dot" />{t(chip.timing === 'late' ? 'status.timing.late' : 'status.timing.atRisk')}</span> : null}
                {chip.customerName ? ` ${t(chip.status === 'on_the_way' ? 'technicians.det.to' : 'technicians.det.at', { customer: chip.customerName })}` : null}
              </>
            ) : t(row.workingToday ? 'technicians.det.free' : 'technicians.det.off')}
          </dd>
          <dt>{t('technicians.det.apps')}</dt>
          <dd>
            {apps.length === 0 ? t('technicians.app.none') : apps.map(({ kind, r }) => (
              r.waitingCount > 0 ? (
                <span key={kind} className="bw-tc-appline">
                  <span className="app wait">
                    <Icon name="cloud" />
                    <span>
                      {t('technicians.det.last', { app: t(appWord(kind)), time: clock(r.lastSyncAt, t.lang), n: r.waitingCount })}
                      <small>{t('technicians.det.sent', { time: clock(r.reportedAt, t.lang) })}</small>
                    </span>
                  </span>
                  <p className="r1-note">{t('technicians.det.waitNote', { name: row.name, van: vanText(row.van?.number ?? null), n: r.waitingCount })}</p>
                </span>
              ) : (
                <span key={kind} className="bw-tc-appline">
                  {t('technicians.det.synced', { app: t(appWord(kind)), time: clock(r.lastSyncAt, t.lang) })}
                  <small>{t('technicians.det.device', { device: r.device, version: r.version })}</small>
                </span>
              )
            ))}
          </dd>
          {row.employeeNumber ? (
            <>
              <dt className="bw-tc-emp">{t('technicians.det.employee')}</dt>
              <dd className="bw-tc-emp">{row.employeeNumber}</dd>
            </>
          ) : null}
        </dl>
        <div className="g2">
          <div data-ctl="CTL-OFC-07-03">
            <label htmlFor="bw-tc-name">{t('technicians.name.label')}</label>
            <div className="inp">
              <input id="bw-tc-name" type="text" value={draft.name} autoComplete="off" spellCheck={false} onChange={(e) => h.name?.(e.target.value)} />
            </div>
            <CheckLine draft={draft} row={row} check={check} />
          </div>
          <div data-ctl="CTL-OFC-07-08">
            <label htmlFor="bw-tc-van">{t('technicians.van.label')}</label>
            <div className="inp bw-tc-pick">
              {vanText(vanNow?.number ?? null)}
              <Icon name="chevDown" />
              <select id="bw-tc-van" value={draft.vanId ?? ''} onChange={(e) => h.van?.(e.target.value === '' ? null : e.target.value)}>
                <option value="">{t('technicians.noVan')}</option>
                {data.vans.map((v) => <option key={v.id} value={v.id}>{t('technicians.van', { van: v.number })}</option>)}
              </select>
            </div>
          </div>
        </div>
        <h4>{t('technicians.col.skills')}</h4>
        <div className="cks" role="group" aria-label={t('technicians.col.skills')} data-ctl="CTL-OFC-07-09">
          {data.skills.map((s) => (
            <span
              key={s}
              role="checkbox"
              tabIndex={0}
              aria-checked={draft.skills.includes(s)}
              {...(draft.skills.includes(s) ? { className: 'on' } : {})}
              onClick={() => h.skill?.(s)}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  h.skill?.(s);
                }
              }}
            >
              {skillWord(t, s, words)}
            </span>
          ))}
        </div>
        {noSkills ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{t('technicians.skills.none')}</div> : null}
        <h4>{t('technicians.col.hours')}</h4>
        {draft.hoursOpen ? (
          <HoursEditor week={draft.week} saturday={data.saturdayHours} ctl="CTL-OFC-07-10" {...(saving !== undefined ? { disabled: saving } : {})} {...(h.week ? { onChange: h.week } : {})} />
        ) : (
          <div className="hrs" data-ctl="CTL-OFC-07-10" {...opensEditor(t('technicians.hours.change'), h.hoursOpen)}>
            {weekHours(row, data.saturdayHours, data.today).map((d) => (
              <div key={d.day} {...(d.today ? { className: 'today' } : d.text === null ? { className: 'off' } : {})}>
                <span>{t(`time.weekday.${d.day}` as MessageKey)}</span>
                <span>{d.text ?? t('technicians.hours.off')}</span>
              </div>
            ))}
          </div>
        )}
        <h4>
          {t('technicians.timeOff.title')}
          <a role="button" tabIndex={0} data-ctl="CTL-OFC-07-12" onClick={h.addTimeOff} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); h.addTimeOff?.(); } }}>{t('technicians.addTimeOff')}</a>
        </h4>
        <div className="toff" data-ctl="CTL-OFC-07-11">
          {row.timeOff.length === 0 ? <p className="r1-note bw-tc-none">{t('technicians.timeOff.none')}</p> : row.timeOff.map((o) => (
            <div key={o.id}>
              <span><b>{spanText(o.from, o.to, t)}</b>{o.note ? ` ${o.note}` : ''}</span>
              <button type="button" className={removing === o.id ? 'btn sm dis' : 'btn sm'} aria-disabled={removing === o.id || undefined} data-ctl="CTL-OFC-07-20" onClick={() => { if (removing !== o.id) h.removeTimeOff?.(o.id); }}>{t('technicians.timeOff.remove')}</button>
            </div>
          ))}
        </div>
        {notice ? <p className="r1-note bw-tc-notice" role="status">{notice}</p> : null}
      </div>
      <div className="acts">
        <a className="btn sm" href={`/office/board?branch=${row.branch}`} data-ctl="CTL-OFC-07-07"><Icon name="grid" />{t('technicians.board')}</a>
        <span className="grow" />
        <button type="button" className={canCancel ? 'btn sm' : 'btn sm dis'} aria-disabled={!canCancel || undefined} data-ctl="CTL-OFC-07-06" onClick={() => { if (canCancel) h.cancel?.(); }}>{t('common.cancel')}</button>
        {saving ? (
          <button type="button" className="btn sm busy primary" aria-busy="true" data-ctl="CTL-OFC-07-05"><span className="r1-spin" />{t('technicians.saving')}</button>
        ) : (
          <button type="button" className={canSave ? 'btn sm primary' : 'btn sm primary dis'} aria-disabled={!canSave || undefined} data-ctl="CTL-OFC-07-05" onClick={() => { if (canSave) h.save?.(); }}>{t('common.save')}</button>
        )}
      </div>
    </aside>
  );
}

const branchName = (id: string): string => BRANCHES.find((b) => b.id === id)?.name ?? id;
