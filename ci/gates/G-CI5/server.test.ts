// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: NFR-04 (G-CI5 inv5-location-window, server case of P3-POSITIONS: a van's point exists only while its job is on the way)
// Invariant 5 (BUILD_PLAN section 7 gate map; FR-TEXT-4): the live map shows the van from On my way to arrival and
// at no other time. This is the server half, at the function every position read goes through (visitPosition of @bw/maps):
// before On my way and from arrival on it answers null WITHOUT touching a coordinate, and a position needs a job `on_the_way`.
// P5-LIVEMAP activates the gate and adds the page and data cases (410 with no coordinates; WebKit back and forward), P5-INBOX
// the preview case; each is its own file beside this one.
import { describe, expect, it } from 'vitest';
import { visitPosition, type LegTrack, type Point } from '../../../packages/maps/src/position.ts';

const T0 = Date.UTC(2026, 8, 15, 14, 0);
const track: LegTrack = { polyline: '_p~iF~ps|U_ulLnnqC', seconds: [0, 600] };

/** A visit whose coordinates throw when read: a read of any of them before On my way or after arrival is a failure. */
const guarded = (status: string, now: number) => {
  const trap = (): never => {
    throw new Error('a coordinate was read outside the on-the-way window');
  };
  return {
    status, now, onTheWayAt: T0,
    get from(): Point { return trap(); },
    get to(): Point { return trap(); },
    get track(): LegTrack | null { return trap(); },
  };
};

describe('G-CI5 server: the position exists only while the job is on the way', () => {
  // why: NFR-04
  it.each(['scheduled', 'on_site', 'done', 'no_one_home', 'canceled'])('answers null for a %s job and reads no coordinate', (status) => {
    expect(visitPosition(guarded(status, T0 + 300_000))).toBeNull();
  });

  // why: FR-TEXT-4
  it('answers a point for an on-the-way job, none before it left and none the moment it arrived', () => {
    const base = { onTheWayAt: T0, from: { lon: -120.2, lat: 38.5 }, to: { lon: -126.45, lat: 43.252 }, track };
    expect(visitPosition({ ...base, status: 'scheduled', now: T0 - 1 })).toBeNull();
    expect(visitPosition({ ...base, status: 'on_the_way', now: T0 + 300_000 })).not.toBeNull();
    expect(visitPosition({ ...base, status: 'on_site', now: T0 + 300_001 })).toBeNull();
  });
});
