// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-854 (the board stack suite's expect.poll waits 1 s by default; a Playwright read on a loaded host needs longer)
import { describe, expect, it } from 'vitest';
import config from './vitest.config.ts';

describe('the board stack suite config', () => {
  it('lets expect.poll wait at least 30 s', () => {
    // why: F-854; the map panel cases failed on Chromium at load 40 to 150 inside the default 1 s window
    const poll = (config.test as { expect?: { poll?: { timeout?: number } } } | undefined)?.expect?.poll;
    expect(poll?.timeout).toBeGreaterThanOrEqual(30_000);
  });
});
