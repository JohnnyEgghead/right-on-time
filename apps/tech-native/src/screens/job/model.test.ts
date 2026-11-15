// SPDX-License-Identifier: AGPL-3.0-or-later
// The native job rules (model.ts) against P5-TWA-JOB's (apps/web/src/tech/job/model.ts): the native app imports no web code (SD-2),
// so its port is held to the same answers on the same inputs here, and to SD-32's photo and signature limits (photo.ts, signature.ts).
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { QueuedItem } from '@bw/outbox/src/items/native.ts';
import { PHOTO_MAX_BYTES, SIGNATURE_MAX_BYTES } from '@bw/api';
import * as web from '../../../../web/src/tech/job/model.ts';
import * as webPhoto from '../../../../web/src/tech/job/photo.ts';
import { HAROLD, haroldJob, PARTS } from './fixtures.test-data.ts';
import * as native from './model.ts';
import { compressPhoto, fitSize, LONGEST_SIDE, QUALITY, type Encoder } from './photo.ts';
import { rasterize, SIG_MAX, signaturePng, sigSize } from './signature.ts';

const at = (hm: string, day = '2026-09-15') => `${day}T${hm}:00-04:00[America/New_York]`;
function item(kind: QueuedItem['kind'], key: string, extra: Partial<QueuedItem> = {}): QueuedItem {
  const base = { key, jobNumber: HAROLD, baseVersion: 3, demoTime: at('10:58'), deviceTime: at('10:58'), enteredRealMs: 0, userId: 'u', worldEpoch: 1 };
  const body = kind === 'note' ? { kind, payload: { text: `note ${key}` } } : kind === 'finished' ? { kind, payload: { parts: [{ partId: 'p-fs', quantity: 1 }], noPartsUsed: false, laborMinutes: 75, workDone: ['Cleaned it'] } }
    : kind === 'photo' || kind === 'signature' ? { kind, contentType: 'image/jpeg' } : { kind };
  return { ...base, ...body, ...extra } as unknown as QueuedItem;
}

describe('the native job rules answer as the web app\'s', () => {
  const job = { ...haroldJob(), photos: [{ key: 'ph-1', by: 'Maria Santos', at: at('09:00') }] };
  const waiting = [
    item('note', 'k1'), item('on_my_way', 'k2'), item('arrived', 'k3', { demoTime: at('10:41') }), item('photo', 'k4'), item('note', 'k5'),
    item('finished', 'k6', { lastTry: { outcome: 'refused', code: 'parts_required', atRealMs: 0 } }),
  ];

  // why: FR-TECH-3, FR-TECH-4 the job shows the phone's own waiting status, notes and photos laid over the server's, as the web app does (rule 6)
  it('lays the waiting items over the job: status, notes, photos and the refused finish', () => {
    expect(native.shownStatus(job, waiting)).toEqual(web.shownStatus(job, waiting));
    expect(native.shownStatus(job, waiting).status).toBe('on_site');
    expect(native.shownNotes(job, waiting, 'Maria Santos')).toEqual(web.shownNotes(job, waiting, 'Maria Santos'));
    expect(native.shownPhotos(job, waiting, 'Maria Santos')).toEqual(web.shownPhotos(job, waiting, 'Maria Santos'));
    expect(native.finishWaits(HAROLD, waiting)).toBe(web.finishWaits(HAROLD, waiting));
    expect(native.refusedFinish(HAROLD, waiting)?.key).toBe('k6');
    expect(native.draftFromRefused(HAROLD, native.refusedFinish(HAROLD, waiting)!.payload, PARTS))
      .toEqual({ ...web.draftFromRefused(HAROLD, web.refusedFinish(HAROLD, waiting)!.payload, PARTS), signature: null });
  });

  // why: FR-TECH-8, FR-DISP-27, FR-AUTH-4 the job's words (window, note times, entry times) and today's number rule match the web app's
  it('writes the window, the note and entry times and the phone-number day rule as the web app does', () => {
    expect(native.windowWords(job)).toBe('10 AM-12 PM');
    expect(native.windowWords(job)).toBe(web.windowWords(job));
    for (const a of [at('10:28'), at('15:12', '2026-09-10'), at('11:00', '2025-10-14')]) {
      for (const lang of ['en', 'es']) expect(native.noteWhen(a, '2026-09-15', lang)).toBe(web.noteWhen(a, '2026-09-15', lang));
    }
    expect(native.noteWhen(at('15:12', '2026-09-10'), '2026-09-15', 'en')).toBe('Thu, Sep 10');
    const now = Date.parse('2026-09-15T14:28:00Z');
    expect(native.enteredWords(at('10:58', '2026-09-14'), now, 'en')).toBe(web.enteredWords(at('10:58', '2026-09-14'), now, 'en'));
    for (const fromPhone of [true, false]) {
      for (const n of [null, now, Date.parse('2026-09-16T14:00:00Z')]) expect(native.shownAsToday(job, n, fromPhone)).toBe(web.shownAsToday(job, n, fromPhone));
    }
  });

  // why: FR-BILL-3, FR-BILL-1 the finish checks and the parts picker (search, add, quantity at least 1, labor from Arrived) match the web app's
  it('checks a finish, finds and adds parts, steps quantities and prefills labor as the web app does', () => {
    const empty = native.emptyFinish(HAROLD);
    expect(native.checkFinish(empty, { hours: '1', minutes: '0' })).toEqual({ ok: false, on: 'parts' });
    expect(native.checkFinish({ ...empty, noPartsUsed: true }, { hours: '0', minutes: '0' })).toEqual({ ok: false, on: 'labor' });
    const d = { ...empty, noPartsUsed: true, workDone: [' Cleaned the flame sensor ', ''] };
    expect(native.checkFinish(d, { hours: '2', minutes: '9' })).toEqual(web.checkFinish({ ...d, signature: null }, { hours: '2', minutes: '9' }));
    for (const q of ['flt', 'FS-1', 'igniter', 'zzz', ' ']) expect(native.findParts(PARTS, q)).toEqual(web.findParts(PARTS, q));
    const added = native.addPart([], PARTS[0]!);
    expect(added).toEqual(web.addPart([], PARTS[0]!));
    expect(native.addPart(added.rows, PARTS[0]!).added).toBe(false);
    expect(native.stepQuantity(added.rows, 'p-flt', -1)[0]!.quantity).toBe(1);
    expect(native.laborFrom(at('10:41'), Date.parse('2026-09-15T16:50:00Z'))).toEqual(web.laborFrom(at('10:41'), Date.parse('2026-09-15T16:50:00Z')));
    for (const [h, m] of [['2', '9'], ['', '45'], ['1', '60'], ['x', '1'], ['0', '0']] as const) expect(native.laborMinutes(h, m)).toBe(web.laborMinutes(h, m));
  });
});

