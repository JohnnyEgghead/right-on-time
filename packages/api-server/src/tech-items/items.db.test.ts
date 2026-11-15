// SPDX-License-Identifier: AGPL-3.0-or-later
// The technician item protocol (SPECIFICATIONS section 5.1, SD-16, D14; invariant 1) on the real database (PostgreSQL 18,
// the migrated schema, P2-SEED's reference seed) through the production kernel as bw_web, with technicians and a
// dispatcher whose sessions the real session layer made. The 36 conflict-table cells are gate G-CI1's
// (ci/gates/G-CI1/cells.db.test.ts); this file holds the rest of the protocol. Run by G-CI1 and by G-CI7 step 3.
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatTime, realNow, Temporal } from '@bw/time';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import {
  answers, blobQuery, DEMO0, demoAt, item, jpeg, MIN, noParts, noteOf, png, REAL0, techWorld, wire, ZONE, type Tech, type TechWorld,
} from './testing.ts';
import { halvesJpeg, sizeOf } from './test-images.ts';

const db = useMigratedDatabase();
/** A timestamptz as Temporal prints an instant (what demoAt(...).toString() gives). */
const iso = (d: Date | null | undefined): string | null => (d ? Temporal.Instant.fromEpochMilliseconds(d.getTime()).toString() : null);
let w: TechWorld;
let maria: Tech;
let kevin: Tech;

beforeAll(async () => {
  w = await techWorld(db);
  [maria, kevin] = w.techs;
}, 120_000);
afterAll(async () => {
  await w?.close();
});
beforeEach(async () => {
  await w.runningClock(demoAt('11:06'));
});

const job = async (n: number) => (await w.rows<{ status: string; version: number; on_the_way_at: Date | null; arrived_at: Date | null; texted_arrival: Date | null }>(
  'SELECT status, version, on_the_way_at, arrived_at, texted_arrival FROM world.job WHERE job_number = $1', [n]))[0]!;
const history = async (n: number) => w.rows<{ kind: string; at: Date; from_version: number; to_version: number; data: Record<string, unknown> }>(
  'SELECT kind, at, from_version, to_version, data FROM world.job_change WHERE job_number = $1 ORDER BY id', [n]);
const texts = async (n: number) => w.rows<{ kind: string; status: string; body: string }>('SELECT kind, status, body FROM world.outbox_text WHERE job_number = $1', [n]);
const tokens = async (n: number) => w.rows<{ kind: string; ended_at: Date | null }>('SELECT kind, ended_at FROM world.link_token WHERE job_number = $1', [n]);
const ledger = async (key: string) => w.rows<{ result: string; demo_time_rebased: Date | null }>('SELECT result, demo_time_rebased FROM world.tech_item WHERE key = $1', [key]);

describe('exactly once (invariant 1, section 5.1 step 3)', () => {
  // why: FR-TECH-4, invariant 1
  it('answers a repeated key duplicate with nothing applied twice, across sends and within 1 send', async () => {
    const n = await w.newJob();
    const note = item({ kind: 'note', jobNumber: n, baseVersion: 1, entered: demoAt('10:30'), payload: noteOf() });
    expect((await answers(await w.send([note], maria)))[0]).toMatchObject({ result: 'applied', code: null });
    expect((await answers(await w.send([note, note], maria))).map((a) => a.result)).toEqual(['duplicate', 'duplicate']);
    const fresh = item({ kind: 'note', jobNumber: n, baseVersion: 1, entered: demoAt('10:31'), payload: noteOf('Second') });
    expect((await answers(await w.send([fresh, fresh], maria))).map((a) => a.result)).toEqual(['applied', 'duplicate']);
    expect(await w.rows('SELECT 1 FROM world.note WHERE job_number = $1', [n])).toHaveLength(2);
    expect((await history(n)).filter((h) => h.kind === 'note_added')).toHaveLength(2);
  });

  // why: FR-TECH-4, invariant 1
  it('applies a key once when 2 sends of it race (the second waits on the key, then reads its answer)', async () => {
    const n = await w.newJob();
    const arrived = item({ kind: 'arrived', jobNumber: n, baseVersion: 1, entered: demoAt('10:41') });
    const [a, b] = await Promise.all([w.send([arrived], maria), w.send([arrived], maria)]);
    expect([(await answers(a))[0]?.result, (await answers(b))[0]?.result].sort()).toEqual(['applied', 'duplicate']);
    expect((await history(n)).filter((h) => h.kind === 'status')).toHaveLength(1);
    expect((await job(n)).version).toBe(2);
  });

  // why: FR-TECH-6, invariant 1
  it('answers the other app\'s copy of a status (a new key, no forward move) duplicate and changes nothing', async () => {
    const n = await w.newJob();
    await answers(await w.send([item({ kind: 'arrived', jobNumber: n, baseVersion: 1, entered: demoAt('10:41') })], maria));
    const copy = item({ kind: 'arrived', jobNumber: n, baseVersion: 1, entered: demoAt('10:41') });
    expect((await answers(await w.send([copy], maria)))[0]?.result).toBe('duplicate');
    expect((await job(n)).version).toBe(2);
  });

  // why: SD-12, invariant 1
  it('answers an item and a photo from an erased world world_reset, applies neither, and repeats the answer', async () => {
    const n = await w.newJob();
    await w.setClock({ moves: [{ kind: 'reset', atReal: REAL0.subtract({ hours: 2 }), toDemo: demoAt('07:00') }], demoNow: demoAt('07:00'), worldEpoch: 2 });
    const note = item({ kind: 'note', jobNumber: n, baseVersion: 1, entered: demoAt('10:30'), payload: noteOf(), worldEpoch: 1 });
    const first = (await answers(await w.send([note], maria)))[0];
    expect(first).toMatchObject({ result: 'world_reset', messageKey: 'tech.item.worldReset' });
    expect((await answers(await w.send([note], maria)))[0]).toMatchObject({ result: 'duplicate', messageKey: 'tech.item.worldReset' });
    const q = blobQuery({ kind: 'photo', jobNumber: n, entered: demoAt('10:31'), worldEpoch: 1 });
    const r = await w.upload(q, jpeg(), 'image/jpeg', maria);
    expect([r.status, ((await r.json()) as { data: { result: string } }).data.result]).toEqual([200, 'world_reset']);
    expect(await w.rows('SELECT 1 FROM world.note WHERE job_number = $1 UNION ALL SELECT 1 FROM world.photo WHERE job_number = $1', [n])).toEqual([]);
    await w.setClock({ moves: [], demoNow: demoAt('11:06'), worldEpoch: 1 });
  });
});

