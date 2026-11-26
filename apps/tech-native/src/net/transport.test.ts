// SPDX-License-Identifier: AGPL-3.0-or-later
// The native transport's time limit: a call with no answer by its limit ends as no signal while the background task is left running.
import { describe, expect, it } from 'vitest';
import { FileItemStore, sendWaiting } from '@bw/outbox/src/items/native.ts';
import { MARIA_ID, nodeDir, SAMPLE_TOKEN } from '../testing.ts';
import { nativeTransport, type UploadPort, type UploadResult } from './transport.ts';

const LOCAL = 'http://192.168.1.20:8080';
const KEY = '00000000-0000-4000-8000-0000000000c1';
const NOTE_KEY = '00000000-0000-4000-8000-0000000000c2';
const stamp = { worldEpoch: 1, deviceTime: 'd', offsetSavedReal: 'o', sinceSaveMs: 0, demoTime: 't', enteredRealMs: 1, jobNumber: 24830, baseVersion: null, userId: MARIA_ID } as const;
const answer = (key: string, result: string): UploadResult => ({
  status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: key === KEY ? { key, result, code: null, messageKey: null, values: null } : { items: [{ key, result, code: null, messageKey: null, values: null }] }, meta: { contract: 'API-102', worldEpoch: 1, demoNow: '2026-09-15T10:28:00-04:00[America/New_York]', viewer: { kind: 'public' }, labels: [] } }),
});

/** A port whose uploads wait until the test lets each one answer; the bodies it was given are tracked so a removal can be checked. */
function heldPort() {
  const held: { resolve: (r: UploadResult) => void; reject: (e: Error) => void }[] = [];
  const bodies: { text: string; done: boolean }[] = [];
  const port: UploadPort = {
    upload: () => new Promise<UploadResult>((resolve, reject) => held.push({ resolve, reject })),
    bodyFile(text) {
      const b = { text, done: false };
      bodies.push(b);
      return { uri: `file:///body-${bodies.length - 1}.json`, done: () => (b.done = true) };
    },
  };
  return { port, held, bodies };
}

describe('the native transport with a time limit', () => {
  // why: F-1763 an upload with no answer must end as no signal at the limit, and its late answer must change nothing and leave no unhandled error
  it('ends a photo upload at the limit as no signal, keeps it waiting, and a late answer is harmless', async () => {
    const store = new FileItemStore(nodeDir());
    await store.put({ ...stamp, key: KEY, kind: 'photo', contentType: 'image/jpeg' }, new Uint8Array([1, 2, 3]));
    const { port, held } = heldPort();
    const t = nativeTransport({ origin: LOCAL, token: SAMPLE_TOKEN, blobUri: (k) => store.blobUri(k), port, limitMs: () => 20 });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const first = await sendWaiting(store, t, { userId: MARIA_ID, nowMs: () => 1 });
      expect([first.stopped, first.answered, first.waitingAfter]).toEqual(['network', [], 1]);
      expect(held).toHaveLength(1);
      held[0]!.reject(new Error('iOS gave up after the limit')); // the task ends with no answer, long after
      await new Promise((r) => setTimeout(r, 10));
      expect(await store.waiting()).toHaveLength(1);
      const again = sendWaiting(store, t, { userId: MARIA_ID, nowMs: () => 2 });
      await new Promise((r) => setTimeout(r, 5));
      held[1]!.resolve(answer(KEY, 'duplicate')); // the server heard the first try: the repeat is answered duplicate
      const second = await again;
      expect(second.answered.map((a) => [a.key, a.result])).toEqual([[KEY, 'duplicate']]);
      expect(await store.waiting()).toHaveLength(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // why: F-1763 the batch body file is the running task's: it is removed when the task settles, never at the limit, and a late answer removes the item once
  it('ends a note send at the limit, keeps the body file until the task settles, and a late 200 changes nothing', async () => {
    const { port, held, bodies } = heldPort();
    const t = nativeTransport({ origin: LOCAL, token: SAMPLE_TOKEN, blobUri: () => null, port, limitMs: () => 20 });
    const r = await t.sendItems([{ ...stamp, key: NOTE_KEY, kind: 'note', payload: { text: 'hi' } } as never]);
    expect(r).toEqual({ ok: false, stop: 'network' });
    expect(bodies.map((b) => b.done)).toEqual([false]);
    held[0]!.resolve(answer(NOTE_KEY, 'applied'));
    await new Promise((x) => setTimeout(x, 5));
    expect(bodies.map((b) => b.done)).toEqual([true]);
  });

  // why: F-1763 with no limit given the transport waits as before, so only the app's own setting changes how long a call may take
  it('waits for the answer when no limit is given', async () => {
    const { port, held } = heldPort();
    const t = nativeTransport({ origin: LOCAL, token: SAMPLE_TOKEN, blobUri: () => null, port });
    const p = t.sendItems([{ ...stamp, key: NOTE_KEY, kind: 'note', payload: { text: 'hi' } } as never]);
    await new Promise((x) => setTimeout(x, 30));
    held[0]!.resolve(answer(NOTE_KEY, 'applied'));
    expect(await p).toMatchObject({ ok: true });
  });
});