describe('SD-32 on the native phone', () => {
  const jpeg = (n: number) => {
    const b = new Uint8Array(n);
    b.set([0xff, 0xd8, 0xff]);
    return b;
  };

  // why: FR-TECH-3, F-978 a picked photo becomes a JPEG of at most 2048 px and within 10 MB, lowering the quality only while over the cap
  it('encodes the picked photo at 2048 px and quality 0.8, then lower until it fits API-103\'s cap', async () => {
    expect(fitSize(3200, 1200)).toEqual({ width: 2048, height: 768 });
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitSize(3200, 1200)).toEqual(webPhoto.fitSize(3200, 1200));
    const tries: { size: { width: number; height: number }; quality: number }[] = [];
    const enc: Encoder = {
      jpeg: async (_uri, size, quality) => {
        tries.push({ size, quality });
        return { uri: 'file:///x.jpg', bytes: jpeg(tries.length === 1 ? PHOTO_MAX_BYTES + 1 : 900_000), ...size };
      },
      original: async () => new Uint8Array(0),
    };
    const c = await compressPhoto({ uri: 'file:///big.png', width: 3200, height: 1200 }, enc);
    expect(c).toMatchObject({ ok: true, type: 'image/jpeg', width: 2048, height: 768 });
    expect(tries).toEqual([{ size: { width: 2048, height: 768 }, quality: QUALITY }, { size: { width: LONGEST_SIDE, height: 768 }, quality: 0.6 }]);
  });

  // why: F-69, F-931 a photo the phone cannot encode is kept as picked and marked, so it leaves the phone flagged instead of waiting forever
  it('keeps a photo the encoder cannot read as picked, marked unreadable', async () => {
    const enc: Encoder = { jpeg: async () => null, original: async () => new Uint8Array([1, 2, 3]) };
    expect(await compressPhoto({ uri: 'file:///x.dng', width: 6000, height: 4000 }, enc)).toEqual({ ok: false, reason: 'unreadable', bytes: new Uint8Array([1, 2, 3]) });
  });

  // why: FR-TECH-14 the signature is a PNG of at most 1200 x 400 px within the 512 KB cap, with the strokes drawn where the finger went
  it('makes the signature a valid 1-bit PNG within SD-32\'s size, inked along the strokes', () => {
    expect(sigSize(366, 92)).toMatchObject({ width: 1200, height: 301 });
    const strokes = [[{ x: 20, y: 46 }, { x: 340, y: 46 }]];
    const png = signaturePng(strokes, 366, 92);
    expect(webPhoto.isJpegOrPng(png)).toBe(true);
    expect(png.byteLength).toBeLessThan(SIGNATURE_MAX_BYTES);
    const dv = new DataView(png.buffer, png.byteOffset);
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR');
    const [w, h] = [dv.getUint32(16), dv.getUint32(20)];
    expect(w).toBeLessThanOrEqual(SIG_MAX.width);
    expect(h).toBeLessThanOrEqual(SIG_MAX.height);
    expect([png[24], png[25]]).toEqual([1, 0]); // 1-bit grayscale
    const idatLen = dv.getUint32(33);
    expect(String.fromCharCode(...png.subarray(37, 41))).toBe('IDAT');
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    const rowBytes = Math.ceil(w / 8) + 1;
    expect(raw.byteLength).toBe(rowBytes * h);
    const black = (x: number, y: number) => ((raw[y * rowBytes + 1 + (x >> 3)]! >> (7 - (x & 7))) & 1) === 0;
    const k = sigSize(366, 92).scale;
    expect(black(Math.round(180 * k), Math.round(46 * k))).toBe(true); // on the stroke
    expect(black(Math.round(180 * k), Math.round(10 * k))).toBe(false); // above it
    expect(rasterize([], 366, 92).ink.some((v) => v === 1)).toBe(false);
  });
});