describe('1 item that fails the same way every time fails only itself (section 5.1 step 10; F-469)', () => {
  // why: F-469
  it('answers world_reset for a job the reset world no longer holds with no ledger row, and commits the good note beside it', async () => {
    const n = await w.newJob();
    await w.setClock({ moves: [{ kind: 'reset', atReal: REAL0.subtract({ hours: 2 }), toDemo: demoAt('07:00') }], demoNow: demoAt('07:00'), worldEpoch: 2 });
    const gone = item({ kind: 'note', jobNumber: 987654321, baseVersion: 1, entered: demoAt('10:30'), payload: noteOf(), worldEpoch: 1 });
    const good = item({ kind: 'note', jobNumber: n, baseVersion: 1, entered: demoAt('10:31'), payload: noteOf('Kept'), worldEpoch: 2 });
    const r = await answers(await w.send([gone, good], maria));
    expect(r.map((a) => a.result)).toEqual(['world_reset', 'applied']);
    expect(await ledger(gone.key as string)).toEqual([]);
    expect(await w.rows('SELECT 1 FROM world.note WHERE job_number = $1', [n])).toHaveLength(1);
    await w.setClock({ moves: [], demoNow: demoAt('11:06'), worldEpoch: 1 });
  });

  // why: F-469, F-493 the photo path's half: a blob for a job the reset world no longer holds answers world_reset, with no ledger row to break
  it('answers world_reset to a photo for a job the reset world no longer holds', async () => {
    await w.setClock({ moves: [{ kind: 'reset', atReal: REAL0.subtract({ hours: 2 }), toDemo: demoAt('07:00') }], demoNow: demoAt('07:00'), worldEpoch: 2 });
    const r = await w.upload(blobQuery({ kind: 'photo', jobNumber: 987654321, entered: demoAt('10:31'), worldEpoch: 1 }), jpeg(), 'image/jpeg', maria);
    expect([r.status, ((await r.json()) as { data: { result: string } }).data.result]).toEqual([200, 'world_reset']);
    await w.setClock({ moves: [], demoNow: demoAt('11:06'), worldEpoch: 1 });
  });

  // why: F-469, F-493 PostgreSQL text cannot hold a NUL: API-162 refuses it at the contract, where it answered 500
  it('refuses a sync report whose text holds a NUL with 422', async () => {
    const good = (await w.rows<{ n: number }>('SELECT count(*)::int AS n FROM world.app_sync_report'))[0]!.n;
    const r = await w.post('/tech/sync-reports', { app: 'native', waitingCount: 0, lastSyncAt: wire(REAL0), device: 'a\u0000b', version: '1.0.0' }, maria);
    expect(r.status).toBe(422);
    expect((await w.rows<{ n: number }>('SELECT count(*)::int AS n FROM world.app_sync_report'))[0]!.n).toBe(good);
  });

  // why: F-469
  // why: F-867 (owner ruling 546d6f1e): validation_failed is answered flagged and listed for the dispatcher, not left on the phone
  it('flags a note with a NUL and a part quantity over the maximum alone, lists both, and commits the good note', async () => {
    const n = await w.newJob({ status: 'on_site' });
    const part = (await w.rows<{ id: string }>('SELECT id FROM world.part ORDER BY code LIMIT 1'))[0]!.id;
    const nul = item({ kind: 'note', jobNumber: n, baseVersion: 1, entered: demoAt('10:30'), payload: noteOf('a\u0000b') });
    const big = item({ kind: 'finished', jobNumber: n, baseVersion: 1, entered: demoAt('10:32'),
      payload: { parts: [{ partId: part, quantity: 3_000_000_000 }], noPartsUsed: false, laborMinutes: 30, workDone: ['Done'] } });
    const good = item({ kind: 'note', jobNumber: n, baseVersion: 1, entered: demoAt('10:31'), payload: noteOf('Kept') });
    const r = await answers(await w.send([nul, big, good], maria));
    expect(r.map((a) => [a.result, a.code])).toEqual([['flagged', 'validation_failed'], ['flagged', 'validation_failed'], ['applied', null]]);
    expect((await w.rows<{ message_key: string }>('SELECT message_key FROM world.offline_conflict WHERE job_number = $1', [n])).map((x) => x.message_key))
      .toEqual(['offline.flag.validation_failed', 'offline.flag.validation_failed']);
    expect((await w.rows<{ body: string }>('SELECT body FROM world.note WHERE job_number = $1', [n])).map((x) => x.body)).toEqual(['Kept']);
  });

  // why: F-488
  it('refuses alone an item over a contract cap, of an unknown kind or with a bad time, and commits the good note in the same send', async () => {
    const n = await w.newJob({ status: 'on_site' });
    const long = item({ kind: 'note', jobNumber: n, baseVersion: 1, entered: demoAt('10:30'), payload: noteOf('x'.repeat(2001)) });
    const lines = item({ kind: 'finished', jobNumber: n, baseVersion: 1, entered: demoAt('10:32'),
      payload: { parts: [], noPartsUsed: true, laborMinutes: 30, workDone: Array.from({ length: 21 }, (_, i) => `Line ${i}`) } });
    const odd: Record<string, unknown> = { ...item({ kind: 'arrived', jobNumber: n, baseVersion: 1, entered: demoAt('10:33') }), kind: 'teleported' };
    const badTime: Record<string, unknown> = { ...item({ kind: 'arrived', jobNumber: n, baseVersion: 1, entered: demoAt('10:34') }), demoTime: '2026-09-15T10:34:00-07:00[America/New_York]' };
    const good = item({ kind: 'note', jobNumber: n, baseVersion: 1, entered: demoAt('10:31'), payload: noteOf('Kept') });
    const res = await w.send([long, lines, odd, good, badTime], maria);
    expect(res.status).toBe(200);
    const r = await answers(res);
    expect(r.map((a) => [a.key, a.result, a.code])).toEqual([
      [long.key, 'refused', 'validation_failed'], [lines.key, 'refused', 'validation_failed'], [odd.key, 'refused', 'validation_failed'],
      [good.key, 'applied', null], [badTime.key, 'refused', 'validation_failed'],
    ]);
    expect((await w.rows<{ body: string }>('SELECT body FROM world.note WHERE job_number = $1', [n])).map((x) => x.body)).toEqual(['Kept']);
    expect((await job(n)).status).toBe('on_site');
  });
});

