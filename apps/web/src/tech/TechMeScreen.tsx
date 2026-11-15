// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-TEC-10 Me (UI-SPECIFICATION 2.3; DK-114 mockups/pages/tech-me.html; FR-TECH-15, FR-LANG-1, FR-TECH-4, FR-TECH-7, FR-DISP-20): who is
// signed in, the van with no stock-checked line, today's hours (the day's start, hours on the clock by the demo clock and jobs done, the
// phone's own statuses counted at once, UD-51), Sync with Send now, Call dispatch, the Notifications and Text size settings kept on the
// phone (UD-43), the language, the app version and Sign out, which is refused while items wait (UD-20).
import '../shell/css/phone.ts';
import '../../styles/page-tech-me.css';
import { clockOfWire, type MessageKey } from '@bw/i18n';

import { useRouter } from 'next/navigation';
import { useState, type KeyboardEvent } from 'react';
import { branchById } from '../shell/branches.ts';
import { CallButton } from '../shell/CallButton.tsx';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { LanguageSwitch } from '../shell/LanguageSwitch.tsx';
import { createReader } from '../shell/reads.ts';
import { techReads, useTechData, type TechData } from './data.ts';
import type { OutboxState } from './engine.ts';
import { forgetPerson } from './local.ts';
import { jobsDone, minutesOnClock, startOfDay, TEXT_SIZES } from './model.ts';
import { endSession, forgetShell } from './session.ts';
import { WAITING_HREF, NoSignalCard } from './SyncStrip.tsx';
import { TechAppFrame } from './TechAppFrame.tsx';
import { ownItems, techOutbox, useOutbox } from './useOutbox.ts';
import { dateText, durationText, ENDING_KINDS, phoneStart, SIZE_KEY } from './view-model.ts';
import { APP_VERSION } from './version.ts';

export type SignOutPhase = 'idle' | 'refused' | 'signing';

export interface TechMeScreenProps {
  fixedData?: TechData;
  fixedOutbox?: OutboxState;
  /** A preview's sign-out phase and open text-size list. */
  fixedPhase?: SignOutPhase;
  fixedSizeOpen?: boolean;
}

