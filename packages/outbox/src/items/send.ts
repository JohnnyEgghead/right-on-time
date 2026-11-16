// SPDX-License-Identifier: AGPL-3.0-or-later
// The send loop of both technician apps (SPECIFICATIONS section 5.1 steps 2 and 10; UI-SPECIFICATION 4.5 rules 1, 4
// and 10; invariants I2 to I5 of model.ts). Pure over its 2 seams: the item store and the transport (the app's calls of
// API-103 and API-102), so the web app and the native app run the same loop.
//
// 1 send, in order: the caller's own waiting items in entry order (I5: another technician's items wait for that
// technician); blobs first, each by API-103; then the rest by API-102 in batches of at most 50. Per answer:
//   applied, duplicate, flagged, history_only, world_reset   markAnswered: the item leaves the store (rule 1)
//   refused (parts_required; an item the server cannot parse) the item stays, its code recorded (rule 10)
//   no answer for a key in a batch the server answered        the item stays (recorded `unanswered`)
// Per call: an upload or batch refused as a whole with a 4xx keeps those items (their code recorded) and the send goes
// on, except an upload the proxy refused for its size (413, F-1035): it is sent once more with no bytes, as the web app sends a photo
// over the cap (F-978), so the server answers it under its key, flagged validation_failed and listed for the dispatcher, and it
// leaves the phone; its bytes are never sent again. A network error, a 5xx, a signed-out (401) or forbidden (403) answer stops the
// send, and every item not yet
// answered stays waiting, recorded so the screen can say "Will try again".
//
// Re-run semantics (I3): every durable write here is the store's. An answer lost on the way (the call committed, the
// phone never heard) leaves the item waiting under its key; the next send repeats it and the server answers duplicate
// with the stored message (section 5.1 step 3), which removes it. A markAnswered that fails after the server answered
// throws out of the send with the item still waiting; the next send converges the same way. So the waiting list ends
// equal to the server's ledger: every key the server holds leaves, every key it does not stays.
import { ANSWERED_RESULTS, isBlobKind, ITEMS_PER_SEND, type AnsweredItem, type ItemResult, type ItemStore, type LastTry, type QueuedItem } from './model.ts';

export type CallStop = 'network' | 'server_error' | 'signed_out' | 'forbidden';

/** The outcome of 1 call, as the transport maps it from the HTTP answer. */
export type CallFailure = { ok: false; stop: CallStop } | { ok: false; stop: null; status: number; code: string };

export type WireAnswer = { key: string; result: string; code: string | null; messageKey: string | null; values: Record<string, string | number | null> | null };

export interface Transport {
  /** API-103: 1 photo or signature with its facts. */
  uploadBlob(item: QueuedItem, bytes: Uint8Array): Promise<{ ok: true; answer: WireAnswer } | CallFailure>;
  /** API-102: at most 50 items, answered per item. */
  sendItems(items: readonly QueuedItem[]): Promise<{ ok: true; answers: readonly WireAnswer[] } | CallFailure>;
}

export interface SendReport {
  /** The items that left the store in this send, with their answers, in the order they were answered. */
  answered: AnsweredItem[];
  /** The items still waiting that this send tried, with why. */
  kept: { key: string; why: LastTry }[];
  /** Why the send stopped early; null when it went through every item. */
  stopped: CallStop | null;
  /** Items still waiting after the send, every technician's, with the ones the phone cannot read (F-1093: the office's count is what the phone holds). */
  waitingAfter: number;
}

export interface SendOptions {
  /** The signed-in technician (I5). */
  userId: string;
  /** The phone's own real time in epoch milliseconds (realNow('device_stamp')): the try and answer stamps. */
  nowMs: () => number;
}

/** F-1035: the answer of a proxy (nginx) that refused an upload's body for its size, before the server read it. */
export const BODY_TOO_LARGE = 413;
const NO_BYTES = new Uint8Array(0);

const isAnswered = (r: string): r is ItemResult['result'] => (ANSWERED_RESULTS as readonly string[]).includes(r);

export async function sendWaiting(store: ItemStore, transport: Transport, opts: SendOptions): Promise<SendReport> {
  const mine = (await store.waiting()).filter((i) => i.userId === opts.userId);
  const answered: AnsweredItem[] = [];
  const kept: SendReport['kept'] = [];
  let stopped: CallStop | null = null;

  const keep = async (items: readonly QueuedItem[], why: Omit<LastTry, 'atRealMs'>) => {
    const t: LastTry = { atRealMs: opts.nowMs(), ...why };
    await store.recordTry(items.map((i) => i.key), t);
    for (const i of items) kept.push({ key: i.key, why: t });
  };
  const answer = async (item: QueuedItem, a: WireAnswer) => {
    if (!isAnswered(a.result)) {
      await keep([item], { outcome: 'refused', code: a.code ?? 'refused', messageKey: a.messageKey });
      return;
    }
    const result: ItemResult = { result: a.result, code: a.code, messageKey: a.messageKey, values: a.values };
    const at = opts.nowMs();
    await store.markAnswered(item.key, result, at);
    answered.push({ ...result, key: item.key, kind: item.kind, jobNumber: item.jobNumber, enteredRealMs: item.enteredRealMs, userId: item.userId, answeredRealMs: at });
  };
  const failed = async (f: CallFailure, these: readonly QueuedItem[], rest: readonly QueuedItem[]): Promise<boolean> => {
    if (f.stop === null) {
      await keep(these, { outcome: 'refused', code: f.code });
      return false;
    }
    stopped = f.stop;
    await keep([...these, ...rest], { outcome: f.stop });
    return true;
  };

  const blobs = mine.filter((i) => isBlobKind(i.kind));
  const items = mine.filter((i) => !isBlobKind(i.kind));
  for (const [n, b] of blobs.entries()) {
    const bytes = await store.blob(b.key);
    if (bytes === null) {
      // put() writes an item and its bytes together, so this is a damaged store: keep the item, never send it without its bytes.
      await keep([b], { outcome: 'refused', code: 'blob_missing' });
      continue;
    }
    let r = await transport.uploadBlob(b, bytes);
    // F-1035: refused for its size before the server read it; the no-bytes body has the server answer it (flagged) under the same key.
    if (!r.ok && r.stop === null && r.status === BODY_TOO_LARGE) r = await transport.uploadBlob(b, NO_BYTES);
    if (r.ok) await answer(b, r.answer);
    else if (await failed(r, [b], [...blobs.slice(n + 1), ...items])) return finish();
  }
  for (let i = 0; i < items.length; i += ITEMS_PER_SEND) {
    const batch = items.slice(i, i + ITEMS_PER_SEND);
    const r = await transport.sendItems(batch);
    if (!r.ok) {
      if (await failed(r, batch, items.slice(i + ITEMS_PER_SEND))) return finish();
      continue;
    }
    const byKey = new Map(r.answers.map((a) => [a.key.toLowerCase(), a]));
    const missing: QueuedItem[] = [];
    for (const it of batch) {
      const a = byKey.get(it.key);
      if (a) await answer(it, a);
      else missing.push(it);
    }
    if (missing.length > 0) await keep(missing, { outcome: 'unanswered' });
  }
  return finish();

  async function finish(): Promise<SendReport> {
    return { answered, kept, stopped, waitingAfter: (await store.waiting()).length + (store.damaged?.().length ?? 0) };
  }
}