describe('On my way after an arrival (FR-TEXT-19, OA-50, OI-3; section 5.1 step 9)', () => {
  // why: FR-TEXT-19, F-470
  it('applied on its own: the job goes On the way, a live map token starts and the on-the-way text is queued (the control)', async () => {
    const n = await w.newJob({ customerId: w.texting[0] });
    expect((await answers(await w.send([item({ kind: 'on_my_way', jobNumber: n, baseVersion: 1, entered: demoAt('10:28') })], maria)))[0]?.result).toBe('applied');
    const j = await job(n);
    expect(j.status).toBe('on_the_way');
    const tok = await w.rows<{ token: string; kind: string; ended_at: Date | null }>('SELECT token, kind, ended_at FROM world.link_token WHERE job_number = $1', [n]);
    expect(tok.map((t) => [t.kind, t.ended_at])).toEqual([['live_map', null]]);
    // F-470: the shipped text.on_the_way, rendered by P3-TEXTS's sendOnTheWay: the arrival is texted_arrival (the ETA
    // from 10:28 rounded to 5 minutes) and the link carries the live map token on the text link host.
    const arrival = Temporal.Instant.fromEpochMilliseconds(j.texted_arrival!.getTime());
    expect(arrival.epochMilliseconds % (5 * MIN)).toBe(0);
    expect(Temporal.Instant.compare(arrival, demoAt('10:25'))).toBeGreaterThanOrEqual(0);
    const t = await w.rows<{ kind: string; status: string; body: string; link_token: string | null }>(
      'SELECT kind, status, body, link_token FROM world.outbox_text WHERE job_number = $1', [n]);
    expect(t.map((x) => [x.kind, x.status, x.link_token])).toEqual([['on_the_way', 'queued', tok[0]!.token]]);
    const name = maria.nameInTexts;
    expect(t[0]?.body).toBe(`Brightwater: ${name} is on the way! Arriving about ${formatTime(arrival, ZONE, 'en')}. Follow the van: bw.j7l.io/m/${tok[0]!.token} (this link stops working when ${name} arrives).`);
  });

  // why: FR-TEXT-3, F-470
  it('applied for a customer with texts off: the job goes On the way with no text, no live map token and no texted arrival', async () => {
    const off = w.quiet.at(-1)!;
    expect(w.texting).not.toContain(off);
    const n = await w.newJob({ customerId: off });
    expect((await answers(await w.send([item({ kind: 'on_my_way', jobNumber: n, baseVersion: 1, entered: demoAt('10:28') })], maria)))[0]?.result).toBe('applied');
    const j = await job(n);
    expect([j.status, iso(j.on_the_way_at), j.texted_arrival]).toEqual(['on_the_way', demoAt('10:28').toString(), null]);
    expect([await texts(n), await tokens(n)]).toEqual([[], []]);
    expect((await answers(await w.send([item({ kind: 'arrived', jobNumber: n, baseVersion: 2, entered: demoAt('10:41') })], maria)))[0]?.result).toBe('applied');
    expect([(await job(n)).status, await texts(n), await tokens(n)]).toEqual(['on_site', [], []]);
  });

  // why: FR-TEXT-19
  it('Maria taps On my way at 10:28 and Arrived at 10:41, offline; both sync at 11:06: no text, On site, no location shared, history only', async () => {
    const n = await w.newJob({ customerId: w.texting[1] });
    const omw = item({ kind: 'on_my_way', jobNumber: n, baseVersion: 1, entered: demoAt('10:28') });
    const arr = item({ kind: 'arrived', jobNumber: n, baseVersion: 1, entered: demoAt('10:41') });
    const a = await answers(await w.send([omw, arr], maria));
    expect(a.map((x) => [x.result, x.messageKey])).toEqual([['history_only', 'tech.item.historyOnly'], ['applied', null]]);
    const j = await job(n);
    expect([j.status, j.on_the_way_at, iso(j.arrived_at)]).toEqual(['on_site', null, demoAt('10:41').toString()]);
    expect(await texts(n)).toEqual([]);
    expect(await tokens(n)).toEqual([]);
    const late = (await history(n)).find((h) => h.kind === 'history_only');
    expect(late?.data).toMatchObject({ item: 'on_my_way', offlineAt: wire(demoAt('10:28')), sentAt: wire(demoAt('11:06')) });
    expect(late?.from_version).toBe(late?.to_version);
  });

  // why: FR-TEXT-19
  it('holds when the arrival reached the server before the queued On my way', async () => {
    const n = await w.newJob({ customerId: w.texting[2] });
    await answers(await w.send([item({ kind: 'arrived', jobNumber: n, baseVersion: 1, entered: demoAt('10:41') })], maria));
    const r = await answers(await w.send([item({ kind: 'on_my_way', jobNumber: n, baseVersion: 1, entered: demoAt('10:28') })], maria));
    expect(r[0]?.result).toBe('history_only');
    expect([(await job(n)).status, await texts(n), await tokens(n)]).toEqual(['on_site', [], []]);
  });

  // why: FR-TEXT-19, REQUIREMENTS 4.3, F-472
  it('holds when the arrival was applied first and the office then set the status: the late On my way is history only, not flagged', async () => {
    const n = await w.newJob({ customerId: w.texting[2] });
    await answers(await w.send([item({ kind: 'arrived', jobNumber: n, baseVersion: 1, entered: demoAt('10:41') })], maria));
    // The office sets the status after the arrival (version 2 to 3): the column an On my way based on version 1 meets is Status set by the office.
    await w.admin().query(
      `INSERT INTO world.job_change (job_number, at, actor_user_id, actor_kind, kind, from_version, to_version, data)
       VALUES ($1, $2, $3, 'office', 'status_set', 2, 3, $4::jsonb)`,
      [n, demoAt('10:55').toString(), w.keisha.userId, JSON.stringify({ from: { status: 'on_site' }, to: { status: 'no_one_home' } })]);
    await w.admin().query("UPDATE world.job SET status = 'no_one_home', version = 3 WHERE job_number = $1", [n]);
    const r = await answers(await w.send([item({ kind: 'on_my_way', jobNumber: n, baseVersion: 1, entered: demoAt('10:28') })], maria));
    expect(r[0]?.result).toBe('history_only');
  });

  // why: FR-TEXT-19, FR-TEXT-4
  it('an arrival after an applied On my way ends the live map and cancels the unsent text', async () => {
    const n = await w.newJob({ customerId: w.texting[0] });
    await answers(await w.send([item({ kind: 'on_my_way', jobNumber: n, baseVersion: 1, entered: demoAt('10:28') })], maria));
    await answers(await w.send([item({ kind: 'arrived', jobNumber: n, baseVersion: 2, entered: demoAt('10:41') })], maria));
    expect((await texts(n)).map((t) => t.status)).toEqual(['canceled']);
    expect((await tokens(n))[0]?.ended_at).not.toBeNull();
  });
});