export function TechMeScreen({ fixedData, fixedOutbox, fixedPhase, fixedSizeOpen }: TechMeScreenProps) {
  const t = useT();
  const router = useRouter();
  const data = useTechData(fixedData);
  const outbox = useOutbox(fixedOutbox);
  const [phase, setPhase] = useState<SignOutPhase>(fixedPhase ?? 'idle');
  const [sizeOpen, setSizeOpen] = useState(fixedSizeOpen ?? false);
  // Reading the phone (rule 12, F-1434): until the page has read the kept copy, a skeleton stands in for every value it feeds, never No van assigned, Not started yet, 0 of 0 or All synced.
  const reading = data.reading === true;
  const skel = (cls = '') => <span className={cls === '' ? 'r1-skel' : `r1-skel ${cls}`} aria-hidden="true" />;
  const day = data.day?.data ?? null;
  const stops = data.route?.data.stops ?? [];
  const offline = !outbox.online || !data.online;
  const waiting = outbox.waiting;
  const own = ownItems(waiting, outbox.userId); // F-1033: the person's day is read from the person's own items; the sign-out guard counts every item

  // Today's hours: the server's start, or the phone's own first action until the server's arrives (OI-40).
  const started = startOfDay(day?.startedAt ?? null, phoneStart(own, day?.date ?? null));
  const onClock = started && data.now ? minutesOnClock(started, data.now) : null;
  const endedHere = new Set(own.filter((i) => ENDING_KINDS.has(i.kind)).map((i) => i.jobNumber));
  const done = jobsDone(stops.map((s) => ({ state: endedHere.has(s.jobNumber) ? ('done' as const) : s.state })));
  const branch = branchById(day?.technician.branch).name;
  const skill = day?.technician.skill;
  const skillKey = skill ? (`tech.me.skill.${skill}` as MessageKey) : null;
  const roleLine = skillKey && t(skillKey) !== skillKey ? t('tech.me.role', { skill: t(skillKey) }) : t('tech.me.roleOnly');
  const branchLine = day?.technician.employeeNumber ? t('tech.me.branch', { branch, number: day.technician.employeeNumber }) : t('tech.me.branchOnly', { branch });
  const n = waiting.length;
  const fixed = fixedOutbox ? { fixed: fixedOutbox } : {};

  const signOut = async () => {
    // UD-20: refused while anything waits to send; the items stay.
    if (n > 0) {
      setPhase('refused');
      return;
    }
    setPhase('signing');
    // API-06 clears the httpOnly session cookie in its answer, on every outcome (F-230); offline with nothing waiting, the phone's own copies
    // go anyway and the sign-in page opens, and the sign-out stays owed until API-06 answers (F-1004, SignOutGate.tsx). F-937: the
    // technician worker drops the /tech pages it kept.
    const reader = createReader({ baseUrl: window.location.origin });
    await endSession(() => reader.read('API-06'));
    await forgetPerson();
    techReads().clear();
    await forgetShell();
    window.location.assign('/tech/sign-in');
  };
  const key = (fn: () => void) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };
  const sendNow = () => {
    if (!offline && n > 0) void techOutbox().sync();
  };

  return (
    <TechAppFrame
      screen="SCR-TEC-10"
      tab="me"
      {...(fixedData ? { data: fixedData } : {})}
      {...(fixedOutbox ? { fixed: fixedOutbox, reader: false as const, clock: null } : {})}
      header={(
        <div className="apphead">
          <div className="prof" data-ctl="CTL-TEC-10-01">
            <span className="av">{reading ? null : (day?.technician.initials ?? '')}</span>
            <div>
              <h1 translate="no">{reading ? skel('bw-skel-70') : (day?.technician.name ?? '')}</h1>
              <div className="d">{reading ? skel('bw-skel-40') : day ? <>{roleLine}<br />{branchLine}</> : null}</div>
            </div>
          </div>
        </div>
      )}
    >
      <div className="body">
        {offline ? <NoSignalCard {...fixed} /> : null}
        <div className="card">
          <div className="ch"><h3>{t('tech.me.van')}</h3></div>
          <div className="van" data-ctl="CTL-TEC-10-06">
            <span className="ico"><Icon name="truck" sw={2} /></span>
            <div>
              <b>{reading ? skel('bw-skel-70') : day?.van ? t('tech.me.vanNumber', { number: day.van.number }) : t('tech.me.noVan')}</b>
              {!reading && day?.van ? <small>{day.van.vehicle}</small> : null}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="ch"><h3>{offline && data.day ? t('tech.me.hoursSaved', { time: clockOfWire(data.day.at) }) : t('tech.me.hours', { date: day ? dateText(t, day.date) : '' })}</h3></div>
          <div className="hours" data-ctl="CTL-TEC-10-07" {...(reading ? { 'aria-busy': true } : {})}>
            {reading ? (
              <>{skel('bw-skel-70')}{skel('bw-skel-70')}{skel('bw-skel-40')}</>
            ) : started ? (
              <>
                <div><b>{clockOfWire(started)}</b><small>{t('tech.me.started')}</small></div>
                <div><b>{onClock === null ? '' : durationText(t, onClock)}</b><small>{t('tech.me.onClock')}</small></div>
              </>
            ) : (
              <div><b>{t('tech.me.notStarted')}</b><small>{t('tech.me.started')}</small></div>
            )}
            <div><b>{t('tech.me.ofTotal', { done, total: stops.length })}</b><small>{t('tech.me.jobsDone')}</small></div>
          </div>
        </div>

        <div className="card">
          <div className="ch"><h3>{t('tech.me.sync')}</h3></div>
          <div className="syncrow">
            <span className="ok"><Icon name={n > 0 ? 'clock' : 'cloud'} sw={2} /></span>
            <div className="tx" role="link" tabIndex={0} data-ctl="CTL-TEC-10-02"
              onClick={() => router.push(WAITING_HREF)} onKeyDown={key(() => router.push(WAITING_HREF))}>
              {reading ? (
                <>{skel('bw-skel-70')}{skel('bw-skel-40')}</>
              ) : (
                <>
                  <b className={n > 0 ? 'wait' : undefined}>{n > 0 ? t('tech.sync.waiting', { n }) : t('tech.me.syncedAt', { time: data.now ? clockOfWire(data.now) : '' })}</b>
                  <small>{n > 0 ? t('tech.me.waiting', { n }) : t('tech.me.syncedNothing')}</small>
                </>
              )}
            </div>
            <span className={offline || n === 0 ? 'sbtn dis' : 'sbtn'} role="button" tabIndex={0} {...(offline || n === 0 ? { 'aria-disabled': true } : {})}
              data-ctl="CTL-TEC-10-03" onClick={sendNow} onKeyDown={key(sendNow)}>
              <Icon name="send" />
              {t('tech.me.sendNow')}
            </span>
          </div>
          {offline && n > 0 ? <div className="r1p-why" data-align="end">{t('tech.me.sendNowWhy')}</div> : null}
        </div>

        <div className="card rows">
          <div className="rw">
            <Icon name="phone" />
            {t('tech.me.call')}
            <CallButton name={t('tech.me.call')} fullName={t('tech.me.callAria', { branch })} number={day?.officePhone ?? ''} className="call bw-btn-reset">
              <Icon name="phone" />
              {day?.officePhone ?? ''}
            </CallButton>
          </div>
          <div className="rw">
            <Icon name="bell" />
            {t('tech.me.notifications')}
            <label className={data.noticesOn ? 'r1-switch on' : 'r1-switch'} data-ctl="CTL-TEC-10-08">
              <button type="button" className="trk bw-btn-reset" role="switch" aria-checked={data.noticesOn} aria-label={t('tech.me.notifications')}
                onClick={() => techReads().setNotices(!data.noticesOn)} />
              <span className="st">{t(data.noticesOn ? 'tech.me.on' : 'tech.me.off')}</span>
            </label>
          </div>
          <div className="rw">
            <span className="aa">{t('tech.me.aa')}</span>
            {t('tech.me.textSize')}
            <span className="sel" role="combobox" tabIndex={0} aria-haspopup="listbox" aria-expanded={sizeOpen} aria-controls="bw-me-sizes"
              aria-label={t('tech.me.textSizeAria', { size: t(SIZE_KEY[data.textSize]) })} data-ctl="CTL-TEC-10-09"
              onClick={() => setSizeOpen(!sizeOpen)} onKeyDown={key(() => setSizeOpen(!sizeOpen))}>
              {t(SIZE_KEY[data.textSize])}
              <Icon name="chevDown" />
            </span>
          </div>
          {sizeOpen ? (
            <div className="r1-menu in" id="bw-me-sizes" role="listbox" aria-label={t('tech.me.textSize')}>
              {TEXT_SIZES.map((s) => (
                <div key={s} className="mi" role="option" tabIndex={0} aria-selected={s === data.textSize} data-size={s}
                  onClick={() => { techReads().setSize(s); setSizeOpen(false); }} onKeyDown={key(() => { techReads().setSize(s); setSizeOpen(false); })}>
                  {s === data.textSize ? <b>{t(SIZE_KEY[s])}</b> : t(SIZE_KEY[s])}
                </div>
              ))}
            </div>
          ) : null}
          <div className="rw">
            <Icon name="globe" />
            {t('tech.me.language')}
            <LanguageSwitch staff />
          </div>
          <div className="rw" data-ctl="CTL-TEC-10-11">
            <Icon name="info" />
            {t('tech.me.version')}
            <span className="v">{t('tech.me.versionValue', { version: APP_VERSION })}</span>
          </div>
        </div>

        <div className={phase === 'signing' ? 'out busy' : 'out'} role="button" tabIndex={0} data-ctl="CTL-TEC-10-04" {...(phase === 'signing' ? { 'aria-busy': true } : {})}
          onClick={() => { if (phase !== 'signing') void signOut(); }} onKeyDown={key(() => { if (phase !== 'signing') void signOut(); })}>
          {phase === 'signing' ? <><span className="r1-spin dark" />{t('tech.me.signingOut')}</> : <><Icon name="lock" />{t('tech.me.signOut')}</>}
        </div>
        {phase === 'refused' ? (
          <div className="refused" role="alert" data-ctl="CTL-TEC-10-04">
            <Icon name="alert" />
            <span>{t('tech.me.refused', { n })}</span>
          </div>
        ) : (
          <div className="outnote">{t('tech.me.signOutNote')}</div>
        )}
      </div>
    </TechAppFrame>
  );
}
