// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-TEC-09 Waiting to send at /tech/waiting (UI-SPECIFICATION section 8 and 4.5; DK-111 mockups/pages/tech-offline.html;
// FR-TECH-4, FR-TECH-6, FR-TECH-7, invariant 1, C1). Read from the phone's store only: every item not yet on the server, in
// entry order, with its kind, job, customer, entry time in demo time and status word; an item waiting over 24 hours of the
// phone's real time is marked; the answers the server gave today that the technician should see (listed for the office,
// history only, not added after a reset) stay listed. Send now runs the engine's send; How sending works says, in words,
// what this web app can do (C1: it sends only while open with signal).
import '../../shell/css/phone.ts';
import '../../../styles/page-tech-offline.css';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import { OLD_ITEM_MS, type AnsweredItem, type QueuedItem } from '@bw/outbox/src/items/index.ts';
import { realNow } from '@bw/time';
import { useEffect, useState } from 'react';
import { Icon } from '../../shell/Icon.tsx';
import { useT } from '../../shell/intl.tsx';
import type { OutboxState } from '../engine.ts';
import { answerText, OldItemsBanner } from '../SyncStrip.tsx';
import { TechAppFrame } from '../TechAppFrame.tsx';
import { HeadClock } from './HeadClock.tsx';
import type { ClockAnswer } from '../../shell/clock.ts';
import { ownItems, techOutbox, useOwnOutbox } from '../useOutbox.ts';
import { go } from './nav.ts';
import { enteredWords, rowLink } from './model.ts';
import { jobStore } from './store.ts';

const ICON: Record<QueuedItem['kind'], 'note' | 'camera' | 'truck' | 'pin' | 'check' | 'home' | 'sheet'> = {
  note: 'note', photo: 'camera', signature: 'sheet', on_my_way: 'truck', arrived: 'pin', finished: 'check', no_one_home: 'home',
};
/** Today's answers the screen keeps showing: what the office was told, what sent with no text, what the reset did not add. */
const KEPT_RESULTS = new Set(['flagged', 'history_only', 'world_reset']);

export interface WaitingScreenProps {
  fixed?: { outbox: OutboxState; answered?: AnsweredItem[]; names?: Record<number, string>; nowMs?: number; sending?: boolean; clock?: ClockAnswer; mini?: boolean; demoNowMs?: number };
}