describe('the re-base on the server clock (FR-DEMO-9, section 5.1 step 4)', () => {
  // why: FR-DEMO-9
  it('a note entered offline at demo 10:41 and sent after a 2-hour clock jump is added offline at 10:41', async () => {
    const n = await w.newJob();
    // The clock ran from the phone's last sync (9:00 AM); 30 minutes after the entry (11:11 AM) the office jumped it 2 hours;
    // it reads 1:36 PM at the send.
    await w.setClock({
      moves: [{ kind: 'resume', atReal: REAL0.subtract({ hours: 1 }), toDemo: DEMO0.subtract({ hours: 1 }) },
        { kind: 'jump', atReal: REAL0.add({ minutes: 131 }), toDemo: demoAt('13:11') }],
      demoNow: demoAt('13:36'),
    });
    const note = item({ kind: 'note', jobNumber: n, baseVersion: 1, entered: demoAt('10:41'), payload: noteOf() });
    expect((await answers(await w.send([note], maria)))[0]?.result).toBe('applied');
    const row = (await w.rows<{ entered_at: Date; sent_at: Date; entered_offline: boolean }>('SELECT entered_at, sent_at, entered_offline FROM world.note WHERE item_key = $1', [note['key']]))[0]!;
    expect([iso(row.entered_at), iso(row.sent_at), row.entered_offline]).toEqual([demoAt('10:41').toString(), demoAt('13:36').toString(), true]);
    expect((await history(n)).find((h) => h.kind === 'note_added')?.data).toMatchObject({ offlineAt: wire(demoAt('10:41')), enteredOffline: true, rebased: false });
    expect((await ledger(note['key'] as string))[0]?.demo_time_rebased).toBeNull();
  });
  // why: F-866; entered_offline was judged on the demo clock, so a note sent at once on a paused demo clock read as offline
  it('a note sent at once, while the demo clock sits paused 3 hours behind, is not entered offline (the real clock judges)', async () => {
    const n = await w.newJob();
    await w.setClock({
      moves: [{ kind: 'resume', atReal: REAL0, toDemo: DEMO0 }, { kind: 'pause', atReal: REAL0.add({ minutes: 60 }), toDemo: demoAt('10:00') }],
      demoNow: demoAt('13:36'),
    });
    const now = realNow('record_stamp');
    const note: Record<string, unknown> = { ...item({ kind: 'note', jobNumber: n, baseVersion: 1, entered: demoAt('10:00'), payload: noteOf() }), offsetSavedReal: wire(now), sinceSaveMs: 0 };
    expect((await answers(await w.send([note], maria)))[0]?.result).toBe('applied');
    const row = (await w.rows<{ entered_offline: boolean }>('SELECT entered_offline FROM world.note WHERE item_key = $1', [note['key']]))[0]!;
    expect(row.entered_offline).toBe(false);
  });

  // why: FR-DEMO-9
  it('re-bases by 2 hours a note entered after a jump the phone never saw, and stores the rebuilt time', async () => {
    const n = await w.newJob();
    await w.setClock({
      moves: [{ kind: 'resume', atReal: REAL0.subtract({ hours: 1 }), toDemo: DEMO0.subtract({ hours: 1 }) },
        { kind: 'jump', atReal: REAL0.add({ minutes: 20 }), toDemo: DEMO0.add({ minutes: 20, hours: 2 }) }],
      demoNow: demoAt('13:06'),
    });
    const note = item({ kind: 'note', jobNumber: n, baseVersion: 1, entered: DEMO0.add({ minutes: 41 }), payload: noteOf(), phoneSkewMs: 5 * MIN });
    await answers(await w.send([note], maria));
    const at = DEMO0.add({ minutes: 41, hours: 2 }).toString();
    expect(iso((await ledger(note['key'] as string))[0]?.demo_time_rebased)).toBe(at);
    expect(iso((await w.rows<{ entered_at: Date }>('SELECT entered_at FROM world.note WHERE item_key = $1', [note['key']]))[0]?.entered_at)).toBe(at);
  });
});

describe('finishing (FR-BILL-3, FR-TECH-14; section 5.1 step 10)', () => {
  // why: FR-BILL-3, FR-TECH-14
  it('refuses a finish with neither parts nor No parts used per item, stores nothing, applies the rest, then takes the corrected copy', async () => {
    const n = await w.newJob({ status: 'on_site' });
    const bad = item({ kind: 'finished', jobNumber: n, baseVersion: 1, entered: demoAt('10:50'), payload: { ...noParts, noPartsUsed: false } });
    const note = item({ kind: 'note', jobNumber: n, baseVersion: 1, entered: demoAt('10:49'), payload: noteOf() });
    const a = await answers(await w.send([note, bad], maria));
    expect(a.map((x) => [x.result, x.code])).toEqual([['applied', null], ['refused', 'parts_required']]);
    expect(await ledger(bad['key'] as string)).toEqual([]);
    expect([(await job(n)).status, await w.rows('SELECT 1 FROM world.billing_item WHERE job_number = $1', [n])]).toEqual(['on_site', []]);
    const fixed = { ...bad, payload: noParts };
    expect((await answers(await w.send([fixed], maria)))[0]?.result).toBe('applied');
    expect((await job(n)).status).toBe('done');
    expect(await w.rows('SELECT state FROM world.billing_item WHERE job_number = $1', [n])).toEqual([{ state: 'sending' }]);
    expect(await w.rows('SELECT seq, text FROM world.work_done_line WHERE job_number = $1', [n])).toEqual([{ seq: 1, text: 'Cleaned the burners' }]);
  });

  // why: FR-BILL-3
  it('flags a part that is not on the seeded list with validation_failed (F-867), and finishes with a listed part', async () => {
    const n = await w.newJob({ status: 'on_site' });
    const part = (await w.rows<{ id: string }>('SELECT id FROM world.part ORDER BY code LIMIT 1'))[0]!.id;
    const bad = item({ kind: 'finished', jobNumber: n, baseVersion: 1, entered: demoAt('10:50'), payload: { ...noParts, noPartsUsed: false, parts: [{ partId: '00000000-0000-4000-8000-000000000000', quantity: 1 }] } });
    expect((await answers(await w.send([bad], maria)))[0]).toMatchObject({ result: 'flagged', code: 'validation_failed' });
    const good = item({ kind: 'finished', jobNumber: n, baseVersion: 1, entered: demoAt('10:50'), payload: { ...noParts, noPartsUsed: false, parts: [{ partId: part, quantity: 2 }] } });
    expect((await answers(await w.send([good], maria)))[0]?.result).toBe('applied');
    expect(await w.rows('SELECT quantity FROM world.job_part WHERE job_number = $1', [n])).toEqual([{ quantity: 2 }]);
  });

  // why: FR-TECH-9, OI-13
  it('records No one home as an ending status with no billing item, and ends the live map', async () => {
    const n = await w.newJob({ customerId: w.texting[1] });
    await answers(await w.send([item({ kind: 'on_my_way', jobNumber: n, baseVersion: 1, entered: demoAt('10:20') })], maria));
    expect((await answers(await w.send([item({ kind: 'no_one_home', jobNumber: n, baseVersion: 2, entered: demoAt('10:45') })], maria)))[0]?.result).toBe('applied');
    expect((await job(n)).status).toBe('no_one_home');
    expect(await w.rows('SELECT 1 FROM world.billing_item WHERE job_number = $1', [n])).toEqual([]);
    expect((await tokens(n))[0]?.ended_at).not.toBeNull();
    // An ending is final: a later Arrived is no forward move.
    expect((await answers(await w.send([item({ kind: 'arrived', jobNumber: n, baseVersion: 3, entered: demoAt('10:50') })], maria)))[0]?.result).toBe('duplicate');
  });
});

