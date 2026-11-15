// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-CUS-03 You're booked, drawn (DK-121; UI-SPECIFICATION CTL-CUS-03-01 to CTL-CUS-03-10). Pure: the API-114 answer in, the page out.
// The page's own rules are the frame's last style block (styles/page-booking-done.css), copied; the adaptations are styles/app/booking.css.
import type { BookingSummaryAnswer } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { timeText } from '../board/model.ts';
import type { Branch } from '../shell/branches.ts';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { Fragment } from 'react';
import { addDaysTo, addressLine, dayShort, phoneText, serviceIcon, STEPS, windowZoned } from './model.ts';

const STEP_NAMES: MessageKey[] = ['booking.step.service', 'booking.step.address', 'booking.step.day', 'booking.step.window', 'booking.step.details', 'booking.step.confirm'];
const dayOf = (wire: string): string => wire.slice(0, 10);

export function DoneView({ data, branch }: { data: BookingSummaryAnswer; branch: Branch }) {
  const t = useT();
  const v = data.visit;
  const service = t(v.serviceLabelKey as MessageKey);
  const price = t(v.priceTextKey as MessageKey);
  const length = t(`service.${v.serviceId}.length` as MessageKey);
  const text = data.confirmationText;
  const on = data.textsOn;
  const to = text ? phoneText(text.to) : '';
  const lang = t(`booking.language.${data.textLanguage}` as MessageKey);
  const window = windowZoned(v.window.start, v.window.end); // F-1084: v.window is told in the branch's zone (the server's); F-1122: the page names it
  const status = text?.status ?? 'queued';
  const chip = status === 'delivered' ? t('booking.done.sentChip', { time: text?.sentAt ? timeText(text.sentAt) : '' })
    : status === 'held' ? t('booking.done.heldChip', { time: text?.heldUntil ? timeText(text.heldUntil) : '' })
    : status === 'gave_up' || status === 'canceled' ? null : t('booking.done.queuedChip');
  const first = status === 'delivered' ? t('booking.done.n1.sent')
    : status === 'held' ? t('booking.done.n1.held', { time: text?.heldUntil ? timeText(text.heldUntil) : '' })
    : status === 'gave_up' || status === 'canceled' ? t('booking.done.n1.failed') : t('booking.done.n1.queued');
  const bookedDay = dayOf(v.bookedAt);
  return (
    <>
      <section className="hero">
        <div className="hl">
          <span className="okmark"><Icon name="check" sw={3} /></span>
          <div><h1>{t('booking.done.title')}</h1><p>{t(on ? 'booking.done.sub' : 'booking.done.subOff', { service: service.toLowerCase() })}</p></div>
        </div>
        <div className="steps" data-ctl="CTL-CUS-01-01" role="group" aria-label={t('booking.done.stepsDone')}>
          {STEPS.map((s, i) => (
            <Fragment key={s}>
              {i > 0 ? <span className="line" /> : null}
              <span className="step ok"><span className="n"><Icon name="check" sw={3} /></span>{t(STEP_NAMES[i] as MessageKey)}</span>
            </Fragment>
          ))}
        </div>
      </section>
      <div className="main">
        <div className="col">
          <section className="box">
            <h2>{t('booking.done.visit')}<small data-ctl="CTL-CUS-03-10">{t('booking.done.bookedAt', { day: dayShort(t, bookedDay), time: timeText(v.bookedAt) })}</small></h2>
            <div className="visit" data-ctl="CTL-CUS-03-01">
              <div className="big">
                <span className="ico"><Icon name={serviceIcon(v.serviceId)} /></span>
                <div>
                  <b>{service}</b>
                  <div className="win">{t('booking.done.arrives', { day: dayShort(t, v.date) })} <strong>{window}</strong></div>
                  <span className="num">{t('booking.done.number', { n: v.jobNumber })}</span>
                </div>
              </div>
              <div className="sum">
                <div className="li"><span>{t('booking.done.name')}</span><b>{v.name}</b></div>
                <div className="li"><span>{t('booking.done.address')}</span><b>{addressLine(v.address.houseNumber, { name: v.address.street, city: v.address.city, zip: v.address.zip })}</b></div>
                <div className="li">
                  <span>{on ? t('booking.done.textsGo') : t('booking.done.textsOff')}</span>
                  <b>{on ? t('booking.done.textsTo', { phone: to, language: lang }) : t('booking.done.textsOffValue')}</b>
                </div>
                <div className="li"><span>{t('booking.done.price')}</span><b>{`${price}, ${length}`}</b></div>
              </div>
            </div>
          </section>
          {on ? (
            <section className="box">
              <h2>{t('booking.done.next')}</h2>
              <ol className="next" data-ctl="CTL-CUS-03-02">
                <li className={status === 'delivered' ? 'done' : undefined}>
                  <span className="dot">{status === 'delivered' ? <Icon name="check" sw={2.6} /> : <Icon name="clock" />}</span>
                  <div>
                    <span className="when">{t('booking.done.n1.when', { day: dayShort(t, bookedDay) })}</span>
                    <b>{first}</b>
                    <p>{status === 'held' ? t('booking.done.n1.bodyHeld', { time: text?.heldUntil ? timeText(text.heldUntil) : '' }) : t('booking.done.n1.body', { phone: to })}</p>
                  </div>
                </li>
                <li><span className="dot"><Icon name="bell" /></span><div><span className="when">{t('booking.done.n2.when', { day: dayShort(t, addDaysTo(v.date, -1)) })}</span><b>{t('booking.done.n2.t')}</b><p>{t('booking.done.n2.body')}</p></div></li>
                <li><span className="dot"><Icon name="truck" /></span><div><span className="when">{t('booking.done.n3.when', { day: dayShort(t, v.date) })}</span><b>{t('booking.done.n3.t')}</b><p>{t('booking.done.n3.body')}</p></div></li>
                <li><span className="dot"><Icon name="clock" /></span><div><span className="when">{t('booking.done.n4.when')}</span><b>{t('booking.done.n4.t')}</b><p>{t('booking.done.n4.body')}</p></div></li>
              </ol>
              <div className="quiet"><Icon name="clock" />{t('booking.done.quiet')}</div>
            </section>
          ) : (
            <div className="callnote" data-ctl="CTL-CUS-03-02"><Icon name="phone" /><span>{t('booking.done.call')}</span></div>
          )}
        </div>
        <div className="col">
          {on && text ? (
            <section className="box" data-ctl="CTL-CUS-03-06">
              <div className="sent">
                <Icon name="message" />
                <b>{t(status === 'held' ? 'booking.done.heldTo' : 'booking.done.sentTo', { phone: to })}</b>
                {chip ? <span className="sentchip">{status === 'delivered' ? <Icon name="check" sw={3} /> : null}{chip}</span> : null}
              </div>
              <div className="phonebox">
                <div className="stamp"><b>{dayShort(t, text.sentAt ? dayOf(text.sentAt) : bookedDay)}</b>{' '}{t('booking.done.stampAt', { time: timeText(text.sentAt ?? text.heldUntil ?? v.bookedAt) })}</div>
                <div className="bub" lang={data.textLanguage}>{text.body}</div>
              </div>
              {data.inboxUrl ? <a className="seetx" data-ctl="CTL-CUS-03-03" href={data.inboxUrl}><Icon name="message" />{t('booking.done.seeTexts')}</a> : null}
            </section>
          ) : null}
          <section className="box change" data-ctl="CTL-CUS-03-04">
            <h2>{t('booking.done.change')}</h2>
            <div className="ways">
              {on ? <div className="way"><Icon name="message" /><div><b>{t('booking.done.replyR')}</b><span>{t('booking.done.replyRBody')}</span></div></div> : null}
              <div className="way">
                <Icon name="phone" />
                <div><b>{t('booking.done.callUs')}</b><span>{branch.officePhone}<br /><span data-ctl="CTL-CUS-03-07">{t('bookmenu.officeHours')}</span></span></div>
              </div>
            </div>
          </section>
          <div className="noacct" data-ctl="CTL-CUS-03-08">
            <Icon name="user" />
            <div><b>{t('booking.done.noAcct')}</b> {t(on ? 'booking.done.noAcctText' : 'booking.done.noAcctCall')}</div>
          </div>
          <div className="acts">
            <a className="btn" href="/book" data-ctl="CTL-CUS-03-09">{t('booking.done.home')}</a>
            <a className="btn primary" href="/book?new=1" data-ctl="CTL-CUS-03-05">{t('booking.done.another')}</a>
          </div>
        </div>
      </div>
    </>
  );
}

/** The booking link's failed states, in the customer style: unknown token (404) and a read that failed. */
export function DoneNotFound() {
  const t = useT();
  return (
    <div className="main bw-nf-main">
      <section className="box nf">
        <span className="r1-note">{t('booking.done.nf.code')}</span>
        <h2>{t('booking.done.nf.title')}</h2>
        <p>{t('booking.done.nf.body')}</p>
        <a className="btn primary" href="/book">{t('booking.title')}</a>
      </section>
    </div>
  );
}

export function DoneLoading() {
  const t = useT();
  return (
    <div className="main" role="status" aria-busy="true" aria-label={t('booking.loading')}>
      <div className="col"><section className="box"><span className="r1-skel bw-skel-40" /><span className="r1-skel" /><span className="r1-skel" /><span className="r1-skel bw-skel-70" /></section></div>
    </div>
  );
}

export function DoneError({ retry }: { retry(): void }) {
  const t = useT();
  return (
    <div className="main">
      <section className="box nf" role="alert">
        <p>{t('booking.done.error')}</p>
        <button type="button" className="btn primary" onClick={retry}>{t('booking.retry')}</button>
      </section>
    </div>
  );
}
