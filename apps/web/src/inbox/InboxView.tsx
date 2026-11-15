// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-INB-01 Text inbox (frames mockups/pages/customer-texts.html, customer-texts-spanish.html, customer-texts-late-reschedule.html;
// DK-126 to DK-128): each customer's on-screen phone. The view takes the read and the page's own state; InboxScreen is the live
// wrapper. The markup is the frames' own, in the frame's order, so the page rules (styles/page-customer-texts.css, a byte copy)
// apply as they do there. Every state of the frames is a state of this one view: Loading, Empty, No mobile, Texts off, Sending,
// Not valid and Error (with the Not sent line under a reply and the New text notice as parts of Success).
import type { MessageKey } from '@bw/i18n';
import { useEffect, useRef, type ReactNode } from 'react';
import { DemoStrip } from '../shell/DemoStrip.tsx';
import type { ClockAnswer } from '../shell/clock.ts';
import type { AppInfo } from '../shell/Footer.tsx';
import { Icon, Mark } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { ErrorPanel } from '../shell/Panels.tsx';
import { Screen } from '../shell/Surface.tsx';
import type { InboxData, InboxMessage } from './api.ts';
import { BrandRow, InboxLang, Notice, PhoneFoot } from './PhoneParts.tsx';
// The page's own rules load after the kit sheets PhoneParts brings, as the frame page orders its sheets.
import '../../styles/page-customer-texts.css';
import { LiveMapPreview, type PreviewFetch } from './Preview.tsx';
import { bodyPieces, threadItems } from './thread.ts';

export type InboxState = 'loading' | 'ready' | 'not_valid' | 'error';
export type ReplyKind = 'c' | 'r' | 'send';

export interface InboxViewProps {
  state: InboxState;
  data: InboxData | null;
  /** The reply being sent (its control is busy), and the reply whose send failed (its Not sent line), if any. */
  busy?: ReplyKind | null;
  failed?: { body: string } | null;
  draft?: string;
  onDraft?: (v: string) => void;
  onReply?: (kind: ReplyKind, body: string) => void;
  onRetry?: () => void;
  /** A text arrived while the page was open: the polite live region and a visible notice (CTL-INB-01-09). */
  newText?: boolean;
  /** Preview states: the clock, the footer and the preview card's answer are fixed (no read of any of them). */
  clock?: ClockAnswer | null;
  appInfo?: AppInfo | null;
  fixed?: boolean;
  preview?: PreviewFetch;
}

export function InboxView(p: InboxViewProps) {
  const t = useT();
  const d = p.data;
  const whose = d ? <div className="whose" data-ctl="CTL-INB-01-01">{t.rich('inbox.whose', { name: d.customer.name, b: (c) => <b translate="no">{c}</b> })}</div> : null;
  const phone = d?.customer.officePhone ?? '';
  const canReply = Boolean(d && d.customer.hasMobile && d.customer.textsOn);

  const body = (() => {
    if (p.state === 'loading') return <LoadingThread />;
    if (p.state === 'not_valid') return <Notice className="imsg" icon="alert">{t('inbox.notValid')}</Notice>;
    if (p.state === 'error' || !d) return <div className="inbox-err"><ErrorPanel title={t('inbox.errorTitle')} hint={t('inbox.errorHint')} onRetry={() => p.onRetry?.()} /></div>;
    if (!d.customer.hasMobile) return <Notice className="imsg" icon="phone">{t('inbox.noMobile', { name: d.customer.firstName })}</Notice>;
    if (d.messages.length === 0 && canReply) return <Notice className="imsg" icon="message">{t('inbox.empty')}</Notice>;
    return (
      <Thread data={d} failed={p.failed ?? null} {...(p.preview ? { preview: p.preview } : {})} />
    );
  })();
  const off = d && d.customer.hasMobile && !d.customer.textsOn;
  // The frames' reply controls: live for a customer who can text, off under the Error panel, and absent in every other state.
  const replies: 'on' | 'off' | false = p.state === 'error' ? 'off' : p.state === 'ready' && canReply ? 'on' : false;

  return (
    <Screen screen="SCR-INB-01" surface="SURF-INB" noClock footer={false} title={t('inbox.doc')} className="bw-inb">
      <div className="screen">
        <div className="mhead">
          <div className="ibx">
            <DemoStrip variant="phone" {...(p.fixed ? { initial: p.clock ?? null, reader: false as const } : {})} />
            <BrandRow className="ibrow" phone={phone} lang={<InboxLang />} />
            {whose}
          </div>
          <div className="r">
            <span />
            <div className="who">
              <div className="avatar"><Mark /></div>
              <div className="nm">{t('brand.name')}<Icon name="chevRight" /></div>
              <div className="sub">{t('inbox.sub')}</div>
            </div>
            <span />
          </div>
        </div>
        {body}
        {p.newText ? <div className="r1p-notice" aria-hidden="true"><Icon name="bell" /><span>{t('inbox.newText')}</span></div> : null}
        {off ? <Notice className="imsg" icon="phone">{t('inbox.textsOff', { name: d.customer.firstName })}</Notice> : null}
        {replies ? <Replies disabled={replies === 'off'} busy={p.busy ?? null} draft={p.draft ?? ''} {...(p.onDraft ? { onDraft: p.onDraft } : {})} {...(p.onReply ? { onReply: p.onReply } : {})} /> : null}
        <PhoneFoot {...(p.appInfo !== undefined ? { info: p.appInfo } : {})} {...(p.fixed ? { reader: false as const } : {})} />
        <div className="sr" role="status" aria-live="polite" data-ctl="CTL-INB-01-09">{p.newText ? t('inbox.newText') : ''}</div>
      </div>
    </Screen>
  );
}

