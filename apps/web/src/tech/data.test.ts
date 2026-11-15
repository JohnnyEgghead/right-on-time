// SPDX-License-Identifier: AGPL-3.0-or-later
// The technician app's reads of the day and its day-changed notices (data.ts; P5-TWA-MAP-ME, CTL-TEC-02-14, UD-43, OI-34) over the real typed
// @bw/api client, whose fetch is a scripted server answering the real contract shapes. The browsers and the real server run the same reads in
// ci/mapme-stack (the stack suite).
import { createClient } from '@bw/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatterFor } from '@bw/i18n/src/format.ts';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { EMPTY_DATA, TechReads, useTechData } from './data.ts';
import { forgetPerson, KEYS } from './local.ts';
import { driveMinutes } from './job/useJob.ts';
import { stepRows, stepsPhase } from './steps.ts';
import { legReader } from './today/TodayScreen.tsx';
import { directionsMinutes } from './today/model.ts';

const Z = '[America/New_York]';
const at = (hhmm: string) => `2026-09-15T${hhmm}-04:00${Z}`;
const meta = (contract: string) => ({ contract, worldEpoch: 2, demoNow: at('10:26:00'), viewer: { kind: 'public' }, labels: [] });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const job = (jobNumber: number, a = '10', b = '12') => ({
  jobNumber, version: 1, position: 1, status: 'scheduled' as const, window: { start: at(`${a}:00:00`), end: at(`${b}:00:00`) },
  customer: { name: 'C', language: 'en' as const, phone: '(614) 555-0199' }, address: '1 Main St, Westerville', area: 'A',
  serviceLabelKey: 'service.furnace_tune_up.screen', equipment: null, lastVisit: null, customerNote: 'Gate code 4412', plannedArrival: null, textedArrival: null,
  endedAt: null, lateText: null, onMyWayPreview: null,
});
const dayOf = (jobs: ReturnType<typeof job>[]) => ({
  date: '2026-09-15', asOf: at('10:26:00'), zone: 'America/New_York', van: { number: '12', vehicle: 'Ford Transit 250' }, startedAt: null, officePhone: '(614) 555-0100',
  technician: { name: 'Maria Santos', initials: 'MS', employeeNumber: '40712', skill: 'heating_cooling', branch: 'columbus' }, jobs,
});

/** A scripted server: the day it answers can change between reads, and the network can go down. */
function world() {
  const s = { jobs: [job(1, '08', '10'), job(2)], down: false, calls: [] as string[] };
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    s.calls.push(path);
    if (s.down) throw new TypeError('fetch failed');
    if (path.endsWith('/tech/day')) return json(200, { data: dayOf(s.jobs), meta: meta('API-100') });
    if (path.endsWith('/tech/day-route')) return json(200, { data: { date: '2026-09-15', branch: 'columbus', stops: [], legs: [], next: null }, meta: meta('API-163') });
    if (path.endsWith('/parts')) return json(200, { data: { parts: [{ partId: 'p1', name: 'Run capacitor', code: 'CAP-455', priceCents: 3800 }] }, meta: meta('API-107') });
    return json(404, { type: 'https://bw.j7l.io/errors/not_found', title: 'x', status: 404, code: 'not_found' });
  };
  return { s, reads: new TechReads(createClient({ baseUrl: 'http://phone.test', fetch }), () => true) };
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
});

