// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-INB-01 Text inbox, live: the page reads its thread by the inbox token (API-120) when it opens, every 5 s and when the tab gets focus
// (FR-TEXT-14, GAP-7), and sends a reply as C, R or free text (API-121, FR-TEXT-8). The token travels only in the paths of its own rows.
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../shell/intl.tsx';
import { LANG_COOKIE, langCookie } from '../shell/lang.ts';
import { callRow, rows, type InboxData } from './api.ts';
import { InboxView, type InboxState, type ReplyKind } from './InboxView.tsx';

/** How often the page re-reads the inbox, in milliseconds (FR-TEXT-14). */
const REFRESH_MS = 5_000;
/** How long the New text notice stays on (CTL-INB-01-09). */
const NEW_TEXT_MS = 6_000;

export function InboxScreen({ token }: { token: string }) {
  const t = useT();
  const router = useRouter();
  const [state, setState] = useState<InboxState>('loading');
  const [data, setData] = useState<InboxData | null>(null);
  const [busy, setBusy] = useState<ReplyKind | null>(null);
  const [failed, setFailed] = useState<{ body: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [newText, setNewText] = useState(false);
  // F-968: the thread is read whole each time (it is small), so a text committed after the page's last read is never skipped or doubled; this holds how many office texts the last answer had (null: nothing read yet).
  const outs = useRef<number | null>(null);
  const langSet = useRef(false);

  const read = useCallback(async () => {
    const r = await callRow(rows.inboxMessages, { inboxToken: token });
    if (!r.ok) {
      if (r.status === 404) setState('not_valid');
      else if (outs.current === null) setState('error');
      return;
    }
    const fresh = r.data;
    // The page opens in the customer's text language unless the visitor already chose one (UD-32).
    if (!langSet.current) {
      langSet.current = true;
      if (!document.cookie.split('; ').some((c) => c.startsWith(`${LANG_COOKIE}=`)) && fresh.customer.language !== t.lang) {
        document.cookie = langCookie(fresh.customer.language);
        router.refresh();
      }
    }
    setData({ customer: fresh.customer, messages: fresh.messages });
    const now = fresh.messages.filter((m) => m.direction === 'out').length;
    const was = outs.current;
    outs.current = now;
    setState('ready');
    if (was !== null && now > was) setNewText(true);
  }, [token, t.lang, router]);

  // F-1935: a link that answers not found stays not found, so the page asks no more.
  const gone = state === 'not_valid';
  useEffect(() => {
    if (gone) return;
    void read();
    const every = window.setInterval(() => void read(), REFRESH_MS);
    const onFocus = () => void read();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(every);
      window.removeEventListener('focus', onFocus);
    };
  }, [read, gone]);

  useEffect(() => {
    if (!newText) return;
    const h = window.setTimeout(() => setNewText(false), NEW_TEXT_MS);
    return () => window.clearTimeout(h);
  }, [newText]);

  const reply = async (kind: ReplyKind, body: string) => {
    setBusy(kind);
    setFailed(null);
    const r = await callRow(rows.inboxReply, { inboxToken: token, body });
    setBusy(null);
    if (!r.ok) {
      setFailed({ body });
      return;
    }
    if (kind === 'send') setDraft('');
    await read();
  };

  return (
    <InboxView
      state={state} data={data} busy={busy} failed={failed} draft={draft} onDraft={setDraft} onReply={(k, b) => void reply(k, b)}
      onRetry={() => void read()} newText={newText}
    />
  );
}
