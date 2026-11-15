// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1234 (on the iPhone, photos added to a job did not show, and after Today and back none showed)
// The rules the job screen's photo strip and its thumbnails draw by (strip.ts), on the owner's case from the TestFlight device session:
// on an iPhone 16 Pro, 2 photos sent while the link was good, then 4 more saved on the phone over a very slow link.
import { STORED_FILE_SIZES } from '@bw/api';
import { describe, expect, it } from 'vitest';
import type { QueuedItem } from '@bw/outbox/src/items/native.ts';
import { HAROLD, haroldJob } from './fixtures.test-data.ts';
import { shownPhotos } from './model.ts';
import { photoPath, stripContent, stripRest, THUMB, thumbLayers } from './strip.ts';

/** The strip's width on the iPhone 16 Pro: 402 pt less the scroll padding, group border and row padding (the strip has a row of its own). */
const IPHONE_16_PRO = 402 - 2 * 12 - 2 * 1 - 2 * 12;

/** The indexes of the thumbnails wholly in view with the strip scrolled to x. */
function inView(n: number, view: number, x: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const left = i * (THUMB.width + THUMB.gap);
    if (left >= x - 0.01 && left + THUMB.width <= x + view + 0.01) out.push(i);
  }
  return out;
}

const at = (hm: string) => `2026-09-15T${hm}:00-04:00[America/New_York]`;
const waitingPhoto = (key: string, hm: string) =>
  ({ key, jobNumber: HAROLD, baseVersion: null, kind: 'photo', contentType: 'image/jpeg', demoTime: at(hm), deviceTime: at(hm), enteredRealMs: 0, userId: 'u', worldEpoch: 1 }) as unknown as QueuedItem;

describe('the job screen photo strip on an iPhone (F-1234)', () => {
  const job = { ...haroldJob(), photos: [{ key: 'sent-camera', by: 'Maria Santos', at: at('09:12') }, { key: 'sent-library', by: 'Maria Santos', at: at('09:13') }] };
  const waiting = [waitingPhoto('wait-1', '09:16'), waitingPhoto('wait-2', '09:17'), waitingPhoto('wait-3', '09:18'), waitingPhoto('wait-4', '09:19')];

  it('holds 4 thumbnails in view, and the newest photo is the last in the strip', () => {
    // why: F-1371 the strip has a row of its own, 352 pt wide, with 72 x 54 tiles 8 pt apart: 4 whole in view and a peek of the 5th; photos run in the order both apps share, so a new one goes last
    expect(IPHONE_16_PRO).toBe(352);
    expect([THUMB.width, THUMB.height, THUMB.gap]).toEqual([72, 54, 8]);
    expect(inView(10, IPHONE_16_PRO, 0)).toEqual([0, 1, 2, 3]);
    expect(stripContent(5)).toBeGreaterThan(IPHONE_16_PRO);
    const photos = shownPhotos(job, waiting, 'Maria Santos');
    expect(photos.map((p) => p.key)).toEqual(['sent-camera', 'sent-library', 'wait-1', 'wait-2', 'wait-3', 'wait-4']);
  });

  it('rests at its end, so the photo just saved is in view', () => {
    // why: F-1234 the owner saved 4 photos after 2 were sent and saw none of them: each was drawn past the strip's right edge
    for (let n = 1; n <= waiting.length; n++) {
      const photos = shownPhotos(job, waiting.slice(0, n), 'Maria Santos');
      const shown = inView(photos.length, IPHONE_16_PRO, stripRest(stripContent(photos.length), IPHONE_16_PRO));
      expect(shown.map((i) => photos[i]?.key)).toContain(`wait-${n}`);
      expect(shown.map((i) => photos[i]?.waiting)).toContain(true);
    }
  });

  it('does not scroll a strip that fits, nor one that is not laid out yet', () => {
    // why: F-1234 a job with up to 4 photos keeps the frame's resting place (DK-117), and an offset past the end would draw blank space
    expect(stripRest(stripContent(4), IPHONE_16_PRO)).toBe(0);
    expect(stripRest(stripContent(0), IPHONE_16_PRO)).toBe(0);
    expect(stripRest(stripContent(6), 0)).toBe(0);
    expect(stripRest(stripContent(6), IPHONE_16_PRO)).toBeCloseTo(stripContent(6) - IPHONE_16_PRO, 6);
  });
});

describe('a photo thumbnail while its image loads (F-1234)', () => {
  it('draws the placeholder under a sent photo whose file is still downloading', () => {
    // why: F-1234 API-175 serves the whole photo no-store; on a slow link it never finished before the owner left, and the tile drew nothing
    expect(thumbLayers(true, 'loading')).toEqual({ image: true, placeholder: true });
  });

  it('draws the image alone once it has loaded, and the placeholder alone when it fails or has no source', () => {
    // why: FR-TECH-3 CTL-TEC-04-10 a thumbnail that fails shows the placeholder; a loaded one is the photo
    expect(thumbLayers(true, 'loaded')).toEqual({ image: true, placeholder: false });
    expect(thumbLayers(true, 'failed')).toEqual({ image: false, placeholder: true });
    expect(thumbLayers(false, 'loading')).toEqual({ image: false, placeholder: true });
  });
});

describe('the photo reads (F-1235, UD-55)', () => {
  it('reads every tile as the small copy and only the viewer as the whole file', () => {
    // why: F-1235 a 72 x 54 tile read the whole 400-840 KB photo on every visit; API-175 size=thumb answers the small copy (UD-55)
    expect(photoPath('P-24830-1', 'thumb')).toBe('/api/v1/files/P-24830-1?size=thumb');
    expect(photoPath('P-24830-1', 'full')).toBe('/api/v1/files/P-24830-1');
    expect(photoPath('a/b', 'thumb')).toBe('/api/v1/files/a%2Fb?size=thumb');
  });

  it('takes the size names API-175 accepts', () => {
    // why: FR-TECH-3 the size the phone sends is one the contract knows (STORED_FILE_SIZES), so the server never refuses a tile read
    expect(STORED_FILE_SIZES).toContain('thumb');
  });
});
