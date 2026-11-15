// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { areaName } from './places.ts';

describe('areaName (F-1652)', () => {
  // why: F-1652 the approved Jobs page says Clintonville for the Clintonville ZIPs; every other ZIP says its street's city
  it('names Clintonville for 43202 and 43214 and the city for any other ZIP', () => {
    expect(areaName('Columbus', '43202')).toBe('Clintonville');
    expect(areaName('Columbus', '43214')).toBe('Clintonville');
    expect(areaName('Columbus', '43215')).toBe('Columbus');
    expect(areaName('Dublin', '43017')).toBe('Dublin');
  });
});