describe('own jobs only (UI-SPECIFICATION 2.4)', () => {
  // why: FR-AUTH-1
  // why: F-867 (owner ruling 546d6f1e): not_found is answered flagged and listed for the dispatcher, so the item leaves the phone
  // why: F-931 the photo is answered flagged too (200, listed, ledger row kept), so it leaves the phone and its resend answers duplicate
  it('flags an item for a job that never was the technician\'s and lists it, stores no note, and flags a photo the same way', async () => {
    const n = await w.newJob({ tech: kevin });
    const note = item({ kind: 'note', jobNumber: n, baseVersion: 1, entered: demoAt('10:30'), payload: noteOf() });
    expect((await answers(await w.send([note], maria)))[0]).toMatchObject({ result: 'flagged', code: 'not_found' });
    expect((await w.rows<{ message_key: string }>('SELECT message_key FROM world.offline_conflict WHERE job_number = $1', [n])).map((x) => x.message_key)).toEqual(['offline.flag.not_found']);
    expect(await w.rows('SELECT 1 FROM world.note WHERE job_number = $1 AND item_key = $2', [n, note['key']])).toEqual([]);
    expect((await ledger(note['key'] as string))[0]?.result).toBe('flagged');
    expect((await answers(await w.send([note], maria)))[0]?.result).toBe('duplicate');
    const photoQuery = blobQuery({ kind: 'photo', jobNumber: n, entered: demoAt('10:31') });
    const r = await w.upload(photoQuery, jpeg(), 'image/jpeg', maria);
    expect(r.status).toBe(200);
    expect((await r.json() as { data: unknown }).data).toMatchObject({ result: 'flagged', code: 'not_found' });
    expect(await w.rows('SELECT 1 FROM world.photo WHERE job_number = $1', [n])).toEqual([]);
    expect((await w.rows<{ message_key: string }>('SELECT message_key FROM world.offline_conflict WHERE job_number = $1', [n])).map((x) => x.message_key))
      .toEqual(['offline.flag.not_found', 'offline.flag.not_found']);
    expect(((await (await w.upload(photoQuery, jpeg(), 'image/jpeg', maria)).json()) as { data: unknown }).data).toMatchObject({ result: 'duplicate' });
  });
  // why: F-562 (owner ruling 546d6f1e): a job number the world does not hold is listed for the dispatcher of the technician's
  // branch with no job reference (migration 0022), its ledger row kept, so the resend answers duplicate and lists nothing twice
  it('lists an item for a job the world does not hold on the technician\'s branch, keeps its ledger row, and answers its resend duplicate', async () => {
    const note = item({ kind: 'note', jobNumber: 999_999, baseVersion: 1, entered: demoAt('10:30'), payload: noteOf() });
    expect((await answers(await w.send([note], maria)))[0]).toMatchObject({ result: 'flagged', code: 'not_found', messageKey: 'tech.item.flagged.not_found' });
    const listed = () => w.rows<{ job_number: number | null; branch_id: string; message_key: string; job: string; handled_at: Date | null }>(
      "SELECT job_number, branch_id, message_key, message_values->>'job' AS job, handled_at FROM world.offline_conflict WHERE item_key = $1", [note['key']]);
    expect(await listed()).toEqual([{ job_number: null, branch_id: 'columbus', message_key: 'offline.flag.not_found', job: '999999', handled_at: null }]);
    expect((await w.rows<{ result: string; job_number: number | null }>('SELECT result, job_number FROM world.tech_item WHERE key = $1', [note['key']])))
      .toEqual([{ result: 'flagged', job_number: null }]);
    expect((await answers(await w.send([note], maria)))[0]).toMatchObject({ result: 'duplicate', messageKey: 'tech.item.flagged.not_found' });
    expect(await listed()).toHaveLength(1);
  });
  // why: F-562 a null job reference is held to the 2 unlisted refusals: any other answer or list line must still name a real job
  it('refuses a ledger row or a list row with no job for anything but a flagged not_found or validation_failed', async () => {
    const key = (item({ kind: 'note', jobNumber: 1, baseVersion: 1, entered: demoAt('10:30'), payload: noteOf() }))['key'] as string;
    await expect(w.rows(
      `INSERT INTO world.tech_item (key, technician_id, job_number, kind, base_version, world_epoch, device_time_real, offset_saved_real, demo_time, since_save_ms, received_at, result, message_key)
       SELECT $1, t.id, NULL, 'note', 1, 1, now(), now(), now(), 0, now(), 'applied', NULL FROM world.technician t LIMIT 1`, [key])).rejects.toThrow(/tech_item_job_number_only_unlisted_refusal/);
    await expect(w.rows(
      `INSERT INTO world.offline_conflict (job_number, item_key, branch_id, message_key, message_values, offline_at, sent_at)
       SELECT NULL, key, 'columbus', 'offline.flag.assigned', '{"job": 1}'::jsonb, now(), now() FROM world.tech_item LIMIT 1`)).rejects.toThrow(/offline_conflict_job_number_only_unlisted_refusal/);
  });
  // why: F-867; parts_required stays refused: the technician can fix it on the phone
  it('still refuses a finish with neither parts nor No parts used, parts_required, and lists nothing', async () => {
    const n = await w.newJob({ status: 'on_site' });
    const fin = item({ kind: 'finished', jobNumber: n, baseVersion: 1, entered: demoAt('10:40'), payload: { parts: [], noPartsUsed: false, laborMinutes: 30, workDone: ['Done'] } });
    expect((await answers(await w.send([fin], maria)))[0]).toMatchObject({ result: 'refused', code: 'parts_required' });
    expect(await w.rows('SELECT 1 FROM world.offline_conflict WHERE job_number = $1', [n])).toEqual([]);
  });
});

