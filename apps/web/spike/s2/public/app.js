// SPDX-License-Identifier: AGPL-3.0-or-later
// Spike S2 (G-S2-TWA-OFFLINE): THROWAWAY app logic. IndexedDB item store (SPECIFICATIONS 4.6):
// every note or photo is saved on the phone first with its own idempotency key, then sent when
// there is signal. An item turns "sent" only after the server answers; a retry reuses the key,
// so the server stores it once. Sending runs on open, on the "online" event, when the app comes
// back to the front, every 15 s while visible, and from the "Send now" button.
'use strict';

const DB_NAME = 'bw-s2';
const API = 'api/';
const $ = (id) => document.getElementById(id);

function newKey() {
  if (self.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('items', { keyPath: 'key' });
      r.result.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function tx(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => { db.close(); resolve(out && 'result' in out ? out.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
  }));
}
const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());
const put = (store, value) => tx(store, 'readwrite', (s) => s.put(value));
const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));

async function saveItem(kind, type, data, label) {
  await put('items', { key: newKey(), kind, type, data, label, bytes: data.byteLength,
    createdAt: new Date().toISOString(), state: 'queued', tries: 0 });
  await render();
  flush('saved');
}

let flushing = false;
async function flush(why) {
  if (flushing) return;
  flushing = true;
  let sent = 0;
  let failed = '';
  try {
    const queued = (await getAll('items')).filter((i) => i.state === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const item of queued) {
      item.tries += 1;
      let res;
      try {
        res = await fetch(API + 'items', {
          method: 'POST',
          headers: { 'Idempotency-Key': item.key, 'X-Item-Kind': item.kind, 'Content-Type': item.type },
          body: item.data,
        });
      } catch (e) {
        failed = 'no signal (' + (e && e.name) + ')';
        await put('items', item);
        break;
      }
      if (res.status === 200 || res.status === 201) {
        const body = await res.json();
        item.state = 'sent';
        item.result = body.result;
        item.sentAt = new Date().toISOString();
        await put('items', item);
        sent += 1;
      } else {
        failed = 'server said ' + res.status;
        await put('items', item);
        break;
      }
    }
  } finally {
    flushing = false;
  }
  $('send-msg').textContent = new Date().toLocaleTimeString() + ' (' + why + '): sent ' + sent +
    (failed ? ', stopped: ' + failed : '');
  await render();
  if (sent > 0 || why === 'open' || why === 'online') sendStatus(why);
}

// OQ-18 evidence: what this install keeps between opens. Opens are logged on the phone and sent
// with the next status beacon, so opens with no signal still reach the server log later.
async function recordOpen() {
  await put('events', { at: new Date().toISOString(), online: navigator.onLine,
    controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    queued: (await getAll('items')).filter((i) => i.state === 'queued').length });
}

async function sendStatus(why) {
  try {
    const items = await getAll('items');
    const events = await getAll('events');
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
    const body = {
      why, at: new Date().toISOString(), standalone: isStandalone(),
      controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller), persisted,
      usage: est && est.usage, quota: est && est.quota,
      items: items.map((i) => ({ key: i.key, kind: i.kind, bytes: i.bytes, state: i.state, tries: i.tries,
        createdAt: i.createdAt, sentAt: i.sentAt || null })),
      opens: events,
    };
    const res = await fetch(API + 'status', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    if (res.ok) for (const e of events) await del('events', e.id);
  } catch {
    /* no signal: the opens stay on the phone for the next beacon */
  }
}

function isStandalone() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}

async function render() {
  $('net').textContent = navigator.onLine ? 'on' : 'off';
  $('mode').textContent = isStandalone() ? 'Home Screen app' : 'Safari tab';
  $('sw').textContent = navigator.serviceWorker && navigator.serviceWorker.controller ? 'ready' : 'not yet';
  const items = (await getAll('items')).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const queued = items.filter((i) => i.state === 'queued').length;
  $('counts').textContent = '(' + queued + ' waiting, ' + (items.length - queued) + ' sent)';
  const ul = $('items');
  ul.textContent = '';
  for (const i of items) {
    const li = document.createElement('li');
    li.dataset.key = i.key;
    li.dataset.state = i.state;
    const s = document.createElement('span');
    s.className = 'state';
    s.textContent = i.state === 'sent' ? 'Sent' : 'Waiting';
    li.append(s, ' ' + i.kind + ': ' + i.label + ' (' + i.bytes + ' bytes) key ' + i.key.slice(0, 8));
    ul.append(li);
  }
}

$('save-note').addEventListener('click', async () => {
  const text = $('note').value.trim();
  if (!text) return;
  const data = new TextEncoder().encode(text).buffer;
  $('note').value = '';
  await saveItem('note', 'text/plain; charset=utf-8', data, text.slice(0, 40));
});

$('photo').addEventListener('change', async () => {
  const f = $('photo').files && $('photo').files[0];
  if (!f) return;
  // Stored as an ArrayBuffer, not a Blob: the plainest value IndexedDB keeps on every WebKit.
  const data = await f.arrayBuffer();
  $('photo').value = '';
  $('photo-msg').textContent = 'Saved photo ' + f.name + ' (' + data.byteLength + ' bytes)';
  await saveItem('photo', f.type || 'application/octet-stream', data, f.name);
});

$('send').addEventListener('click', () => flush('button'));
addEventListener('online', () => { render(); flush('online'); });
addEventListener('offline', () => render());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flush('front'); });
setInterval(() => { if (document.visibilityState === 'visible') flush('timer'); }, 15000);

(async () => {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js', { scope: './' });
      navigator.serviceWorker.addEventListener('controllerchange', () => render());
    } catch (e) {
      $('sw').textContent = 'failed: ' + e.message;
    }
  }
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch { /* not offered */ }
  }
  await recordOpen();
  await render();
  flush('open');
})();
