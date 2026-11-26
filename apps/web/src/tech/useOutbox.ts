// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The page's 1 item engine (engine.ts) over the browser's IndexedDB store, and the hook the technician screens read it
// through. Created on first use in the browser, never on the server. Its triggers follow SD-47 and UI-SPECIFICATION 4.5
// rule 5: a sync on open, when the browser reports the connection back, on focus or when the page is shown again, and
// every 60 s while the page is open.
//
// window.__bwTechOutbox: the entry seam (enter, sync) for a driver with no screen of its own. G-CI1's client case enters
// its note and photo through it until the Add note and Add photo screens (P5-TWA-JOB) let the test type them; it is the
// same enter() those screens call, so the store, the stamp and the send under test are the real ones.
import { appInfo, createClient } from '@bw/api';
import { DexieItemStore } from '@bw/outbox/src/items/index.ts';
import { realNow } from '@bw/time';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { SYNC_CALL_LIMIT_MS, SYNC_EVERY_MS, TechOutbox, uploadLimitMs, type OutboxState } from './engine.ts';
import { signedInPerson } from './local.ts';
import { webTransport } from './transport.ts';

let engine: TechOutbox | null = null;

/** A short device name for the sync report (API-162 device): the kind of phone or computer, never the full user agent. */
function deviceName(ua: string): string {
  if (/iPhone|iPad|iPod/.test(ua)) return 'iPhone web app';
  if (/Android/.test(ua)) return 'Android web app';
  return 'Web app';
}

export function techOutbox(): TechOutbox {
  if (engine) return engine;
  const base = window.location.origin;
  // F-1746: every call of a sync has a time limit, so a request that never answers cannot hold Sending and every later sync.
  const client = createClient({ baseUrl: base, timeoutMs: SYNC_CALL_LIMIT_MS });
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  const e = new TechOutbox({
    store: new DexieItemStore(),
    transport: webTransport(client, { baseUrl: base, limitMs: uploadLimitMs }),
    client,
    deviceNow: () => realNow('device_stamp'),
    bannerNow: () => realNow('tech_waiting_banner').epochMilliseconds,
    isOnline: () => navigator.onLine,
    device: deviceName(navigator.userAgent),
    ...(locks ? { lock: <T,>(fn: () => Promise<T>) => locks.request('bw-tech-items-send', fn) as Promise<T> } : {}),
  });
  engine = e;
  // Ask the browser to keep this origin's storage under pressure (OQ-18); the store works without it.
  void navigator.storage?.persist?.().catch(() => undefined);
  void client.call(appInfo, {}).then((r) => e.setVersion(r.data.sourceCommit), () => undefined);
  const kick = () => void e.sync();
  window.addEventListener('online', kick);
  window.addEventListener('offline', () => void e.refresh());
  window.addEventListener('focus', kick);
  window.addEventListener('pageshow', kick);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
  window.setInterval(kick, SYNC_EVERY_MS);
  (window as Window & { __bwTechOutbox?: unknown }).__bwTechOutbox = {
    enter: e.enter.bind(e), sync: e.sync.bind(e), state: () => e.snapshot,
  };
  void e.refresh().then(kick);
  return e;
}

const SERVER: OutboxState = { ready: false, waiting: [], online: true, sending: false, oldCount: 0, lastSent: [], signedOut: false };

/** The items entered under the signed-in person (F-1033); a state with no person (a preview's) is shown whole. */
export function ownItems<T extends { userId?: string | undefined }>(items: readonly T[], userId: string | null | undefined): T[] {
  return userId === undefined ? [...items] : items.filter((i) => userId !== null && i.userId === userId);
}

/**
 * The engine's state with only the signed-in person's waiting and just-sent items, for the job, Today and waiting screens: other people's
 * items can still sit in the store (a session ended with items waiting, then someone else signed in), and they send only under their own
 * technician (send.ts). The sign-out guard and the header count read useOutbox whole (UD-20 counts every item on the phone).
 */
export function useOwnOutbox(fixed?: OutboxState): OutboxState {
  const s = useOutbox(fixed);
  // F-1041: the person the phone recorded at sign-in comes first; the store's user is the last API-07 answer, which stays the previous
  // technician's until the first sync after a sign-in answers (and for good if that sync fails).
  const who = fixed ? s.userId : signedInPerson() ?? s.userId;
  // F-1931: each list keeps its identity until the engine sets a new one. A screen reads its job again when lastSent changes, and a sync that
  // sends nothing changes the state several times.
  const waiting = useMemo(() => ownItems(s.waiting, who), [s.waiting, who]);
  const lastSent = useMemo(() => ownItems(s.lastSent, who), [s.lastSent, who]);
  return useMemo(() => ({ ...s, waiting, lastSent }), [s, waiting, lastSent]);
}

/** The engine's state for a screen; starts the engine on the page's first use. A fixed state is a preview's. */
export function useOutbox(fixed?: OutboxState): OutboxState {
  const live = useSyncExternalStore(
    (fn) => (fixed ? () => undefined : techOutbox().subscribe(fn)),
    () => (fixed ?? (engine ? engine.snapshot : SERVER)),
    () => fixed ?? SERVER,
  );
  useEffect(() => {
    if (!fixed) techOutbox();
  }, [fixed]);
  return live;
}
