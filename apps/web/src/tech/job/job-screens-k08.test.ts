// SPDX-License-Identifier: AGPL-3.0-or-later
// P10-JOB-SCREENS (K-08.9, K-08.10, K-08.23): the web technician app's Finish and Job screens, on the rules they draw from. The screens run in the
// browser in the page walkers; these hold each rule on fixed inputs (no DOM here, so the rule is a function the screen calls).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoWire } from './model.ts';
import { holdPhotoUrl, signingTime } from './FinishScreen.tsx';
import { directionsOffered } from './JobScreen.tsx';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }), notFound: () => undefined }));

const ZONE = 'America/New_York';
const at = (hhmm: string) => Date.parse(`2026-09-15T${hhmm}:00-04:00`);

describe('the time on the signature (K-08.9)', () => {
  // why: K-08 (row K-08.9) a clock moved between opening the screen and signing gives the signing time, not the time the screen opened
  it('reads the demo time when the customer signs, not when the screen opened', async () => {
    let now = at('10:00');
    const read = () => Promise.resolve(now);
    const opened = await signingTime(read, ZONE);
    now = at('13:45');
    const signed = await signingTime(read, ZONE);
    expect(opened).toBe(demoWire(at('10:00'), ZONE));
    expect(signed).toBe(demoWire(at('13:45'), ZONE));
  });

  // why: K-08 (row K-08.9) a phone with no demo offset (or a failed read) signs with the device's own clock, never a blank
  it('falls back to the device clock when the phone has no demo time', async () => {
    const none = await signingTime(() => Promise.resolve(null), ZONE);
    const failed = await signingTime(() => Promise.reject(new Error('store')), ZONE);
    for (const wire of [none, failed]) expect(wire).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[-+]\d{2}:\d{2}\[America\/New_York\]$/);
  });
});

describe('the photo thumbnail\'s object URL (K-08.23)', () => {
  const made: string[] = [];
  const revoked: string[] = [];
  beforeEach(() => {
    made.length = 0;
    revoked.length = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const u = `blob:test/${made.length + 1}`;
      made.push(u);
      return u;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => void revoked.push(u));
  });
  afterEach(() => vi.restoreAllMocks());

  // why: K-08 (row K-08.23) a photo blob that lands after the screen closed is revoked at once, so no object URL is left behind
  it('revokes a blob that lands after the cleanup, and never shows it', async () => {
    let land: (b: Blob) => void = () => undefined;
    const onUrl = vi.fn();
    const stop = holdPhotoUrl(() => new Promise<Blob>((resolve) => (land = resolve)), onUrl, vi.fn());
    stop();
    land(new Blob(['x']));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(made).toEqual(['blob:test/1']);
    expect(revoked).toEqual(['blob:test/1']);
    expect(onUrl).not.toHaveBeenCalled();
  });

  // why: K-08 (row K-08.23) a blob that landed in time is shown, and revoked once when the screen closes
  it('shows a blob that lands in time and revokes it once at the cleanup', async () => {
    const onUrl = vi.fn();
    const stop = holdPhotoUrl(() => Promise.resolve(new Blob(['x'])), onUrl, vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onUrl).toHaveBeenCalledWith('blob:test/1');
    expect(revoked).toEqual([]);
    stop();
    expect(revoked).toEqual(['blob:test/1']);
  });
});

describe('Directions on a kept copy (K-08.10)', () => {
  const job = (today: boolean) => ({ job: { today, window: { start: '2026-09-15T10:00:00-04:00[America/New_York]' } } }) as never;

  // why: K-08 (row K-08.10) a kept copy from a past demo day shows no Directions (Call is hidden for it too)
  it('offers no Directions for a copy kept from a past demo day, and offers it on the job\'s own day', () => {
    expect(directionsOffered(job(true), 'scheduled', at('09:00'), true)).toBe(true);
    expect(directionsOffered(job(true), 'scheduled', at('09:00') + 86_400_000, true)).toBe(false);
    expect(directionsOffered(job(true), 'on_the_way', at('09:00') + 86_400_000, true)).toBe(false);
  });

  // why: K-08 (row K-08.10) Directions stays for Scheduled and On the way only, and a preview takes the copy's own today
  it('keeps to Scheduled and On the way, and to the copy\'s own today in a preview', () => {
    expect(directionsOffered(job(true), 'on_site', at('09:00'), false)).toBe(false);
    expect(directionsOffered(job(false), 'scheduled', at('09:00'), false)).toBe(false);
    expect(directionsOffered(job(true), 'scheduled', null, true, true)).toBe(true);
  });
});
