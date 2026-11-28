// SPDX-License-Identifier: AGPL-3.0-or-later
// P10-JOB-SCREENS (K-08.11, K-08.22): the office job page's live reads and the text dialog's barred refusal, on fixed inputs. The page runs in the
// browser in the page walkers; no DOM here, so each rule is a function the screen calls.
import type { StreamEvent } from '@bw/api';
import { describe, expect, it, vi } from 'vitest';
import { refused, typed } from './Dialogs.tsx';
import { liveReads } from './JobScreen.tsx';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }), notFound: () => undefined }));

const event = (name: string, jobNumber = 24830) => ({ name, ids: { jobNumber } }) as unknown as StreamEvent;
const rig = () => {
  const read = vi.fn();
  const wayAgain = vi.fn();
  const live = liveReads({ jobNumber: 24830, own: { pending: 0, last: -Infinity }, read, wayAgain, now: () => 100_000 });
  return { read, wayAgain, live };
};

describe('the On the way panel on the live stream (K-08.11)', () => {
  // why: K-08 (row K-08.11) a reconnect makes an on-the-way call again, as the job is read again
  it('asks the panel again on a reconnect', () => {
    const { read, wayAgain, live } = rig();
    live.onReconnect?.();
    expect(read).toHaveBeenCalledTimes(1);
    expect(wayAgain).toHaveBeenCalledTimes(1);
  });

  // why: K-08 (row K-08.11) a world reset makes an on-the-way call again, and an event of another job does not
  it('asks the panel again on a world reset, and not on a change to another job', () => {
    const { read, wayAgain, live } = rig();
    live.onEvent(event('world.reset'));
    expect(wayAgain).toHaveBeenCalledTimes(1);
    live.onEvent(event('job.changed', 99));
    expect(read).toHaveBeenCalledTimes(1);
    expect(wayAgain).toHaveBeenCalledTimes(1);
  });
});

describe('the text dialog after a refusal that typing cannot fix (K-08.22)', () => {
  // why: K-08 (row K-08.22) typing after a texts-off or no-mobile refusal must keep the message beside the disabled Send
  it('keeps the bar when the person types, for texts off and for no mobile', () => {
    for (const key of ['job.text.textsOff', 'job.text.noMobile']) {
      const after = refused({ key });
      expect(after.barred).toBe(true);
      expect(typed(after)).toEqual({ shown: { key }, barred: true });
    }
  });

  // why: K-08 (row K-08.22) any other refusal is cleared by typing, and Send is free again
  it('lets the person send again after any other refusal once they type', () => {
    const after = refused({ key: 'job.text.tooLong' });
    expect(after.barred).toBe(false);
    expect(typed(after)).toEqual({ shown: null, barred: false });
  });
});
