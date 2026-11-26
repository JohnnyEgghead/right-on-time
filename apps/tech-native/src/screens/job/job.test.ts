// SPDX-License-Identifier: AGPL-3.0-or-later
// The native job screens' data and items end to end on node:fs (P6-NATIVE-JOB): the controller (core.ts), the job data layer
// (data.ts, copies.ts) and the shared engine over the real file store, against the scripted server (fixtures.test-data.ts). The real
// path on the phone is the XCUITest suite (xcuitest/JobUITests.swift) against the Compose stack.
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { dayRoute, partsList, problemType, todayJobs } from '@bw/api';
import { FinishLeave } from '@bw/outbox/src/items/native.ts';
import { Temporal } from '@bw/time';
import { NativeApp, waitingTotal, type NativeDeps } from '../../core.ts';
import { memoryKeychain, nodeDir, SAMPLE_TOKEN } from '../../testing.ts';
import { JobCopies } from './copies.ts';
import { JobData } from './data.ts';
import { HAROLD, haroldJob, jobServer, PARTS } from './fixtures.test-data.ts';
import { checkFinish, emptyFinish, finishWaits, shownNotes, shownPhotos } from './model.ts';
import { compressPhoto } from './photo.ts';
import { signaturePng } from './signature.ts';
import { MapMeReads } from '../mapme/reads.ts';
import { routeRead } from '../mapme/steps.ts';

