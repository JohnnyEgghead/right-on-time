// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TEXT-4, NFR-04 (G-CI5 inv5-location-window: the link-ended rule and the data row's reads, no database)
// The committed cases of the live map's rule (handlers/live-map.ts liveMapLinkState): a link is live only while its job is on the way, the
// clock has reached the moment it left and nothing ended the link; every other state is ended, with the reason the page words. And the data
// row (API-116) reads no coordinate at all in an ended state: its queries are recorded, and none names a place.
// P5-INBOX's preview picture (API-164) reads the same rule; its case is its own file in this folder.
import type { Queryable } from '../../../packages/db/src/index.ts';
import { Temporal } from '../../../packages/time/src/index.ts';
import { describe, expect, it } from 'vitest';
import { liveMapDataHandler, liveMapLinkState, type LinkFacts } from '../../../packages/api-server/src/handlers/live-map.ts';
import type { ApiRequest } from '../../../packages/api-server/src/types.ts';

const T0 = Date.UTC(2026, 8, 15, 14, 28);
const MIN = 60_000;
const facts = (over: { endedAt?: number | null; job?: Partial<LinkFacts['job']> } = {}): LinkFacts => ({
  endedAt: over.endedAt ?? null, job: { status: 'on_the_way', onTheWayAt: T0, arrivedAt: null, technicianId: 't-1', ...over.job },
});

describe('the link-ended rule (FR-TEXT-4, NFR-04)', () => {
  // why: FR-TEXT-4
  it('is live from On my way until arrival, and ended before it, after it and after each office change', () => {
    expect(liveMapLinkState(facts(), T0 + 5 * MIN)).toEqual({ live: true });
    expect(liveMapLinkState(facts(), T0)).toEqual({ live: true });
    // Before On my way (a clock behind the departure): ended, never the van.
    expect(liveMapLinkState(facts(), T0 - 1)).toEqual({ live: false, reason: 'changed' });
    // After arrival: the arrival ended the link and the job holds its arrival.
    expect(liveMapLinkState(facts({ endedAt: T0 + 13 * MIN, job: { status: 'on_site', arrivedAt: T0 + 13 * MIN } }), T0 + 15 * MIN)).toEqual({ live: false, reason: 'arrived' });
    // The office canceled, reassigned or rescheduled the trip: the link ended, the job holds no arrival (reassign clears it).
    for (const status of ['canceled', 'scheduled', 'on_the_way']) {
      expect(liveMapLinkState(facts({ endedAt: T0 + 3 * MIN, job: { status } }), T0 + 5 * MIN), status).toEqual({ live: false, reason: 'changed' });
    }
  });

  // why: NFR-04
  it('never calls a link live whose end stamp is set, whatever the job says, and a later arrival does not turn a changed link into an arrived one', () => {
    expect(liveMapLinkState(facts({ endedAt: T0 + MIN }), T0 + 5 * MIN).live).toBe(false);
    // Ended at 10:31 by the office; the new technician arrives at 10:41: this link is still the changed one.
    expect(liveMapLinkState(facts({ endedAt: T0 + 3 * MIN, job: { status: 'on_site', arrivedAt: T0 + 13 * MIN } }), T0 + 15 * MIN)).toEqual({ live: false, reason: 'changed' });
    // A job off the way with no end stamp (a write that forgot it) is still ended.
    for (const status of ['scheduled', 'on_site', 'done', 'no_one_home', 'canceled']) expect(liveMapLinkState(facts({ job: { status } }), T0 + 5 * MIN).live, status).toBe(false);
    // On the way with no departure stamp is not a trip.
    expect(liveMapLinkState(facts({ job: { onTheWayAt: null } }), T0 + 5 * MIN).live).toBe(false);
  });

  // why: FR-TEXT-4
  it('ends a link whose On the way job has no technician, for the page, the data and the preview alike (F-949)', () => {
    expect(liveMapLinkState(facts({ job: { technicianId: null } }), T0 + 5 * MIN)).toEqual({ live: false, reason: 'changed' });
  });
});

/** A transaction that holds 1 ended link and records every query: the data row's reads are what the test inspects. */
function recording(link: Record<string, unknown>): { tx: Queryable; sql: string[] } {
  const sql: string[] = [];
  const tx = {
    query: async (text: string) => {
      sql.push(text);
      return { rows: text.includes('FROM world.link_token') ? [link] : [], rowCount: 1 };
    },
  } as unknown as Queryable;
  return { tx, sql };
}
const ended = (over: Record<string, unknown>) => ({
  token: 'xxxxxxxx', created_at: new Date(T0 + 2 * MIN), ended_at: new Date(T0 + 13 * MIN), job_number: 24825, status: 'on_site', zone: 'America/New_York',
  branch_id: 'columbus', date: '2026-09-15', screen_label_key: 'service.furnace_tune_up', window_start: new Date(T0 - 4 * 60 * MIN), window_end: new Date(T0 - 2 * 60 * MIN),
  on_the_way_at: new Date(T0), arrived_at: new Date(T0 + 13 * MIN), texted_arrival: null, planned_arrival: null, technician_id: 't-1', tech_name: 'Maria Santos',
  van: '12', office_phone: '(614) 555-0100', ...over,
});
const request = (now: number): ApiRequest => ({ contract: 'API-116', params: { liveMapToken: 'xxxxxxxx' }, body: undefined, caller: { kind: 'anonymous' }, worldEpoch: 1, demoNow: Temporal.Instant.fromEpochMilliseconds(now) }) as unknown as ApiRequest;

describe('the data row reads no coordinate once the link has ended (NFR-04)', () => {
  // why: NFR-04
  it.each([
    ['after arrival', ended({})],
    ['after the office canceled the trip', ended({ status: 'canceled', arrived_at: null })],
    ['after the office reassigned the trip', ended({ status: 'scheduled', arrived_at: null, on_the_way_at: null })],
    ['before On my way', ended({ ended_at: null, status: 'scheduled', arrived_at: null, on_the_way_at: null })],
  ])('%s: answers 410 and runs no query beyond the link read', async (_name, link) => {
    const { tx, sql } = recording(link);
    const r = await liveMapDataHandler(request(T0 + 20 * MIN), tx, {} as never);
    expect(r).toMatchObject({ ok: false, status: 410, code: 'gone' });
    // One query: the link and its job. No customer coordinate, depot, track or previous stop was read.
    expect(sql).toHaveLength(1);
    expect(JSON.stringify(r)).not.toMatch(/lon|lat|polyline/);
  });
});