describe('the reads of the day', () => {
  // why: FR-TECH-10 the parts list is read with signal and kept on the phone, and a phone that never read it has none
  it('keeps the parts list it read for the Parts tab to search with no signal', async () => {
    const { reads } = world();
    expect(reads.snapshot.parts).toBeNull();
    await reads.refresh();
    expect(reads.snapshot.parts?.data.map((p) => p.code)).toEqual(['CAP-455']);
    expect(JSON.parse(window.localStorage.getItem(KEYS.parts)!).data).toHaveLength(1);
    // a phone opened later with no signal finds the copy
    const again = new TechReads(createClient({ baseUrl: 'http://phone.test', fetch: async () => { throw new TypeError('fetch failed'); } }), () => true);
    expect(again.snapshot.parts?.data[0]?.name).toBe('Run capacitor');
    await again.refresh();
    expect(again.snapshot.online).toBe(false);
    expect(again.snapshot.parts?.data[0]?.name).toBe('Run capacitor');
  });

  // why: FR-TECH-10 (SPECIFICATIONS 6.3) the parts list is read at every open with signal, so an open refreshes a kept copy (F-1007)
  it('reads the parts list again on the first round of each open, though a copy is kept, and not on the second', async () => {
    const first = world();
    await first.reads.refresh();
    expect(first.s.calls.filter((c) => c.endsWith('/parts'))).toHaveLength(1);
    const next = world(); // a new open over the copy the first one kept
    expect(next.reads.snapshot.parts).not.toBeNull();
    await next.reads.refresh();
    await next.reads.refresh();
    expect(next.s.calls.filter((c) => c.endsWith('/parts'))).toHaveLength(1);
  });

  // why: FR-TECH-2 (F-1019) a 401 on the read of the day is an ended session, not a failed read to retry; a 5xx is a failed read
  it('marks signedOut on a 401 read and only failed on a 503', async () => {
    const { s, reads } = world();
    const seen: number[] = [];
    const down = (status: number) => async (input: RequestInfo | URL) => {
      seen.push(status);
      void input;
      const code = status === 401 ? 'unauthenticated' : 'server_error';
      return json(status, { type: `https://bw.j7l.io/errors/${code}`, title: 'x', status, code, meta: { contract: 'API-100', worldEpoch: 0, demoNow: '' } });
    };
    void s;
    const r401 = new TechReads(createClient({ baseUrl: 'http://phone.test', fetch: down(401) }), () => true);
    await r401.refresh();
    expect(r401.snapshot).toMatchObject({ failed: true, signedOut: true, settled: true, day: null });
    const r503 = new TechReads(createClient({ baseUrl: 'http://phone.test', fetch: down(503) }), () => true);
    await r503.refresh();
    expect(r503.snapshot).toMatchObject({ failed: true, signedOut: false, day: null });
    expect(reads.snapshot.signedOut).toBe(false);
  });

  // why: FR-TECH-15 a job moved by the office raises 1 day-changed notice while the Notifications switch is on
  it('raises 1 notice when a re-read finds a job gone from the day', async () => {
    const { s, reads } = world();
    await reads.refresh();
    expect(reads.snapshot.notices).toEqual([]);
    s.jobs = [job(1, '08', '10')];
    await reads.refresh();
    expect(reads.snapshot.notices).toEqual([expect.objectContaining({ change: { kind: 'removed', job: 2 }, n: 1 })]);
    await reads.refresh();
    expect(reads.snapshot.notices).toHaveLength(1);
  });

  // why: FR-TECH-15 with the Notifications switch off a changed day raises no notice, and the switch is kept on the phone
  it('raises none with the switch off, and keeps the switch', async () => {
    const { s, reads } = world();
    await reads.refresh();
    reads.setNotices(false);
    expect(JSON.parse(window.localStorage.getItem(KEYS.notices)!)).toBe(false);
    s.jobs = [job(1, '08', '10')];
    await reads.refresh();
    expect(reads.snapshot.notices).toEqual([]);
    // turned on again, the next change raises its notice (the day it compares with is the one last read)
    reads.setNotices(true);
    s.jobs = [job(1, '08', '10'), job(3)];
    await reads.refresh();
    expect(reads.snapshot.notices).toEqual([expect.objectContaining({ change: { kind: 'added', job: 3 } })]);
  });

  // why: FR-TECH-15 several jobs changed in 1 read raise 1 notice that says how many
  it('raises 1 notice for several changes in 1 read', async () => {
    const { s, reads } = world();
    await reads.refresh();
    s.jobs = [job(2, '12', '14'), job(3)];
    await reads.refresh();
    expect(reads.snapshot.notices).toHaveLength(1);
    expect(reads.snapshot.notices[0]).toMatchObject({ change: null, n: 3 });
  });

  // why: FR-TECH-15 Text size is kept on the phone and stays set after the app closes (a new session of the reads finds it)
  it('keeps the text size', () => {
    const { reads } = world();
    expect(reads.snapshot.textSize).toBe('standard');
    reads.setSize('large');
    expect(new TechReads(createClient({ baseUrl: 'http://phone.test', fetch: async () => json(500, {}) }), () => true).snapshot.textSize).toBe('large');
  });

  // why: FR-TECH-10 with no connection the reads are not tried, the phone says it is offline and keeps what it holds
  it('does not call out while the browser says it is offline', async () => {
    const { s } = world();
    const reads = new TechReads(createClient({ baseUrl: 'http://phone.test', fetch: async () => { s.calls.push('called'); return json(200, {}); } }), () => false);
    await reads.refresh();
    expect(s.calls).toEqual([]);
    expect(reads.snapshot).toMatchObject({ online: false, settled: true });
  });
});