const LOCAL = 'http://192.168.1.20:8080';
const PASSWORD = 'b'.repeat(12);
let ms = Temporal.Instant.from('2026-11-08T15:30:00Z').epochMilliseconds;
let uuidN = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`;

type Dirs = { items: ReturnType<typeof nodeDir>; settings: ReturnType<typeof nodeDir>; jobs: ReturnType<typeof nodeDir>; mapme: ReturnType<typeof nodeDir>; person: ReturnType<typeof nodeDir> };
type Keychain = ReturnType<typeof memoryKeychain>;

/** The app's services as boot.ts gives them, over the scripted server (or the fetch given). */
function depsFor(server: ReturnType<typeof jobServer>, dirs: Dirs, secrets: Keychain, doFetch: typeof fetch = server.fetch): NativeDeps {
  return {
    itemsDir: dirs.items, settingsDir: dirs.settings, jobsDir: dirs.jobs, mapmeDir: dirs.mapme, personDir: dirs.person, secrets, upload: server.upload, fetch: doFetch,
    deviceNow: () => Temporal.Instant.fromEpochMilliseconds((ms += 1000)), bannerNow: () => ms, uuid, deviceLanguage: 'en-US', device: 'iPhone app (test)',
  };
}

/** The same directories, opened again as a new process opens them. */
const reopened = (dirs: Dirs): Dirs => ({ items: nodeDir(dirs.items.root), settings: nodeDir(dirs.settings.root), jobs: nodeDir(dirs.jobs.root), mapme: nodeDir(dirs.mapme.root), person: nodeDir(dirs.person.root) });

function phone(server: ReturnType<typeof jobServer>, dirs: Dirs = { items: nodeDir(), settings: nodeDir(), jobs: nodeDir(), mapme: nodeDir(), person: nodeDir() }, secrets: Keychain = memoryKeychain()) {
  const app = new NativeApp(depsFor(server, dirs, secrets));
  const data = new JobData(app);
  const relaunch = () => phone(server, reopened(dirs), secrets);
  return { app, data, dirs, secrets, relaunch };
}

/** A signed-in phone (kept session) whose bw-jobs holds a job copy, a draft and the me record. */
async function keptCopies() {
  const p = await signedIn();
  await views(p.data, HAROLD);
  p.data.copies.saveDraft(HAROLD, 'side gate');
  expect(p.data.copies.me()?.name).toBe('Maria Santos');
  return p;
}

async function signedIn(server = jobServer(LOCAL)) {
  const p = phone(server);
  await p.app.open();
  expect(await p.app.saveServer(LOCAL)).toEqual({ ok: true });
  expect(await p.app.signIn('40712', PASSWORD, true)).toEqual({ ok: true });
  await p.app.sync();
  return { ...p, server };
}

const views = async (data: JobData, n: number) => {
  const seen: string[] = [];
  const last = await data.job(n, (v) => seen.push(v.kind === 'job' ? `job${v.fromPhone ? ' (phone)' : ''}` : v.kind));
  return { seen, last };
};

describe('SCR-TEC-04 the job as API-101 answers it, kept on the phone for an open with no signal', () => {
  // why: FR-TECH-8, FR-DISP-27 the job read with signal carries the office's notes with their author and time, and is kept on the phone
  it('reads the job with signal (office note with author and time), keeps it, and opens it again with no signal from the copy', async () => {
    const { app, data, server, relaunch } = await signedIn();
    const r = await views(data, HAROLD);
    expect(r.last.kind).toBe('job');
    if (r.last.kind !== 'job') return;
    expect(r.last.fromPhone).toBe(false);
    const notes = shownNotes(r.last.job, app.snapshot.outbox.waiting, 'Maria Santos');
    expect(notes[0]).toMatchObject({ kind: 'office', author: 'Keisha T.', body: 'The doorbell does not work.', waiting: false });
    expect(server.calls.filter((c) => c.url.endsWith(`/tech/jobs/${HAROLD}`)).every((c) => c.auth === `Bearer ${SAMPLE_TOKEN}`)).toBe(true);
    server.setSignal(false);
    const again = relaunch();
    await again.app.open();
    const off = await views(again.data, HAROLD);
    expect(off.seen).toEqual(['job (phone)', 'job (phone)']);
  });

  // why: F-1092 a read that fails with signal (a server fault) and has no copy to show is a failed read with a retry, never the No signal card; the parts list says the same
  it('answers load_failed (not No signal) for a server fault with no copy, and keeps No signal for a call that never answered', async () => {
    const { data, server } = await signedIn();
    server.state.fault = true;
    expect((await views(data, HAROLD)).last.kind).toBe('load_failed');
    expect(await data.partsRead()).toEqual({ parts: null, failed: true });
    server.setSignal(false);
    expect((await views(data, HAROLD)).last.kind).toBe('not_on_phone');
    expect(await data.partsRead()).toEqual({ parts: null, failed: false });
    server.setSignal(true);
    server.state.fault = false;
    expect((await views(data, HAROLD)).last.kind).toBe('job');
    expect((await data.partsRead()).failed).toBe(false);
  });

  // why: FR-TECH-8 a job that is not on the phone and cannot be read says so; one the office moved away is No longer yours and its copy goes
  it('answers not on this phone with no copy and no signal, and No longer yours (copy dropped) for a 404', async () => {
    const { data, server } = await signedIn();
    server.setSignal(false);
    expect((await views(data, 99999)).last.kind).toBe('not_on_phone');
    server.setSignal(true);
    await views(data, HAROLD);
    expect(data.copies.job(HAROLD)).not.toBeNull();
    server.state.mine.delete(HAROLD);
    expect((await views(data, HAROLD)).last.kind).toBe('not_yours');
    expect(data.copies.job(HAROLD)).toBeNull();
  });

  // why: F-1017 the copies are 1 person's: sign-out clears them, and a different person signed in clears the last person's
  it('clears the copies at sign-out and when API-07 names a different person', async () => {
    const { app, data, server } = await signedIn();
    await views(data, HAROLD);
    data.copies.saveDraft(HAROLD, 'side gate');
    expect(await app.signOut()).toEqual({ ok: true });
    expect(data.copies.job(HAROLD)).toBeNull();
    expect(data.copies.draft(HAROLD)).toBeNull();
    expect(await app.signIn('40712', PASSWORD, true)).toEqual({ ok: true });
    await views(data, HAROLD);
    expect(data.copies.me()?.name).toBe('Maria Santos');
    data.copies.saveDraft(HAROLD, 'kept');
    server.state.userId = '0192f000-0000-7000-8000-00000000bbbb';
    server.state.name = 'Devon Price';
    await data.me();
    expect(data.copies.draft(HAROLD)).toBeNull();
    expect(data.copies.me()?.name).toBe('Devon Price');
  });

  // why: F-1090 a kept session ended by Sign out before any job screen opens (the production order: no JobData made) still clears bw-jobs
  it('clears the copies at a cold-start sign-out with no job screen opened', async () => {
    const { data, dirs, server, secrets } = await keptCopies();
    expect(dirs.jobs.list().length).toBeGreaterThan(0);
    const cold = new NativeApp(depsFor(server, reopened(dirs), secrets));
    await cold.open();
    expect(cold.snapshot.session).not.toBeNull();
    expect(await cold.signOut()).toEqual({ ok: true });
    expect(readdirSync(dirs.jobs.root)).toEqual([]);
    expect(data.copies.me()).toBeNull();
  });

  // why: F-1090 a kept session the server ends with a 401 before any job screen opens still clears bw-jobs (customer copies, drafts, me)
  it('clears the copies when a 401 ends a cold-start session with no job screen opened', async () => {
    const { dirs, server, secrets } = await keptCopies();
    const refused: typeof fetch = async () => new Response(JSON.stringify({
      type: problemType('unauthenticated'), title: 'x', status: 401, code: 'unauthenticated',
      meta: { contract: 'API-07', worldEpoch: 1, demoNow: '2026-09-15T10:28:00-04:00[America/New_York]', viewer: { kind: 'public' }, labels: [] },
    }), { status: 401 });
    const cold = new NativeApp(depsFor(server, reopened(dirs), secrets, refused));
    await cold.open();
    await cold.sync(); // the open trigger's send (SD-47) meets the 401
    await vi.waitFor(() => expect(cold.snapshot.session).toBeNull());
    expect(readdirSync(dirs.jobs.root)).toEqual([]);
  });

  // why: F-1103 a kept session a 401 ends before any Map, Parts or Me screen opened (no lifecycle) still clears bw-mapme, the F-1090 shape
  it('clears the Map, Parts and Me copies when a 401 ends a cold-start session before any of those screens opened', async () => {
    const { dirs, server, secrets } = await keptCopies();
    writeFileSync(path.join(dirs.mapme.root, 'day-000001.json'), '{"user":"x"}');
    const refused: typeof fetch = async () => new Response(JSON.stringify({
      type: problemType('unauthenticated'), title: 'x', status: 401, code: 'unauthenticated',
      meta: { contract: 'API-07', worldEpoch: 1, demoNow: '2026-09-15T10:28:00-04:00[America/New_York]', viewer: { kind: 'public' }, labels: [] },
    }), { status: 401 });
    const cold = new NativeApp(depsFor(server, reopened(dirs), secrets, refused));
    await cold.open();
    await cold.sync();
    await vi.waitFor(() => expect(cold.snapshot.session).toBeNull());
    expect(readdirSync(dirs.mapme.root)).toEqual([]);
  });

  // why: F-1115 who the phone last signed in is kept only while items wait (UD-20): a sign-out with nothing waiting does not leave a name, login and id at rest
  it('keeps the waiting person only while items wait', async () => {
    const { app, dirs } = await signedIn();
    app.person.write({ userId: 'u1', name: 'Maria Santos', login: '40712' });
    expect(await app.signOut()).toEqual({ ok: true });
    expect(readdirSync(dirs.person.root)).toEqual([]);
  });

  // why: F-1369 FR-TECH-13 Directions shows the drive minutes of the route from the van to this job (API-104 with no fromJob), and none with no signal
  it('reads the drive minutes of the leg from the van to this job, and none with no signal', async () => {
    const { data, server } = await signedIn();
    expect(await data.driveMinutes(24831)).toBe(12);
    server.setSignal(false);
    expect(await data.driveMinutes(24831)).toBeNull();
  });

  // why: UI-SPECIFICATION 4.5 rule 11 (F-1311) the leg the job screen reads for its Directions button is kept as that destination's last route read, so Directions has its steps with no signal
  it('keeps the leg it reads for the drive minutes, so Directions has it with no signal', async () => {
    const { data } = await signedIn();
    const window = { start: '2026-09-15T10:00:00-04:00[America/New_York]', end: '2026-09-15T12:00:00-04:00[America/New_York]' };
    const asked: unknown[] = [];
    const stub = {
      call: async (contract: unknown, input?: unknown) => {
        if (contract === todayJobs) return { data: { date: '2026-09-15', jobs: [{ jobNumber: HAROLD, window }], technician: { name: 'Maria Santos' } }, envelope: { meta: { demoNow: '2026-09-15T10:26:00-04:00[America/New_York]' } } };
        if (contract === dayRoute) return { data: { stops: [], legs: [], next: null, branch: 'columbus' } };
        if (contract === partsList) return { data: { parts: [] } };
        if (contract === routeRead) {
          asked.push(input);
          return { data: { leg: { minutes: 12, track: [[1, 2], [3, 4]] }, branch: 'columbus', steps: [{ kind: 'depart' }] } };
        }
        throw new Error('unscripted call');
      },
    };
    const reads = new MapMeReads(stub as never, nodeDir(), 'u1');
    await reads.refresh();
    expect(reads.keptRoute(24831)).toBeNull();
    expect(await data.driveMinutes(24831, reads)).toBe(12);
    expect(reads.keptRoute(24831)?.steps).toEqual([{ kind: 'depart' }]);
    // why: F-1369 the read names this job as the destination and no fromJob: the route starts at the van, not at another job
    expect(asked).toEqual([{ toJob: 24831 }]);
  });
});

describe('SCR-TEC-05 to -07 entries through the file store', () => {
  // why: FR-TECH-4, FR-TECH-3 a note saved offline shows on the job at once with Waiting to send, survives a relaunch, and sends once on reconnect
  it('a note and a draft kept offline survive a relaunch; the note sends once when the signal returns', async () => {
    const { app, data, server, relaunch } = await signedIn();
    await views(data, HAROLD);
    server.setSignal(false);
    data.copies.saveDraft(HAROLD, 'Replaced 6 ft of condensate hose');
    const note = await app.enter({ jobNumber: HAROLD, baseVersion: 3, body: { kind: 'note', payload: { text: 'Hose cracked at trap' } } });
    await app.sync();
    const job = data.copies.job(HAROLD);
    expect(job && shownNotes(job, app.snapshot.outbox.waiting, 'Maria Santos')[0]).toMatchObject({ key: note.key, body: 'Hose cracked at trap', waiting: true });
    const again = relaunch();
    await again.app.open();
    expect(again.app.snapshot.outbox.waiting.map((i) => i.key)).toEqual([note.key]);
    expect(again.data.copies.draft(HAROLD)).toBe('Replaced 6 ft of condensate hose');
    server.setSignal(true);
    await again.app.sync();
    await again.app.sync();
    expect(again.app.snapshot.outbox.waiting).toEqual([]);
    expect(server.ledger.get(note.key)).toBe(1);
  });

  // why: F-1781, F-931 an unconvertible photo (HEIC) goes through the real store, is sent under the unreadable mark, and carries no place
  it('a photo the phone cannot convert is stored and sent as the unreadable text, with no location data', async () => {
    const { app, server } = await signedIn();
    const heic = new Uint8Array([...'\0\0\0\x18ftypheic'].map((c) => c.charCodeAt(0)).concat([...'GPS 39.9612N 82.9988W'].map((c) => c.charCodeAt(0))));
    const c = await compressPhoto({ uri: 'file:///x.heic', width: 4000, height: 3000 }, { jpeg: async () => null, original: async () => heic });
    expect(c.ok).toBe(false);
    const photo = await app.enter({ jobNumber: HAROLD, baseVersion: null, body: { kind: 'photo', contentType: 'image/jpeg' }, blob: c.bytes });
    expect(Buffer.from((await app.store.blob(photo.key)) ?? new Uint8Array(0)).includes('GPS')).toBe(false);
    await app.sync();
    expect(app.snapshot.outbox.waiting).toEqual([]);
    expect(server.photos.get(photo.key)).toEqual({ bytes: c.bytes.byteLength, type: 'image/jpeg', count: 1 });
  });

  // why: FR-TECH-4, FR-TECH-3, FR-IOS-1 a photo queued with no signal survives terminate and relaunch and reaches API-103 once, from its file
  it('a photo queued offline shows Waiting to send, survives a relaunch, and is uploaded once from the store file', async () => {
    const { app, data, server, relaunch } = await signedIn();
    await views(data, HAROLD);
    server.setSignal(false);
    const jpeg = new Uint8Array(4096).fill(7);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
    const photo = await app.enter({ jobNumber: HAROLD, baseVersion: null, body: { kind: 'photo', contentType: 'image/jpeg' }, blob: jpeg });
    await app.sync();
    const job = data.copies.job(HAROLD);
    expect(job && shownPhotos(job, app.snapshot.outbox.waiting, 'Maria Santos')).toEqual([expect.objectContaining({ key: photo.key, waiting: true })]);
    expect(app.store.blobUri(photo.key)).toMatch(/^file:\/\//);
    const again = relaunch();
    await again.app.open();
    expect(again.app.snapshot.outbox.waiting.map((i) => i.key)).toEqual([photo.key]);
    server.setSignal(true);
    await again.app.sync();
    await again.app.sync();
    expect(again.app.snapshot.outbox.waiting).toEqual([]);
    expect(server.photos.get(photo.key)).toEqual({ bytes: 4096, type: 'image/jpeg', count: 1 });
  });

  // why: FR-BILL-3, FR-TECH-14 a finish with neither parts nor No parts used is refused on the phone; with parts it enters the finish and the signature PNG
  it('refuses a finish with neither parts nor No parts used, and enters the finish and the signature as 2 items', async () => {
    const { app, data, server } = await signedIn();
    await views(data, HAROLD);
    const d = { ...emptyFinish(HAROLD), workDone: ['Furnace tune-up, all readings normal'] };
    expect(checkFinish(d, { hours: '2', minutes: '9' })).toEqual({ ok: false, on: 'parts' });
    const withPart = { ...d, parts: [{ partId: PARTS[0]!.partId, name: PARTS[0]!.name, code: PARTS[0]!.code, quantity: 2 }] };
    const c = checkFinish(withPart, { hours: '2', minutes: '9' });
    expect(c).toEqual({ ok: true, payload: { parts: [{ partId: 'p-flt', quantity: 2 }], noPartsUsed: false, laborMinutes: 129, workDone: ['Furnace tune-up, all readings normal'] } });
    if (!c.ok) return;
    server.setSignal(false);
    const fin = await app.enter({ jobNumber: HAROLD, baseVersion: 3, body: { kind: 'finished', payload: c.payload } });
    const png = signaturePng([[{ x: 10, y: 40 }, { x: 120, y: 60 }]], 366, 92);
    const sig = await app.enter({ jobNumber: HAROLD, baseVersion: null, body: { kind: 'signature', contentType: 'image/png' }, blob: png });
    server.setSignal(true);
    await app.sync();
    await app.sync();
    expect(server.ledger.get(fin.key)).toBe(1);
    expect(server.photos.get(sig.key)).toEqual({ bytes: png.byteLength, type: 'image/png', count: 1 });
  });
});

describe('F-1932 the finish screen leaves with its finish and its signature, or stays', () => {
  const payload = { parts: [], noPartsUsed: true, laborMinutes: 30, workDone: ['Tune-up'] };
  const png = signaturePng([[{ x: 10, y: 40 }, { x: 120, y: 60 }]], 366, 92);
  const input = { jobNumber: HAROLD, baseVersion: 3, payload, refusedKey: null, signature: png };
  /** A signed-in phone with no signal whose item files can be refused: the write of the nth item from now on fails. */
  async function failing() {
    const p = await signedIn();
    p.server.setSignal(false);
    await p.app.sync();
    const create = p.dirs.items.create;
    let left = Number.POSITIVE_INFINITY;
    p.dirs.items.create = (name, content) => {
      if (name.startsWith('i-') && (left -= 1) < 0) throw new Error('no space left');
      create(name, content);
    };
    const kinds = () => p.app.snapshot.outbox.waiting.map((i) => i.kind);
    /** The condition the screen closes on (FinishScreen closeNow). */
    const closes = (l: FinishLeave) => finishWaits(HAROLD, p.app.snapshot.outbox.waiting) && !l.owed;
    return { ...p, leaving: new FinishLeave(p.app), kinds, closes, keepFirst: (n: number) => { left = n; } };
  }

  // why: FR-TECH-14, F-1932 a signature that is not kept after its finish was is not lost: the screen stays open and a retry leaves exactly 1 finish and 1 signature
  it('stays open when the signature is not kept, and a retry enters the signature and no second finish', async () => {
    const { leaving, kinds, closes, keepFirst, relaunch } = await failing();
    keepFirst(1);
    await expect(leaving.leave(input)).rejects.toThrow('no space left');
    expect(kinds()).toEqual(['finished']);
    expect(closes(leaving)).toBe(false);
    // the finish that is kept is what leaves: only the signature still changes
    expect(leaving.entriesOf({ parts: 1, signature: 'a' }, { parts: 2, signature: 'b' }, false)).toEqual({ parts: 1, signature: 'b' });
    keepFirst(Number.POSITIVE_INFINITY);
    await leaving.leave(input);
    expect(kinds()).toEqual(['finished', 'signature']);
    expect(closes(leaving)).toBe(true);
    const again = relaunch();
    await again.app.open();
    expect(again.app.snapshot.outbox.waiting.map((i) => i.kind)).toEqual(['finished', 'signature']);
  });

  // why: F-1932 a finish that is not kept takes no signature with it: neither is on the phone, and a retry enters both
  it('keeps neither when the finish is not kept', async () => {
    const { leaving, kinds, closes, keepFirst } = await failing();
    keepFirst(0);
    await expect(leaving.leave(input)).rejects.toThrow('no space left');
    expect(kinds()).toEqual([]);
    expect(leaving.owed).toBe(false);
    keepFirst(Number.POSITIVE_INFINITY);
    await leaving.leave(input);
    expect(kinds()).toEqual(['finished', 'signature']);
    expect(closes(leaving)).toBe(true);
  });
});

describe('F-985 an item whose file no longer parses still waits on the phone', () => {
  // why: F-985 a damaged item counts in the waiting count (the header reads 1 waiting, not All synced) and is listed by key for SCR-TEC-09
  it('counts a damaged item file in the waiting total and lists its key, before and after a relaunch', async () => {
    const { app, dirs, relaunch } = await signedIn();
    expect(waitingTotal(app.snapshot)).toBe(0);
    const key = '00000000-0000-4000-8000-0000000d0d0d';
    writeFileSync(path.join(dirs.items.root, `i-${'9'.repeat(12)}-${key}-000001.json`), '{"key": "unfinished');
    await app.sync();
    expect(app.snapshot.outbox.waiting).toEqual([]);
    expect(app.snapshot.damaged).toEqual([key]);
    expect(waitingTotal(app.snapshot)).toBe(1);
    const again = relaunch();
    await again.app.open();
    expect(again.app.snapshot.damaged).toEqual([key]);
    expect(waitingTotal(again.app.snapshot)).toBe(1);
    // the file stays: only an answer removes an item (I2)
    expect(readdirSync(dirs.items.root).filter((n) => n.includes(key))).toHaveLength(1);
  });

  // why: F-985 sign-out is refused while a damaged item sits on the phone, as for any waiting item (UD-20)
  it('refuses sign-out while only a damaged item waits', async () => {
    const { app, dirs } = await signedIn();
    writeFileSync(path.join(dirs.items.root, `i-${'9'.repeat(12)}-00000000-0000-4000-8000-0000000d0d0e-000001.json`), 'not json');
    await app.sync();
    expect(await app.signOut()).toEqual({ ok: false, waiting: 1, damaged: true });
    expect(app.snapshot.session).not.toBeNull();
  });

  // why: F-1093 (owner ruling "Allow sign-out, warn") the warned sign-out deletes the damaged item and signs out; a readable item still refuses it (UD-20)
  it('signs out once the damaged item is confirmed lost, and still refuses while a readable item waits', async () => {
    const { app, dirs, server } = await signedIn();
    const file = path.join(dirs.items.root, `i-${'9'.repeat(12)}-00000000-0000-4000-8000-0000000d0d0f-000001.json`);
    writeFileSync(file, 'not json');
    server.setSignal(false);
    await app.enter({ jobNumber: HAROLD, baseVersion: 3, body: { kind: 'note', payload: { text: 'kept' } } });
    await app.sync();
    expect(await app.signOut(true)).toEqual({ ok: false, waiting: 2, damaged: false });
    expect(app.snapshot.session).not.toBeNull();
    server.setSignal(true);
    await app.sync();
    await app.sync();
    expect(await app.signOut()).toEqual({ ok: false, waiting: 1, damaged: true });
    expect(readdirSync(dirs.items.root).filter((n) => n.includes('0d0d0f'))).toHaveLength(1);
    expect(await app.signOut(true)).toEqual({ ok: true });
    expect(readdirSync(dirs.items.root).filter((n) => n.includes('0d0d0f'))).toEqual([]);
    expect(app.snapshot.session).toBeNull();
    expect(app.snapshot.damaged).toEqual([]);
  });
});

describe('No signal on the native phone', () => {
  // why: FR-TECH-4 a fetch with no answer is No signal however the platform rejects it (React Native can reject with a plain Error), CTL-CMP-10-01
  it('reads a fetch rejected with a plain Error as no signal, and the signal back on the next send', async () => {
    const server = jobServer(LOCAL);
    let plain = false;
    const realFetch = server.fetch;
    server.fetch = async (input, init) => {
      if (plain) throw new Error('The network connection was lost.');
      return realFetch(input, init);
    };
    const { app } = await signedIn(server);
    expect(app.snapshot.outbox.online).toBe(true);
    plain = true;
    await app.sync();
    expect(app.snapshot.outbox.online).toBe(false);
    plain = false;
    await app.sync();
    expect(app.snapshot.outbox.online).toBe(true);
  });
});

describe('copies.ts keeps each record by the file rule', () => {
  // why: FR-TECH-4, FR-TECH-14 a record survives a kill mid-write: a damaged newer revision falls back to the last good one, and a temporary goes at open
  it('reads the highest revision that parses, removes temporaries at open, and forgets every record', () => {
    const dir = nodeDir();
    const c = new JobCopies(dir);
    c.saveJob(haroldJob());
    c.saveJob(haroldJob({ version: 4 }));
    expect(readdirSync(dir.root).filter((n) => n.startsWith('r-job-'))).toEqual(['r-job-24830-000002.json']);
    writeFileSync(path.join(dir.root, 'r-job-24830-000003.json'), '{"job": ');
    writeFileSync(path.join(dir.root, 'tmp-killed'), 'half');
    const again = new JobCopies(nodeDir(dir.root));
    expect(again.job(HAROLD)?.job.version).toBe(4);
    expect(readdirSync(dir.root)).not.toContain('tmp-killed');
    again.saveFinish({ ...emptyFinish(HAROLD), noPartsUsed: true });
    again.saveParts(PARTS);
    expect(again.finish(HAROLD)?.noPartsUsed).toBe(true);
    expect(again.parts()).toHaveLength(3);
    again.forgetAll();
    expect(readdirSync(dir.root)).toEqual([]);
  });
});
