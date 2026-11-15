// SPDX-License-Identifier: AGPL-3.0-or-later
// The person's copies on the phone (local.ts forgetPerson and personSignedIn; F-1017 class): the job screens' IndexedDB copies
// (job/store.ts bw-tech-jobs: the last API-101 answer of each job, the note drafts, the finish entries with the signature, the
// technician's name) go with the saved day at sign-out and when a different person signs in. fake-indexeddb stands in for the
// browser's IndexedDB (imported first, so Dexie finds it); the browsers run the same store in ci/tech-job-stack.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobStore, type JobCopy } from './job/store.ts';
import { DexieItemStore } from '@bw/outbox/src/items/index.ts';
import { forgetCount, forgetPerson, KEYS, personSignedIn, signedInPerson, signInRecorded, UNSAVED_HOLD_MS } from './local.ts';
import { SIGN_OUT_OWED } from './session.ts';

const harold = { job: { jobNumber: 24830 }, customer: { name: 'Harold Jenkins', phone: '+16145550148' } } as unknown as JobCopy;

async function keepCopies(): Promise<void> {
  const s = jobStore();
  await s.saveJob(harold, 1);
  await s.saveDraft(24830, 'Replaced 6 ft of condensate hose.');
  await s.saveFinish({ jobNumber: 24830, parts: [], noPartsUsed: true, hours: '1', minutes: '0', workDone: ['Cleaned the flame sensor'], signature: { png: new Uint8Array([137, 80]), at: '2026-09-15T12:50:00-04:00[America/New_York]' } });
  await s.saveMe('Maria Santos');
  window.localStorage.setItem(KEYS.day, '{"data":{"jobs":[{"customer":{"name":"Harold Jenkins"}}]}}');
  window.localStorage.setItem(KEYS.routes, '{"date":"2026-09-15","routes":{"24828":{"steps":[]}}}'); // the kept routes name a destination (P6-WEB-STEPS, rule 11)
}

async function copies(): Promise<unknown[]> {
  const s = jobStore();
  return [await s.job(24830), await s.draft(24830), await s.finish(24830), await s.me(), window.localStorage.getItem(KEYS.day), window.localStorage.getItem(KEYS.routes)];
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
});
afterEach(async () => {
  await jobStore().forgetAll();
  vi.unstubAllGlobals();
});

describe('the job screens\' copies belong to the person', () => {
  // why: FR-AUTH-4 the copies of a job hold the customer's name, phone and notes and the signature, so Sign out forgets them with the saved day
  it('forgets every job copy, draft, finish entry and the name at sign-out', async () => {
    await keepCopies();
    expect((await copies()).every((c) => c !== null)).toBe(true);
    await forgetPerson();
    expect(await copies()).toEqual([null, null, null, null, null, null]);
  });

  // why: FR-AUTH-4 a different person signing in on the phone never sees the one before's customers; the same person keeps their copies
  it('keeps the copies for the same user, and forgets them when a different user signs in', async () => {
    expect(await personSignedIn('user-maria')).toBe(true); // nothing was recorded: nothing of anyone's is trusted
    await keepCopies();
    expect(await personSignedIn('user-maria')).toBe(false);
    expect((await copies()).every((c) => c !== null)).toBe(true);
    expect(await personSignedIn('user-luis')).toBe(true);
    expect(await copies()).toEqual([null, null, null, null, null, null]);
    expect(window.localStorage.getItem(KEYS.person)).toBe('"user-luis"');
  });

  // why: FR-AUTH-4 (F-1042) personSignedIn also runs on a job screen's API-07 answer, so it must leave a sign-out the phone owes: only the 2 sign-in answers (TechSignIn, SignInScreen) clear it, via clearSignOutOwed
  it('leaves the owed sign-out mark alone when a job screen records the person', async () => {
    window.localStorage.setItem(SIGN_OUT_OWED, '1');
    await personSignedIn('user-maria');
    expect(window.localStorage.getItem(SIGN_OUT_OWED)).toBe('1');
  });

  // why: FR-AUTH-4 (F-1041) the screens key the phone's waiting items to the person recorded at sign-in, not to the item store's user, which stays the last API-07 answer until the first sync
  it('reads the person recorded at sign-in, null when none', async () => {
    expect(signedInPerson()).toBeNull();
    await personSignedIn('user-luis');
    expect(signedInPerson()).toBe('user-luis');
  });

  // why: FR-AUTH-4, FR-TECH-4 (F-1127) a sign-in answer saves the item store's user, so the next item entered offline is stamped the person who signed in, not the one whose API-07 answer came last
  it('saves the user of the item store at a sign-in, so the stamp and the screens agree', async () => {
    const store = new DexieItemStore();
    await store.saveUser('user-luis');
    expect(await signInRecorded('user-maria')).toBe(true);
    expect(await new DexieItemStore().user()).toBe('user-maria');
    expect(signedInPerson()).toBe('user-maria');
    await store.saveUser('user-luis');
    expect(await signInRecorded('user-maria')).toBe(false);
    expect(await new DexieItemStore().user()).toBe('user-maria');
  });

  // why: FR-AUTH-4, FR-TECH-4 (F-1241, F-1247) a failed save of the item store's user tells the caller, writes no console line (F-1416), holds the landing a bounded few seconds (only then), and still records the person
  it('tells the caller when the item store\'s user could not be saved, writes no console line, holds the landing a bounded time, and still records the person', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); // fake-indexeddb runs on setImmediate: left real
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const save = vi.spyOn(DexieItemStore.prototype, 'saveUser').mockRejectedValue(new Error('QuotaExceededError'));
    const unsaved = vi.fn();
    let landed = false;
    const p = signInRecorded('user-ana', unsaved).then((changed) => {
      landed = true;
      return changed;
    });
    for (let i = 0; i < 200 && unsaved.mock.calls.length === 0; i += 1) await new Promise<void>((resolve) => setImmediate(resolve)); // the real IndexedDB work first
    await vi.advanceTimersByTimeAsync(UNSAVED_HOLD_MS - 1);
    expect(unsaved).toHaveBeenCalledTimes(1);
    expect(landed, 'the landing waits while the message is on screen').toBe(false);
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe(true);
    expect(signedInPerson()).toBe('user-ana');
    save.mockRestore();
    await signInRecorded('user-ana', unsaved); // saved fine: no hold, no second call
    expect(unsaved).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    vi.useRealTimers();
  });

  // why: F-1247 a failed save with no caller to tell is not held (nothing to read), and writes no console line
  it('does not hold the landing when no one is told of the failed save', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const save = vi.spyOn(DexieItemStore.prototype, 'saveUser').mockRejectedValue(new Error('QuotaExceededError'));
    expect(await signInRecorded('user-ana')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    save.mockRestore();
    warn.mockRestore();
  });

  // why: FR-AUTH-4 (F-1006) forgetting counts at once, before its first await, so a read round begun earlier can tell and saves nothing
  it('counts a forget at once, so an in-flight read round can tell', async () => {
    const before = forgetCount();
    const p = forgetPerson();
    expect(forgetCount()).toBe(before + 1);
    await p;
  });
});