describe('photos and signatures (FR-TECH-3, FR-TECH-14, SD-32; API-103)', () => {
  // why: FR-TECH-3, FR-TECH-4
  it('stores a photo write-once under <yyyy-mm>/<key> with its size and placed time, and answers its repeat duplicate', async () => {
    const n = await w.newJob();
    const q = blobQuery({ kind: 'photo', jobNumber: n, entered: demoAt('10:35') });
    const r = await w.upload(q, jpeg(2048, 1536, 4096), 'image/jpeg', maria);
    expect([r.status, ((await r.json()) as { data: { result: string } }).data.result]).toEqual([200, 'applied']);
    const p = (await w.rows<{ file: string; bytes: number; width: number; height: number; entered_at: Date }>('SELECT file, bytes, width, height, entered_at FROM world.photo WHERE key = $1', [q['key']]))[0]!;
    expect(p).toMatchObject({ file: `2026-09/${q['key']}`, bytes: 4096, width: 2048, height: 1536 });
    expect(iso(p.entered_at)).toBe(demoAt('10:35').toString());
    expect(existsSync(path.join(w.photosDir, p.file))).toBe(true);
    const again = await w.upload(q, jpeg(2048, 1536, 4096), 'image/jpeg', maria);
    expect(((await again.json()) as { data: { result: string } }).data.result).toBe('duplicate');
    expect((await history(n)).filter((h) => h.kind === 'photo_added')).toHaveLength(1);
  });

  // why: FR-TECH-3
  // why: F-978 the upload cap's refusal (over 10 MB, or a type other than JPEG or PNG) is answered flagged under the key and listed for the dispatcher, so the photo leaves the phone
  it('flags a photo over 10 MB and one of another type, lists each for the dispatcher, and takes one of exactly 10 MB', async () => {
    const n = await w.newJob();
    const overQ = blobQuery({ kind: 'photo', jobNumber: n, entered: demoAt('10:35') });
    const over = await w.upload(overQ, jpeg(640, 480, 10 * 1024 * 1024 + 1), 'image/jpeg', maria);
    expect([over.status, ((await over.json()) as { data: unknown }).data]).toMatchObject([200, { result: 'flagged', code: 'validation_failed' }]);
    // F-69: the owner's iPhone handed Safari Take Photo a 14,394,749-byte image/x-adobe-dng file.
    const dngQ = blobQuery({ kind: 'photo', jobNumber: n, entered: demoAt('10:35') });
    const dng = await w.upload(dngQ, new Uint8Array(14_394_749).fill(7), 'image/x-adobe-dng', maria);
    expect([dng.status, ((await dng.json()) as { data: unknown }).data]).toMatchObject([200, { result: 'flagged', code: 'validation_failed' }]);
    expect((await w.rows<{ item_key: string }>('SELECT item_key::text FROM world.offline_conflict WHERE job_number = $1 ORDER BY item_key', [n])).map((x) => x.item_key))
      .toEqual([overQ['key'], dngQ['key']].sort());
    const at = await w.upload(blobQuery({ kind: 'photo', jobNumber: n, entered: demoAt('10:36') }), jpeg(640, 480, 10 * 1024 * 1024), 'image/jpeg', maria);
    expect(at.status).toBe(200);
    expect(await w.rows('SELECT 1 FROM world.photo WHERE job_number = $1', [n])).toHaveLength(1);
  });

  // why: FR-TECH-14
  // why: F-931 a signature the handler cannot accept is answered flagged (200), listed for the dispatcher and kept in the ledger, so it leaves the phone
  it('flags a signature over 512 KB and one that is not a PNG; keeps 1 signature per job with the customer as signer', async () => {
    const n = await w.newJob();
    const big = await w.upload(blobQuery({ kind: 'signature', jobNumber: n, entered: demoAt('10:50') }), png(1200, 400, 512 * 1024 + 1), 'image/png', maria);
    expect([big.status, ((await big.json()) as { data: unknown }).data]).toMatchObject([200, { result: 'flagged', code: 'validation_failed' }]);
    const jpg = await w.upload(blobQuery({ kind: 'signature', jobNumber: n, entered: demoAt('10:49') }), jpeg(), 'image/jpeg', maria);
    expect([jpg.status, ((await jpg.json()) as { data: unknown }).data]).toMatchObject([200, { result: 'flagged', code: 'validation_failed' }]);
    expect((await w.rows<{ message_key: string }>('SELECT message_key FROM world.offline_conflict WHERE job_number = $1', [n])).map((x) => x.message_key))
      .toEqual(['offline.flag.validation_failed', 'offline.flag.validation_failed']);
    expect(await w.rows('SELECT 1 FROM world.signature WHERE job_number = $1', [n])).toEqual([]);
    const ok = await w.upload(blobQuery({ kind: 'signature', jobNumber: n, entered: demoAt('10:51') }), png(), 'image/png', maria);
    expect(ok.status).toBe(200);
    const other = await w.upload(blobQuery({ kind: 'signature', jobNumber: n, entered: demoAt('10:52') }), png(), 'image/png', maria);
    expect(((await other.json()) as { data: { result: string } }).data.result).toBe('duplicate');
    const s = await w.rows<{ signed_by_name: string; signed_at: Date }>(
      'SELECT s.signed_by_name, s.signed_at FROM world.signature s WHERE s.job_number = $1', [n]);
    const customer = (await w.rows<{ name: string }>('SELECT c.name FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE j.job_number = $1', [n]))[0]!.name;
    expect(s.map((x) => [x.signed_by_name, iso(x.signed_at)])).toEqual([[customer, demoAt('10:51').toString()]]);
  });

  // why: FR-TECH-3, FR-TECH-4, invariant 1 (F-67: the key is stored only with the file it names)
  // why: F-991, FR-TECH-4 a photo upload cut in the middle of its body (the signal drops, iOS resends the cut task) stores nothing; the whole resend stores it once
  it('a photo cut mid-body stores no key, no row and no file, and the whole resend stores it once and its repeat answers duplicate', async () => {
    const n = await w.newJob();
    const q = blobQuery({ kind: 'photo', jobNumber: n, entered: demoAt('10:36') });
    const whole = jpeg(2048, 1536, 4096);
    const { key, ...rest } = q;
    const url = `http://web:3000/api/v1/tech/photos/${String(key)}?${new URLSearchParams(Object.entries(rest).map(([x, v]) => [x, String(v)])).toString()}`;
    // The first half arrives, then the connection drops: the body stream fails the way a reset socket fails it.
    const cut = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(whole.slice(0, whole.byteLength / 2));
        c.error(new Error('connection reset'));
      },
    });
    const outcome = await w.kernel.router.handle(
      new Request(url, { method: 'PUT', body: cut, duplex: 'half', headers: { 'content-type': 'image/jpeg', ...maria.auth } } as RequestInit),
      { address: '203.0.113.9' },
    ).then((r) => r.status, () => 'rejected');
    expect(outcome === 'rejected' || (typeof outcome === 'number' && outcome >= 400), `the cut body was answered ${String(outcome)}`).toBe(true);
    expect(await ledger(key as string)).toEqual([]);
    expect(await w.rows('SELECT 1 FROM world.photo WHERE key = $1', [key])).toEqual([]);
    expect(existsSync(path.join(w.photosDir, '2026-09', key as string))).toBe(false);
    const resend = await w.upload(q, whole, 'image/jpeg', maria);
    expect([resend.status, ((await resend.json()) as { data: { result: string } }).data.result]).toEqual([200, 'applied']);
    const again = await w.upload(q, whole, 'image/jpeg', maria);
    expect(((await again.json()) as { data: { result: string } }).data.result).toBe('duplicate');
    expect(await w.rows('SELECT 1 FROM world.photo WHERE key = $1', [key])).toHaveLength(1);
    expect(await ledger(key as string)).toHaveLength(1);
    expect((await history(n)).filter((h) => h.kind === 'photo_added')).toHaveLength(1);
    expect(existsSync(path.join(w.photosDir, '2026-09', key as string))).toBe(true);
  });

  it('a photo whose file write fails stores no key, and its retry stores it, never answering duplicate first', async () => {
    const n = await w.newJob();
    const q = blobQuery({ kind: 'photo', jobNumber: n, entered: demoAt('10:35') });
    // A plain file where the month's folder belongs: the write fails after the key arrived and the job was checked.
    await rm(path.join(w.photosDir, '2026-09'), { recursive: true, force: true });
    await writeFile(path.join(w.photosDir, '2026-09'), 'not a folder');
    const failed = await w.upload(q, jpeg(), 'image/jpeg', maria);
    expect(failed.status).toBe(500);
    expect(await ledger(q['key'] as string)).toEqual([]);
    expect(await w.rows('SELECT 1 FROM world.photo WHERE key = $1', [q['key']])).toEqual([]);
    await rm(path.join(w.photosDir, '2026-09'), { force: true });
    const retry = await w.upload(q, jpeg(), 'image/jpeg', maria);
    expect(((await retry.json()) as { data: { result: string } }).data.result).toBe('applied');
    expect(existsSync(path.join(w.photosDir, '2026-09', q['key'] as string))).toBe(true);
    expect(((await (await w.upload(q, jpeg(), 'image/jpeg', maria)).json()) as { data: { result: string } }).data.result).toBe('duplicate');
  });
});

describe('the sync report (API-162; FR-DISP-33, FR-TECH-7)', () => {
  // why: FR-TECH-7, FR-DISP-33
  it('keeps the last report per technician and app, stamped with the demo time it arrived', async () => {
    const report = { app: 'native', waitingCount: 3, lastSyncAt: wire(REAL0), device: 'iPhone 15', version: '1.0.0' };
    expect((await w.post('/tech/sync-reports', report, maria)).status).toBe(204);
    expect((await w.post('/tech/sync-reports', { ...report, waitingCount: 0 }, maria)).status).toBe(204);
    const r = await w.rows<{ waiting_count: number; reported_at: Date }>('SELECT waiting_count, reported_at FROM world.app_sync_report WHERE technician_id = $1', [maria.technicianId]);
    expect(r.map((x) => [x.waiting_count, iso(x.reported_at)])).toEqual([[0, demoAt('11:06').toString()]]);
    expect((await w.post('/tech/sync-reports', report, w.keisha)).status).toBe(403);
  });
});

