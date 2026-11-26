// SPDX-License-Identifier: AGPL-3.0-or-later
// CMP-01 demo clock and CMP-02 clock banner: the clock state API-10 answers and the words the strip shows.
// FR-DEMO-2: the client never reads the device clock for "now". The strip shows demoNow from API-10 and advances it
// by the real time elapsed since that read (a monotonic duration the caller measures), times the clock's rate, unless
// paused. Weekday and month names come from the catalog (UI-SPECIFICATION 13.3 rule 7); times from @bw/time.
import { dateParts, fromWire, formatTime, Temporal, zoneAbbreviation, type Instant, type Language } from '@bw/time';
import type { MessageKey } from '@bw/i18n';

type MoveKind = 'jump' | 'pause' | 'resume' | 'reset';

/** The demo clock answer (API-10), as UI-SPECIFICATION 12.2 names its fields. Times are RFC 9557 strings carrying the zone. */
export interface ClockAnswer {
  demoNow: string;
  realNow?: string;
  rate: number;
  paused: boolean;
  worldEpoch: number;
  /** by: a person's name, or "nightly" / "idle" for an automatic reset (UD-26). */
  lastMove?: { by: string; kind: MoveKind; toDemo: string } | null;
  replay?: { running: boolean; done: number; total: number } | null;
  /** Seconds until a reset is allowed again (API-10; 0 outside the cool-down). */
  resetAvailableInSeconds?: number;
}

export interface ClockView {
  answer: ClockAnswer;
  /** The anchor: demoNow as an instant, and its zone (the branch zone API-10 answers with). */
  at: Instant;
  zone: string;
}

export function toView(answer: ClockAnswer): ClockView {
  const z = fromWire(answer.demoNow);
  return { answer, at: z.toInstant(), zone: z.timeZoneId };
}

/** The demo time shown elapsedMs of real time after the read (FR-DEMO-2: advance from the anchor, never the device clock). */
export function advance(view: Pick<ClockView, 'at'> & { answer: Pick<ClockAnswer, 'paused' | 'rate'> }, elapsedMs: number): Instant {
  if (view.answer.paused || elapsedMs <= 0) return view.at;
  return view.at.add(Temporal.Duration.from({ milliseconds: Math.round(elapsedMs * view.answer.rate) }));
}

type T = (key: MessageKey, values?: Record<string, string | number>) => string;

function dateValues(at: Instant, zone: string, lang: Language, t: T) {
  const p = dateParts(at, zone);
  return {
    weekday: t(`time.weekday.${p.weekday}` as MessageKey),
    month: t(`time.month.${p.month}` as MessageKey),
    day: p.day,
    time: formatTime(at, zone, lang),
  };
}

/** "Tue, Sep 15, 10:28 AM EDT" (UD-15: the header clock names its zone). */
export function clockText(at: Instant, zone: string, lang: Language, t: T): string {
  return t('shell.clock.value', { ...dateValues(at, zone, lang, t), zone: zoneAbbreviation(at, zone) });
}

/** "Tue, Sep 15, 6:05 PM": the banner's times. */
export function shortText(at: Instant, zone: string, lang: Language, t: T): string {
  return t('shell.clock.short', dateValues(at, zone, lang, t));
}

/** The catalog key of the last-move line (CTL-CMP-02-01): the person's move, or the automatic reset that made it. */
export function moveKey(move: NonNullable<ClockAnswer['lastMove']>): MessageKey {
  if (move.by === 'nightly') return 'shell.clock.moved.nightly';
  if (move.by === 'idle') return 'shell.clock.moved.idle';
  return `shell.clock.moved.${move.kind}` as MessageKey;
}

/** Which CMP-02 line shows: a running replay first (CTL-CMP-02-02), then the last move (CTL-CMP-02-01). */
export function bannerLine(answer: ClockAnswer): 'replay' | 'move' | null {
  if (answer.replay?.running) return 'replay';
  if (answer.lastMove) return 'move';
  return null;
}
