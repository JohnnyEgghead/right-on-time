// SPDX-License-Identifier: AGPL-3.0-or-later
// The sample day at a demo moment as the Jobs list reads it (F-1651): each job's status from the seeded visit steps (sampleDay,
// the world seed's own chain), its ETA and timing from @bw/domain's etaDay (the rule the jobs list and the eta.sweep run), and
// the late text the sweep sends on its 5-minute cadence from the seed's first sweep (FIRST_SWEEP_AT) up to the moment, when the
// ETA is 20 or more minutes after the planned arrival (FR-TEXT-5, SPECIFICATIONS 6.4). Read by sample-day.test.ts and
// generator.test.ts. Pure apart from the files the loaders read.
import { existsSync, readFileSync } from 'node:fs';
import { BRANCHES, planTechnicians, readRoster, SERVICES } from '../../../db/src/seed/reference-data.ts';
import { readStreetList } from '../../../db/src/street-list.ts';
import {
  ETA_SWEEP_EVERY_MINUTES, etaDay, isLateEnoughToText, trackedDriveMinutes, type DriveMinutes, type EtaStatus, type EtaStop, type Point,
} from '../../../domain/src/planner.ts';
import { loadMapManifest, mapAsset, sha256File } from '../../../maps/src/manifest.ts';
import { parseTracks } from '../../../maps/src/tracks.ts';
import { atLocal } from '../../../time/src/index.ts';
import type { WorldFixture } from '../fixture.ts';
import { sampleDay } from '../sample-day.ts';
import { FIRST_SWEEP_AT } from '../world-seed.ts';

const MINUTE = 60_000;

export interface MomentJob {
  jobNumber: number;
  technician: string;
  branch: string;
  status: EtaStatus;
  /** An open job's SD-15 timing; an arrived one is late only if it arrived after its window. */
  timing: 'late' | 'at_risk' | 'on_time';
  eta: number;
  planned: number;
  /**
   * The sweep time that sent the late text, else null. Modeled for a job still scheduled at each sweep: a job on the way has
   * the on-the-way text's arrival as its baseline, which this does not model, so such a job without a text yet reads undefined.
   */
  lateTextAt: number | null | undefined;
  /**
   * The most minutes the ETA ran past the plan at a sweep while the job was scheduled (the late text goes at LATE_TEXT_MINUTES),
   * else null: how near a story job's late-text fact is to flipping.
   */
  lateGapMinutes: number | null;
}

/** Each customer's map point, as the world seed places it (the street's points by house number). */
export function fixturePoints(fixture: WorldFixture, streetList: string): Map<string, Point> {
  const streets = new Map(readStreetList(streetList).map((s) => [`${s.name}|${s.city}|${s.zip}`, s]));
  return new Map(fixture.customers.map((c) => {
    const s = streets.get(`${c.street}|${c.city}|${c.zip}`);
    if (!s) throw new Error(`no street for ${c.ref}`);
    const p = s.points[(c.houseNumber - 1) % s.points.length] as [number, number];
    return [c.ref, { lon: p[0], lat: p[1] }];
  }));
}

const tracksChecked = new Map<string, string | null>();
/**
 * F-1665: null when `tracksFile` is the track set packages/maps/MANIFEST.json names, the one the 10:28 AM story is written
 * for; a skip note when there is no file (no `pnpm run setup:maps` yet). A file that is another track set (an older release)
 * throws, so a story test never passes or skips on data it was not written for.
 */
export function storyTracksSkip(tracksFile: string): string | null {
  if (!tracksChecked.has(tracksFile)) {
    const want = mapAsset(loadMapManifest(), 'tracks.ndjson');
    if (!existsSync(tracksFile)) tracksChecked.set(tracksFile, `no ${tracksFile}: the 10:28 AM story needs ${want.tag}'s track set (pnpm run setup:maps)`);
    else {
      const got = sha256File(tracksFile);
      if (got !== want.sha256) {
        throw new Error(`${tracksFile} is not ${want.tag}'s track set (sha256 ${got.slice(0, 8)}, the manifest's ${want.sha256.slice(0, 8)}): run pnpm run setup:maps`);
      }
      tracksChecked.set(tracksFile, null);
    }
  }
  return tracksChecked.get(tracksFile) as string | null;
}

/** The drive minutes of the baked track set (SD-49), as setup and the sweep read them. */
export function bakedDrive(tracksFile: string): DriveMinutes {
  return trackedDriveMinutes(new Map(parseTracks(readFileSync(tracksFile, 'utf8')).map((t) => [`${t.from_ref}|${t.to_ref}`, t.seconds[t.seconds.length - 1] as number])));
}