describe('the entry a flagged item keeps (section 3 tech_item.payload; F-1139, owner ruling c4aa4366)', () => {
  const boardFlagged = async (n: number) => {
    const r = await w.get('/board?branch=columbus&date=2026-09-15', w.keisha);
    return ((await r.json()) as { data: { needsAttention: { flagged: { jobNumber: number; entry: unknown }[] } } }).data.needsAttention.flagged.filter((f) => f.jobNumber === n);
  };
  const payloadOf = async (key: string) => (await w.rows<{ payload: unknown; result: string }>('SELECT payload, result FROM world.tech_item WHERE key = $1', [key]))[0]!;
  // why: FR-DISP-9, FR-BILL-3 a flagged finish keeps its parts, labor and work-done lines, and API-20 lists them with the part's name; a part not on the list shows as the phone sent it
  it('keeps a flagged finish\'s parts, labor and work done, and API-20 shows them with the part name; a part not on the list shows as sent', async () => {
    const n = 987_656;
    const part = (await w.rows<{ id: string; name: string }>('SELECT id, name FROM world.part ORDER BY code LIMIT 1'))[0]!;
    const entered = { parts: [{ partId: part.id, quantity: 2 }, { partId: 'not-a-listed-part', quantity: 1 }], noPartsUsed: false, laborMinutes: 50, workDone: ['Replaced the capacitor', 'Cleaned the coil'] };
    const fin = item({ kind: 'finished', jobNumber: n, baseVersion: 1, entered: demoAt('10:45'), payload: entered });
    expect((await answers(await w.send([fin], maria)))[0]?.result).toBe('flagged');
    expect(await payloadOf(fin['key'] as string)).toEqual({ result: 'flagged', payload: entered });
    expect(await boardFlagged(n)).toEqual([expect.objectContaining({ entry: {
      kind: 'finish', parts: [{ partId: part.id, name: part.name, quantity: 2 }, { partId: 'not-a-listed-part', name: null, quantity: 1 }],
      noPartsUsed: false, laborMinutes: 50, workDone: entered.workDone,
    } })]);
    // No parts used is kept as the phone sent it
    const none = item({ kind: 'finished', jobNumber: 987_659, baseVersion: 1, entered: demoAt('10:46'), payload: noParts });
    expect((await answers(await w.send([none], maria)))[0]?.result).toBe('flagged');
    expect(await boardFlagged(987_659)).toEqual([expect.objectContaining({ entry: { kind: 'finish', parts: [], noPartsUsed: true, laborMinutes: 45, workDone: ['Cleaned the burners'] } })]);
  });
  // why: FR-DISP-9 a note flagged keeps its text; a status change keeps none, and an item that applied keeps none (null for every other result)
  it('keeps a flagged note\'s text, and no entry for a status change or an item that applied', async () => {
    const note = item({ kind: 'note', jobNumber: 987_657, baseVersion: 1, entered: demoAt('10:40'), payload: noteOf('Customer asked for a quote') });
    const arrived = item({ kind: 'arrived', jobNumber: 987_658, baseVersion: 1, entered: demoAt('10:41') });
    expect((await answers(await w.send([note, arrived], maria))).map((a) => a.result)).toEqual(['flagged', 'flagged']);
    expect(await payloadOf(note['key'] as string)).toEqual({ result: 'flagged', payload: { text: 'Customer asked for a quote' } });
    expect(await payloadOf(arrived['key'] as string)).toEqual({ result: 'flagged', payload: null });
    expect(await boardFlagged(987_657)).toEqual([expect.objectContaining({ entry: { kind: 'note', text: 'Customer asked for a quote' } })]);
    expect(await boardFlagged(987_658)).toEqual([expect.objectContaining({ entry: null })]);
    const ok = item({ kind: 'note', jobNumber: await w.newJob(), baseVersion: 1, entered: demoAt('10:42'), payload: noteOf('Applied') });
    expect((await answers(await w.send([ok], maria)))[0]?.result).toBe('applied');
    expect(await payloadOf(ok['key'] as string)).toEqual({ result: 'applied', payload: null });
  });
  // why: F-562, FR-DISP-9 an item refused for a job number the world does not hold keeps its entry too (listed with no job reference)
  it('keeps the entry of an item for a job the world does not hold, and lists it', async () => {
    const note = item({ kind: 'note', jobNumber: 987_655, baseVersion: 1, entered: demoAt('10:30'), payload: noteOf('Left a message') });
    expect((await answers(await w.send([note], maria)))[0]?.result).toBe('flagged');
    expect(await payloadOf(note['key'] as string)).toEqual({ result: 'flagged', payload: { text: 'Left a message' } });
    expect(await boardFlagged(987_655)).toEqual([expect.objectContaining({ entry: { kind: 'note', text: 'Left a message' } })]);
  });
  // why: F-1168 (owner ruling 21ce2f73, "Keep them too"): a photo or signature the server refuses for a reason the phone cannot fix is kept as a file, named in tech_item.payload, listed with the flagged row, and the office can read the image (API-175); a technician cannot
  it('keeps a refused photo and a refused signature, lists each with an image link for the dispatcher, and serves the image to the office only', async () => {
    const n = await w.newJob({ tech: kevin, date: '2026-09-18' });
    const photoQ = blobQuery({ kind: 'photo', jobNumber: n, entered: demoAt('10:31') });
    const sigQ = blobQuery({ kind: 'signature', jobNumber: n, entered: demoAt('10:32') });
    const unlistedQ = blobQuery({ kind: 'photo', jobNumber: 987_650, entered: demoAt('10:33') });
    const photoBytes = jpeg(640, 480, 200);
    expect((await w.upload(photoQ, photoBytes, 'image/jpeg', maria)).status).toBe(200);
    expect((await w.upload(sigQ, png(), 'image/png', maria)).status).toBe(200);
    expect((await w.upload(unlistedQ, jpeg(), 'image/jpeg', maria)).status).toBe(200);
    for (const [q, kind] of [[photoQ, 'photo'], [sigQ, 'signature'], [unlistedQ, 'photo']] as const) {
      const row = await payloadOf(q['key'] as string);
      expect(row.result).toBe('flagged');
      const file = (row.payload as { file: string }).file;
      expect(existsSync(path.join(w.photosDir, file)), kind).toBe(true);
    }
    expect(await w.rows('SELECT 1 FROM world.photo WHERE job_number = $1 UNION ALL SELECT 1 FROM world.signature WHERE job_number = $1', [n])).toEqual([]);
    expect(await boardFlagged(n)).toEqual([
      expect.objectContaining({ entry: { kind: 'photo', key: photoQ['key'] } }),
      expect.objectContaining({ entry: { kind: 'signature', key: sigQ['key'] } }),
    ]);
    expect(await boardFlagged(987_650)).toEqual([expect.objectContaining({ entry: { kind: 'photo', key: unlistedQ['key'] } })]);
    const img = await w.get(`/files/${photoQ['key']}`, w.keisha);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(photoBytes);
    expect((await w.get(`/files/${sigQ['key']}`, w.keisha)).headers.get('content-type')).toBe('image/png');
    expect((await w.get(`/files/${photoQ['key']}`, maria)).status).toBe(403);
  });
  // why: F-1171 (owner ruling 21ce2f73, "Keep them too"; SPECIFICATIONS 5.1 step 10): a valid photo from a world epoch in the future is a refusal the phone cannot fix, so it is kept like the others
  it('keeps a valid photo whose world epoch is from the future, lists it with its key, and serves it to the office only', async () => {
    const n = await w.newJob({ tech: kevin, date: '2026-09-19' });
    const q = blobQuery({ kind: 'photo', jobNumber: n, entered: demoAt('10:34'), worldEpoch: 99 });
    const bytes = jpeg(640, 480, 200);
    expect((await w.upload(q, bytes, 'image/jpeg', maria)).status).toBe(200);
    const row = await payloadOf(q['key'] as string);
    expect(row.result).toBe('flagged');
    expect(existsSync(path.join(w.photosDir, (row.payload as { file: string }).file))).toBe(true);
    expect(await boardFlagged(n)).toEqual([expect.objectContaining({ entry: { kind: 'photo', key: q['key'] } })]);
    const img = await w.get(`/files/${q['key']}`, w.keisha);
    expect(img.status).toBe(200);
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(bytes);
    expect((await w.get(`/files/${q['key']}`, maria)).status).toBe(403);
  });
  // why: FR-TECH-3 (SD-32, API-175; owner ruling 21ce2f73) a refused photo the server kept gets its small copy in the same request, and the copy is the office's to read only, like the file
  it('writes a kept refused photo\'s small copy, which the office reads with size thumb and its technician cannot', async () => {
    const n = await w.newJob({ tech: kevin, date: '2026-09-20' });
    const q = blobQuery({ kind: 'photo', jobNumber: n, entered: demoAt('10:35') });
    expect((await w.upload(q, await halvesJpeg(1024, 768), 'image/jpeg', maria)).status).toBe(200);
    const row = await payloadOf(q['key'] as string);
    expect(row.result).toBe('flagged');
    expect(existsSync(path.join(w.photosDir, `${(row.payload as { file: string }).file}.thumb.jpg`))).toBe(true);
    const r = await w.get(`/files/${q['key']}?size=thumb`, w.keisha);
    expect([r.status, r.headers.get('content-type'), r.headers.get('cache-control')]).toEqual([200, 'image/jpeg', 'no-store']);
    expect(await sizeOf(new Uint8Array(await r.arrayBuffer()))).toMatchObject({ width: 320, height: 240 });
    expect((await w.get(`/files/${q['key']}?size=thumb`, maria)).status).toBe(403);
  });
});

