// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { postDelaySamples } from './delay-samples.ts';

describe('postDelaySamples', () => {
  // why: FR-HLTH-3 the slowest delay must not include the queue of the sampler's own calls (F-640)
  it('starts every call of a burst before any one answers', async () => {
    const started: number[] = [];
    const release: Array<() => void> = [];
    const done = postDelaySamples([11, 12, 13], (seq) => {
      started.push(seq);
      return new Promise<void>((resolve) => release.push(resolve));
    });
    await Promise.resolve();
    expect(started).toEqual([11, 12, 13]);
    release.forEach((r) => r());
    await done;
  });

  // why: FR-HLTH-3 a failed or refused sample is only a missed sample; the rest still post (F-640)
  it('lets one failure pass and drops a seq that is not positive', async () => {
    const sent: number[] = [];
    await postDelaySamples([0, 5, 6], async (seq) => {
      sent.push(seq);
      if (seq === 5) throw new Error('down');
    });
    expect(sent).toEqual([5, 6]);
  });
});