describe('the saved day belongs to the person', () => {
  // why: F-1017 the day saved on the phone holds customer names, addresses, phones and notes, so Sign out forgets it (and the old Today copy)
  it('forgets the saved day, with its names and notes, at sign-out', async () => {
    const { reads } = world();
    await reads.refresh();
    expect(window.localStorage.getItem(KEYS.day)).toContain('Gate code 4412');
    window.localStorage.setItem('bw.tech.today.v1', '{"answer":{"jobs":[]}}');
    forgetPerson();
    expect(window.localStorage.getItem(KEYS.day)).toBeNull();
    expect(window.localStorage.getItem('bw.tech.today.v1')).toBeNull();
    expect(new TechReads(createClient({ baseUrl: 'http://phone.test', fetch: async () => { throw new TypeError('fetch failed'); } }), () => true).snapshot.day).toBeNull();
  });

  // why: F-1017 the page's own first read is kept as the saved day, unless a newer one is already kept
  it('keeps the day the page carried, and never an older one over a newer one', () => {
    const { reads } = world();
    reads.adopt({ at: at('10:00:00'), data: dayOf([job(1)]) });
    expect(JSON.parse(window.localStorage.getItem(KEYS.day)!).data.jobs).toHaveLength(1);
    reads.adopt({ at: at('09:00:00'), data: dayOf([job(1), job(2)]) });
    expect(reads.snapshot.day?.data.jobs).toHaveLength(1);
  });

  // why: F-1017 a read still in flight when the person signs out must not save the day it read afterwards
  it('saves nothing from a read that was in flight at sign-out', async () => {
    const { reads } = world();
    const round = reads.refresh();
    reads.clear();
    forgetPerson();
    await round;
    expect(window.localStorage.getItem(KEYS.day)).toBeNull();
    expect(window.localStorage.getItem(KEYS.route)).toBeNull();
  });
});

describe('the minutes reads keep the route (rule 11, F-1333)', () => {
  const leg = { from: { lon: -82.93, lat: 40.12 }, to: { lon: -82.99, lat: 40.13 }, track: [[-82.93, 40.12], [-82.99, 40.13]], minutes: 14, distanceMeters: 7442 };
  const step = { kind: 'depart', direction: null, heading: 'w', road: 'Spring Hollow Court', exit: null, side: null, at: [-82.93, 40.12], distanceMeters: 10 };
  const routed = (): { reads: TechReads; down: { on: boolean } } => {
    const down = { on: false };
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      if (!path.endsWith('/tech/route')) return json(404, {});
      if (down.on) throw new TypeError('fetch failed');
      return json(200, { data: { branch: 'columbus', leg, insideWindow: true, steps: [step] }, meta: meta('API-104') });
    };
    return { reads: new TechReads(createClient({ baseUrl: 'http://phone.test', fetch }), () => true), down };
  };

  // why: FR-TECH-5 F-1333 a Today read of the Directions minutes made with signal keeps the steps, so Directions with no signal shows them with no step marked Now
  it('keeps the route a Today read made, so Directions shows the kept steps with no signal', async () => {
    const { reads, down } = routed();
    reads.adopt({ at: at('10:26:00'), data: dayOf([job(1), job(24828)]) });
    expect(await directionsMinutes(legReader(reads), 24828, true)).toEqual({ job: 24828, minutes: 14 });
    down.on = true;
    const kept = reads.keptRoute(24828);
    expect(kept?.steps).toHaveLength(1);
    expect(stepsPhase(null, true, kept !== null, true)).toBe('offlineSaved');
    expect(stepRows(kept!.steps, formatterFor('en'), '2271 Cobblestone Avenue', false).some((r) => r.now)).toBe(false);
  });

  // why: FR-TECH-5 F-1333 F-1369 the Job screen's drive-minutes read (the leg into this job, none from another job) keeps the route too, and still shows no minutes for a leg with no baked track
  it('keeps the route a Job screen read made, and gives no minutes without a track', async () => {
    const { reads } = routed();
    reads.adopt({ at: at('10:26:00'), data: dayOf([job(1), job(24828)]) });
    expect(await driveMinutes(reads, 24828)).toBe(14);
    expect(reads.keptRoute(24828)?.steps).toHaveLength(1);
    expect(await driveMinutes({ leg: async () => ({ kind: 'leg', leg: { ...leg, track: null }, branch: 'columbus', steps: [], at: '' }) }, 24828)).toBeNull();
  });
});

describe('the server draws a page that has not read the phone (F-1434)', () => {
  // why: F-1434 UI-SPECIFICATION 4.5 rule 12: the server snapshot is the Reading the phone state, so a page never draws No copy yet or No van assigned before it has read the kept copy
  it('hands a server render the unread snapshot, and a fixed preview state is never unread', () => {
    let seen: boolean | undefined;
    const Probe = () => {
      seen = useTechData().reading;
      return null;
    };
    renderToString(createElement(Probe));
    expect(seen).toBe(true);
    const fixed = { ...EMPTY_DATA };
    const Fixed = () => {
      seen = useTechData(fixed).reading;
      return null;
    };
    renderToString(createElement(Fixed));
    expect(seen).toBeUndefined();
  });
});