describe('Mark handled (API-39; FR-DISP-9, OA-59)', () => {
  // why: FR-DISP-9
  it('Keisha T. marks a flagged item handled at 11:15 AM: it leaves the list, the history shows who and when, a second mark answers already_handled', async () => {
    const n = await w.newJob();
    expect((await w.post(`/jobs/${n}/assignment`, { technicianId: kevin.technicianId, baseVersion: 1 }, w.keisha)).status).toBe(200);
    const fin = item({ kind: 'finished', jobNumber: n, baseVersion: 1, entered: demoAt('10:45'), payload: noParts });
    expect((await answers(await w.send([fin], maria)))[0]?.result).toBe('flagged');
    const c = (await w.rows<{ id: string }>('SELECT id FROM world.offline_conflict WHERE job_number = $1 AND handled_at IS NULL', [n]))[0]!;
    await w.runningClock(demoAt('11:15'));
    const r = await w.post(`/offline-conflicts/${c.id}/handled`, {}, w.keisha);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: { conflict: { handledBy: string; handledAt: string } } }).data.conflict)
      .toMatchObject({ handledBy: w.keisha.name, handledAt: wire(demoAt('11:15')) });
    expect(await w.rows('SELECT 1 FROM world.offline_conflict WHERE job_number = $1 AND handled_at IS NULL', [n])).toEqual([]);
    const h = (await history(n)).find((x) => x.kind === 'flag_handled');
    expect([iso(h?.at), h?.data]).toEqual([demoAt('11:15').toString(), { conflictId: c.id }]);
    const again = await w.post(`/offline-conflicts/${c.id}/handled`, {}, w.keisha);
    expect([again.status, await again.json()]).toEqual([409, expect.objectContaining({ code: 'already_handled', by: w.keisha.name, at: wire(demoAt('11:15')) })]);
    expect((await w.post('/offline-conflicts/00000000-0000-4000-8000-000000000000/handled', {}, w.keisha)).status).toBe(404);
    expect((await w.post(`/offline-conflicts/${c.id}/handled`, {}, maria)).status).toBe(403);
  });
  // why: FR-DISP-9 (F-562) the item for a job number the world does not hold is on the branch's flagged list (API-20) with the
  // number the phone sent, and leaves it only by Mark handled, which records who and when on its row (it has no job history)
  // why: F-953 the row says it names no job (listed false), so the board draws it as plain text with no link to a job page
  it('lists an item for a job the world does not hold on the board with its number, and Mark handled takes it off with who and when', async () => {
    const note = item({ kind: 'note', jobNumber: 987_654, baseVersion: 1, entered: demoAt('10:30'), payload: noteOf() });
    expect((await answers(await w.send([note], maria)))[0]?.result).toBe('flagged');
    // The board lists every unhandled flagged item of the branch, whatever the date (UD-37).
    const read = async () => {
      const r = await w.get('/board?branch=columbus&date=2026-09-15', w.keisha);
      if (r.status !== 200) throw new Error(`API-20 answered ${r.status}: ${await r.text()}`);
      return r.json();
    };
    const board = async () => ((await read()) as {
      data: { needsAttention: { flagged: { conflictId: string; jobNumber: number; messageKey: string; values: Record<string, unknown> }[] } };
    }).data.needsAttention.flagged.filter((f) => f.jobNumber === 987_654);
    const listed = await board();
    expect(listed).toEqual([expect.objectContaining({ jobNumber: 987_654, listed: false, messageKey: 'offline.flag.not_found', values: expect.objectContaining({ job: 987_654, tech: maria.nameInTexts }) })]);
    await w.runningClock(demoAt('11:15'));
    const r = await w.post(`/offline-conflicts/${listed[0]!.conflictId}/handled`, {}, w.keisha);
    expect([r.status, ((await r.json()) as { data: { conflict: unknown } }).data.conflict])
      .toEqual([200, { conflictId: listed[0]!.conflictId, jobNumber: 987_654, handledBy: w.keisha.name, handledAt: wire(demoAt('11:15')) }]);
    expect(await board()).toEqual([]);
    expect((await w.rows<{ handled_by: string }>('SELECT handled_by FROM world.offline_conflict WHERE id = $1', [listed[0]!.conflictId]))[0]?.handled_by).toBe(w.keisha.userId);
    const again = await w.post(`/offline-conflicts/${listed[0]!.conflictId}/handled`, {}, w.keisha);
    expect([again.status, await again.json()]).toEqual([409, expect.objectContaining({ code: 'already_handled', by: w.keisha.name, at: wire(demoAt('11:15')) })]);
  });
});
