// SPDX-License-Identifier: AGPL-3.0-or-later
// SD-43 / API-172 (F-885): a board tab holds the seq of each event whose re-read it finished, with the time it finished, and sends
// its held samples in 1 request: when it holds 20, 5 real seconds after the first of them was held, and when the page is hidden
// (pagehide, sent with keepalive). Each sample carries heldMs, the whole milliseconds it was held by the tab's monotonic clock, so the
// server takes the wait out of the delay (F-640: the old 1 post per seq made the n-th sample carry the round trips before it). A
// failed send is only missed samples; nothing is retried.
import { DELAY_SAMPLE_HELD_MAX_MS, DELAY_SAMPLES_MAX } from '@bw/api';

export interface DelaySample { seq: number; heldMs: number }
/** Sends 1 batch; keepalive is true for the send of a page being hidden. */
export type SendSamples = (samples: DelaySample[], keepalive: boolean) => Promise<unknown>;

/** SD-43: a tab sends its held samples at once when it holds this many. */
export const DELAY_BATCH_SIZE = 20;
/** SD-43: and this many real milliseconds after the first of them was held. */
export const DELAY_BATCH_WAIT_MS = 5_000;

export interface SamplerEnv {
  /** The tab's monotonic clock, in ms (performance.now()). */
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Calls fn when the page is hidden; answers the function that stops it. */
  onHide(fn: () => void): () => void;
}

const browserEnv = (): SamplerEnv => ({
  now: () => performance.now(),
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (h) => window.clearTimeout(h as number),
  onHide: (fn) => {
    window.addEventListener('pagehide', fn);
    return () => window.removeEventListener('pagehide', fn);
  },
});

export interface DelaySampler {
  /** Holds each positive seq of 1 finished re-read. */
  hold(seqs: readonly number[]): void;
  /** Sends what is held now (each request at most DELAY_SAMPLES_MAX samples). */
  flush(keepalive?: boolean): void;
  /** Sends what is held and stops: the timer and the pagehide listener. */
  close(): void;
}

export function delaySampler(send: SendSamples, env: SamplerEnv = browserEnv()): DelaySampler {
  let held: { seq: number; at: number }[] = [];
  let timer: unknown = null;
  const flush = (keepalive = false) => {
    if (timer !== null) env.clearTimer(timer);
    timer = null;
    if (held.length === 0) return;
    const now = env.now();
    const samples = held.map((h) => ({ seq: h.seq, heldMs: Math.min(DELAY_SAMPLE_HELD_MAX_MS, Math.max(0, Math.round(now - h.at))) }));
    held = [];
    for (let i = 0; i < samples.length; i += DELAY_SAMPLES_MAX) {
      try {
        void send(samples.slice(i, i + DELAY_SAMPLES_MAX), keepalive).catch(() => undefined);
      } catch {
        // a missed batch is only missed samples
      }
    }
  };
  const stopHide = env.onHide(() => flush(true));
  return {
    hold(seqs) {
      const now = env.now();
      for (const seq of seqs) if (seq > 0) held.push({ seq, at: now });
      if (held.length >= DELAY_BATCH_SIZE) flush();
      else if (held.length > 0 && timer === null) timer = env.setTimer(() => flush(), DELAY_BATCH_WAIT_MS);
    },
    flush,
    close() {
      stopHide();
      flush();
    },
  };
}