export function WaitingScreen({ fixed }: WaitingScreenProps) {
  const t = useT();
  const outbox = useOwnOutbox(fixed ? fixed.outbox : undefined);
  const [answered, setAnswered] = useState<AnsweredItem[]>(fixed?.answered ?? []);
  const [names, setNames] = useState<Record<number, string>>(fixed?.names ?? {});
  const [clicked, setClicked] = useState(false);
  const [demoNow, setDemoNow] = useState<number | null>(fixed?.demoNowMs ?? null);
  useEffect(() => {
    if (!fixed) void techOutbox().demoNowMs().then(setDemoNow, () => undefined);
  }, [fixed, outbox.waiting]);
  useEffect(() => {
    if (fixed) return;
    void techOutbox().answered().then(setAnswered, () => undefined);
  }, [fixed, outbox.lastSent]);
  useEffect(() => {
    if (fixed) return;
    const jobs = new Set([...outbox.waiting.map((i) => i.jobNumber), ...answered.map((a) => a.jobNumber)]);
    for (const n of jobs) {
      if (names[n] !== undefined) continue;
      void jobStore().job(n).then((j) => { if (j) setNames((m) => ({ ...m, [n]: j.customer.name })); }, () => undefined);
    }
  }, [fixed, outbox.waiting, answered, names]);
  useEffect(() => {
    if (!outbox.sending) setClicked(false);
  }, [outbox.sending]);

  const now = fixed?.nowMs ?? realNow('tech_waiting_banner').epochMilliseconds;
  const sending = fixed?.sending ?? (outbox.sending && (clicked || outbox.waiting.length > 0));
  const title = (k: QueuedItem['kind'], text?: string) => (text !== undefined ? t('tech.waiting.noteTitle', { text }) : t(`tech.waiting.kind.${k}` as MessageKey));
  const where = (job: number, at: string) => {
    const name = names[job];
    const time = enteredWords(at, demoNow, t.lang);
    return name ? t('tech.waiting.where', { job, name, time }) : t('tech.waiting.whereNoName', { job, time });
  };
  const kept = ownItems(answered, outbox.userId).filter((a) => KEPT_RESULTS.has(a.result));
  const recentSent = outbox.lastSent.filter((a) => !KEPT_RESULTS.has(a.result));

  const rows = [
    ...recentSent.map((a) => (
      <div key={a.key} className="item" data-key={a.key} data-result={a.result}>
        <span className="ico"><Icon name={ICON[a.kind]} /></span>
        <div className="tx"><b>{title(a.kind)}</b><small>{t('tech.waiting.job', { job: a.jobNumber })}</small></div>
        <span className="wait sent"><Icon name="check" sw={2.6} />{t('tech.waiting.sent')}</span>
      </div>
    )),
    ...outbox.waiting.map((i) => {
      const old = now - i.enteredRealMs > OLD_ITEM_MS;
      const refused = i.lastTry?.outcome === 'refused';
      const retry = i.lastTry && !refused;
      const why = refused ? t(i.lastTry?.code === 'parts_required' ? 'tech.finish.partsRequiredServer' : 'tech.waiting.refused')
        : old ? t('tech.waiting.oldWhy') : retry ? t('tech.waiting.retry') : null;
      // F-1025: a finish refused for parts opens its job's finish screen with the message (UI-SPECIFICATION 4.5 rule 10).
      // F-1044: the row stays the frame's div and acts as a link the app's way (FinishScreen's back link), so the
      // byte-copied frame sheet keeps the frame's .item rule unedited.
      const link = rowLink(i, go);
      return (
        <div key={i.key} className="item" data-key={i.key} data-state={sending ? 'sending' : refused ? 'refused' : 'waiting'} {...link}>
          <span className="ico"><Icon name={ICON[i.kind]} /></span>
          <div className="tx"><b>{title(i.kind, i.kind === 'note' ? i.payload.text : undefined)}</b><small>{where(i.jobNumber, i.demoTime)}</small>{why ? <span className="why">{why}</span> : null}</div>
          {sending ? <span className="wait sending"><span className="r1-spin dark bw-spin12" />{t('tech.waiting.sending')}</span>
            : <span className={`wait${old || refused ? ' old' : ''}`}><Icon name="clock" sw={2.2} />{t('tech.job.waitingToSend')}</span>}
        </div>
      );
    }),
    ...kept.map((a) => (
      <div key={`a-${a.key}`} className="item" data-key={a.key} data-result={a.result}>
        <span className="ico"><Icon name={ICON[a.kind]} /></span>
        <div className="tx"><b>{title(a.kind)}</b><small>{t('tech.waiting.job', { job: a.jobNumber })}</small><span className="why">{answerText(t, a)}</span></div>
        {a.result === 'world_reset' ? <span className="wait gone"><Icon name="clock" sw={2.2} />{t('tech.waiting.notAdded')}</span>
          : <span className="wait sent"><Icon name="check" sw={2.6} />{t(a.result === 'flagged' ? 'tech.waiting.listed' : 'tech.waiting.sent')}</span>}
      </div>
    )),
  ];
  const n = outbox.waiting.length;
  const top = sending ? t('tech.waiting.sendingN', { n })
    : recentSent.length > 0 && n > 0 ? t('tech.waiting.partial', { sent: recentSent.length, left: n })
      : n > 0 ? t('tech.waiting.count', { n }) : null;
  const canSend = outbox.online && n > 0 && !sending;
  const header = (
    <div className="wh">
      <div className="nav"><a href="/tech/me" data-ctl="CTL-TEC-04-01"><Icon name="back" />{t('tech.tab.me')}</a><span /></div>
      <h1>{t('tech.waiting.title')}</h1>
      <HeadClock online={outbox.online} {...(fixed ? { fixed: fixed.clock } : {})} />
    </div>
  );
  return (
    <TechAppFrame screen="SCR-TEC-09" tab="me" header={header} noSignalStrip clockInHeader mini={fixed?.mini ?? false} {...(fixed ? { fixed: fixed.outbox, reader: false as const, clock: null } : {})}>
      <div className="body">
        <OldItemsBanner {...(fixed ? { fixed: fixed.outbox } : {})} />
        {top ? <div className="cnt" role="status">{top}</div> : null}
        <div className="card" data-ctl="CTL-TEC-09-01">
          {rows.length > 0 ? rows : <div className="r1p-empty"><Icon name="cloud" /><span>{t('tech.waiting.nothing')}</span></div>}
        </div>
        {n > 0 ? (
          <>
            <button type="button" className={`r1p-btn ${canSend || sending ? 'pri' : 'dis'} bw-btn-reset`} data-ctl="CTL-TEC-09-02" aria-disabled={canSend ? undefined : true}
              aria-busy={sending || undefined} aria-describedby={outbox.online ? undefined : 'bw-why9'}
              onClick={() => { if (!canSend || fixed) return; setClicked(true); void techOutbox().sync(); }}>
              {sending ? <><span className="r1-spin" />{t('tech.waiting.sendingBtn')}</> : <><Icon name="send" />{t('tech.waiting.sendNow')}</>}
            </button>
            {outbox.online ? null : <div className="r1p-why" id="bw-why9">{t('tech.sync.noSignal')}</div>}
          </>
        ) : null}
        <div className="how" data-ctl="CTL-TEC-09-03"><b>{t('tech.waiting.howTitle')}</b> {t('tech.waiting.howWeb')}</div>
      </div>
    </TechAppFrame>
  );
}