function LoadingThread() {
  return (
    <div className="thread" role="log" aria-busy="true" data-ctl="CTL-INB-01-02">
      <span className="r1-skel bw-w-30 bw-mid" />
      <div className="bub in bw-w-260"><span className="r1-skel" /><span className="r1-skel bw-w-70" /></div>
      <div className="bub in bw-w-220 bw-gap"><span className="r1-skel" /></div>
    </div>
  );
}

function Thread({ data, failed, preview }: { data: InboxData; failed: { body: string } | null; preview?: PreviewFetch }) {
  const t = useT();
  const items = threadItems(data.messages, data.customer.today, t.lang, t);
  // The newest text is in view: the thread keeps its bottom when texts arrive.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [data.messages.length, failed]);
  return (
    <div className="thread" role="log" data-ctl="CTL-INB-01-02" ref={box}>
      {items.map((it) => {
        if (it.kind === 'stamp') {
          const s = it.stamp;
          return <div className="stamp" key={`s${s.day ?? ''}${s.time}${items.indexOf(it)}`}>{s.day ? t.rich('inbox.stampDay', { day: s.day, time: s.time, b: (c) => <b>{c}</b> }) : s.time}</div>;
        }
        return <Bubble key={it.message.id} m={it.message} lang={data.customer.language} {...(preview ? { preview } : {})} />;
      })}
      {failed ? (
        <>
          <div className="bub out">{failed.body}</div>
          <div className="meta bw-notsent" data-ctl="CTL-INB-01-08">{t('inbox.notSent')}</div>
        </>
      ) : null}
    </div>
  );
}

function Bubble({ m, lang, preview }: { m: InboxMessage; lang: string; preview?: PreviewFetch }) {
  const t = useT();
  if (m.direction === 'in') {
    return (
      <>
        <div className="bub out">{m.body}</div>
        <div className="meta" data-ctl="CTL-INB-01-08">{t('inbox.delivered')}</div>
      </>
    );
  }
  const pieces: ReactNode[] = bodyPieces(m).map((x, i) =>
    typeof x === 'string' ? x : (
      <a key={i} href={x.path} role="link" translate="no" data-ctl="CTL-INB-01-03">{x.text}</a>
    ),
  );
  return (
    <>
      <div className="bub in" lang={lang}>{pieces}</div>
      {m.liveMapPreview ? <LiveMapPreview path={m.liveMapPreview} host={m.links[0]?.text.split('/')[0] ?? ''} {...(preview ? { fetchPreview: preview } : {})} /> : null}
    </>
  );
}

function Replies({ disabled, busy, draft, onDraft, onReply }: {
  disabled: boolean; busy: ReplyKind | null; draft: string; onDraft?: (v: string) => void; onReply?: (kind: ReplyKind, body: string) => void;
}) {
  const t = useT();
  const off = disabled || busy !== null;
  const press = (kind: ReplyKind, body: string) => {
    if (off) return;
    onReply?.(kind, body);
  };
  const key = (kind: ReplyKind, body: string) => (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    press(kind, body);
  };
  const sendOff = disabled || busy !== null || draft.trim() === '';
  const label = (k: MessageKey) => t(k);
  return (
    <>
      <div className="quiet" data-ctl="CTL-INB-01-10">{t('inbox.quiet')}</div>
      <div className="rbtns">
        <span
          role="button" tabIndex={disabled ? -1 : 0} className={`${busy === 'c' ? 'busy' : ''}${disabled ? ' dis' : ''}`.trim()}
          {...(busy === 'c' ? { 'aria-busy': true } : {})} {...(disabled || (busy !== null && busy !== 'c') ? { 'aria-disabled': true } : {})}
          data-ctl="CTL-INB-01-04" onClick={() => press('c', 'C')} onKeyDown={key('c', 'C')}
        >
          {busy === 'c' ? <><span className="r1-spin dark" />{label('inbox.sending')}</> : label('inbox.replyC')}
        </span>
        <span
          role="button" tabIndex={disabled ? -1 : 0} className={`${busy === 'r' ? 'busy' : ''}${disabled ? ' dis' : ''}`.trim()}
          {...(busy === 'r' ? { 'aria-busy': true } : {})} {...(disabled || (busy !== null && busy !== 'r') ? { 'aria-disabled': true } : {})}
          data-ctl="CTL-INB-01-05" onClick={() => press('r', 'R')} onKeyDown={key('r', 'R')}
        >
          {busy === 'r' ? <><span className="r1-spin dark" />{label('inbox.sending')}</> : label('inbox.replyR')}
        </span>
      </div>
      <div className="inputbar">
        <label className={`field${disabled ? ' dis' : ''}`} data-ctl="CTL-INB-01-06">
          <input
            type="text" aria-label={t('inbox.fieldLabel')} placeholder={t('inbox.field')} value={draft} disabled={disabled} maxLength={1000}
            onChange={(e) => onDraft?.(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !sendOff) press('send', draft.trim()); }}
          />
        </label>
        <span
          role="button" tabIndex={sendOff ? -1 : 0} className={`send${sendOff ? ' dis' : ''}`} {...(sendOff ? { 'aria-disabled': true } : {})}
          {...(busy === 'send' ? { 'aria-busy': true } : {})}
          data-ctl="CTL-INB-01-07" onClick={() => { if (!sendOff) press('send', draft.trim()); }} onKeyDown={key('send', draft.trim())}
        >
          {t('inbox.send')}
        </span>
      </div>
    </>
  );
}
