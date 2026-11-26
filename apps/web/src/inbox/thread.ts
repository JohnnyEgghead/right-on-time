// SPDX-License-Identifier: AGPL-3.0-or-later
// The thread's time stamps and link pieces (SCR-INB-01, CTL-INB-01-02 and -03). A stamp stands before the first message, at a new day,
// and after a gap of 15 demo minutes (frame DK-128: "Tue, Sep 15 at 10:28 AM", then "10:52 AM" for the later text of the same day).
import type { MessageKey } from '@bw/i18n';
import { fromWire, formatTime, type Language } from '@bw/time';
import { dayLabel, type InboxMessage } from './api.ts';

type T = (key: MessageKey, values?: Record<string, string | number>) => string;

const STAMP_GAP_MINUTES = 15;

interface Stamp { day: string | null; time: string }
export type ThreadItem = { kind: 'stamp'; stamp: Stamp } | { kind: 'message'; message: InboxMessage };

const dayOf = (wire: string): string => wire.slice(0, 10);

export function threadItems(messages: readonly InboxMessage[], today: string, lang: Language, t: T): ThreadItem[] {
  const out: ThreadItem[] = [];
  let prev: InboxMessage | null = null;
  for (const m of messages) {
    const at = fromWire(m.sentAt);
    const time = formatTime(at.toInstant(), at.timeZoneId, lang);
    const newDay = prev === null || dayOf(prev.sentAt) !== dayOf(m.sentAt);
    const gap = prev === null ? Infinity : (at.epochMilliseconds - fromWire(prev.sentAt).epochMilliseconds) / 60_000;
    if (newDay) out.push({ kind: 'stamp', stamp: { day: dayOf(m.sentAt) === today ? t('inbox.today') : dayLabel(dayOf(m.sentAt), t), time } });
    else if (gap >= STAMP_GAP_MINUTES) out.push({ kind: 'stamp', stamp: { day: null, time } });
    out.push({ kind: 'message', message: m });
    prev = m;
  }
  return out;
}

/** A body cut at its links: strings and the link at its place (CTL-INB-01-03). */
export function bodyPieces(m: InboxMessage): (string | InboxMessage['links'][number])[] {
  const pieces: (string | InboxMessage['links'][number])[] = [];
  let rest = m.body;
  for (const l of m.links) {
    const i = rest.indexOf(l.text);
    if (i < 0) continue;
    if (i > 0) pieces.push(rest.slice(0, i));
    pieces.push(l);
    rest = rest.slice(i + l.text.length);
  }
  if (rest) pieces.push(rest);
  return pieces;
}