/** Every assigned job of `date` at local time `at` ("HH:MM"), by job number. */
export function demoMoment(input: { fixture: WorldFixture; points: ReadonlyMap<string, Point>; drive: DriveMinutes; date: string; at: string }): Map<number, MomentJob> {
  const { fixture, points, drive, date } = input;
  const local = (d: string, t: string): number => atLocal(d, t, fixture.zone, 'reject').epochMilliseconds;
  const now = local(date, input.at);
  const script = new Map(fixture.sampleDayScript.map((s) => [s.jobNumber, s]));
  const roster = new Map(planTechnicians(readRoster()).map((t) => [t.employeeNumber, t]));
  const minutes = new Map(SERVICES.map((s) => [s.id as string, s.minutes]));
  const byTech = new Map<string, WorldFixture['demoWeekJobs']>();
  for (const j of fixture.demoWeekJobs) {
    if (j.date !== date || j.technician === null) continue;
    byTech.set(j.technician, [...(byTech.get(j.technician) ?? []), j]);
  }
  const sweeps: number[] = [];
  for (let t = local(FIRST_SWEEP_AT.date, FIRST_SWEEP_AT.time); t < now; t += ETA_SWEEP_EVERY_MINUTES * MINUTE) sweeps.push(t);
  sweeps.push(now); // a clock jump's replay runs the sweep once at its target (F-538)
  const out = new Map<number, MomentJob>();
  for (const [tech, list] of byTech) {
    const t = roster.get(tech);
    const depot = BRANCHES.find((b) => b.id === t?.branch);
    if (!t || !depot) throw new Error(`no technician ${tech}`);
    const shiftStart = local(date, t.shiftStart);
    const stopsBase = list.map((j) => {
      const [bd, bt] = j.bookedAt.split('T') as [string, string];
      return {
        jobNumber: j.jobNumber, windowStart: local(j.date, j.windowStart), windowEnd: local(j.date, j.windowEnd), bookedAt: local(bd, bt),
        expectedMinutes: minutes.get(j.service) as number, point: points.get(j.customer) as Point,
      };
    });
    const { planned, steps } = sampleDay({ shiftStart, depot, jobs: stopsBase, drive, script });
    const stepOf = new Map(steps.map((s) => [s.jobNumber, s]));
    const plannedOf = new Map(planned.map((p) => [p.jobNumber, p.plannedArrival]));
    const at = (when: number): { stops: EtaStop[]; etas: Map<number, { eta: number; timing: MomentJob['timing'] }> } => {
      const stops: EtaStop[] = stopsBase.map((b) => {
        const s = stepOf.get(b.jobNumber);
        const st: EtaStop = { ...b, status: 'scheduled', onTheWayAt: null, arrivedAt: null, endedAt: null };
        if (s && s.onMyWay <= when) Object.assign(st, { status: 'on_the_way', onTheWayAt: s.onMyWay });
        if (s && s.arrived <= when) Object.assign(st, { status: 'on_site', arrivedAt: s.arrived });
        if (s && s.ended <= when) Object.assign(st, { status: script.get(b.jobNumber)?.outcome === 'no_one_home' ? 'no_one_home' : 'done', endedAt: s.ended });
        return st;
      });
      return { stops, etas: new Map(etaDay({ now: when, shiftStart, depot, stops, drive }).map((e) => [e.jobNumber, e])) };
    };
    const lateText = new Map<number, number | null | undefined>(stopsBase.map((b) => [b.jobNumber, null]));
    const lateGap = new Map<number, number>();
    for (const when of sweeps) {
      const { stops, etas } = at(when);
      for (const s of stops) {
        if (s.status === 'scheduled') {
          const gap = Math.round(((etas.get(s.jobNumber) as { eta: number }).eta - (plannedOf.get(s.jobNumber) as number)) / MINUTE);
          lateGap.set(s.jobNumber, Math.max(gap, lateGap.get(s.jobNumber) ?? gap));
        }
        if (lateText.get(s.jobNumber) !== null) continue;
        if (s.status === 'on_the_way') { lateText.set(s.jobNumber, undefined); continue; }
        if (s.status !== 'scheduled') continue;
        if (isLateEnoughToText((etas.get(s.jobNumber) as { eta: number }).eta, plannedOf.get(s.jobNumber) as number)) lateText.set(s.jobNumber, when);
      }
    }
    const { stops, etas } = at(now);
    for (const s of stops) {
      const e = etas.get(s.jobNumber) as { eta: number; timing: MomentJob['timing'] };
      out.set(s.jobNumber, {
        jobNumber: s.jobNumber, technician: tech, branch: t.branch, status: s.status, timing: e.timing, eta: e.eta,
        planned: plannedOf.get(s.jobNumber) as number, lateTextAt: lateText.get(s.jobNumber),
        lateGapMinutes: lateGap.get(s.jobNumber) ?? null,
      });
    }
  }
  return out;
}
