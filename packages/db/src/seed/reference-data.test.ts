// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-440 (FR-BILL-3, OA-54) a seeded job's part fits its own service's equipment, and a part's price follows its size.
// The checks below are word rules about equipment written apart from reference-data.ts's lists, so they judge those lists
// rather than restate them. Mockup parts are left out: MOCKUP_FITS places them (F-428) and the approved pages show them.
import { describe, expect, it } from 'vitest';
import { MOCKUP_PARTS, PARTS, partCodeForLine, SERVICES } from './reference-data.ts';

/** Gas-fired parts: a furnace, boiler or tank water heater has them; a thermostat, sump pump or AC tune-up never does. */
const GAS = /\bgas\b(?! rated)|igniter|ignitor|flame|thermocouple|pilot|inducer|burner|pressure switch/i;
/** Hydronic boiler parts: only a boiler job takes them. */
const BOILER = /boiler|aquastat|low water cutoff|circulator|zone valve/i;
/** The outdoor AC unit's parts: an AC tune-up or a heating or AC fix takes them; a furnace, thermostat, boiler or sump job never does. */
const OUTDOOR = /condenser|compressor|contactor|hard start|defrost|dual run capacitor|start capacitor|refrigerant|line set|disconnect|fused pullout|reversing|expansion valve|filter drier|fan guard/i;
/** Fixture and outdoor water valves: a plumbing repair's, never a boiler's or a sump pump's. */
const FIXTURE_VALVE = /hose bibb|sillcock|angle stop|quarter-turn stop|pressure reducing valve|backflow/i;
/** The tank and tankless water heater's own parts. */
const WATER_HEATER = /water heater|anode|dip tube|tankless|descaler|flush pump|heating element/i;
/** The air handler's moving parts: no thermostat job replaces a motor or a belt. */
const BLOWER = /motor|blower|belt|pulley|bearing/i;

/** Per service, the word rules a generated part's name must not match. */
const NOT_FOR: Readonly<Record<string, readonly RegExp[]>> = {
  furnace_tune_up: [OUTDOOR, BOILER, WATER_HEATER, FIXTURE_VALVE],
  ac_tune_up: [GAS, BOILER, WATER_HEATER, FIXTURE_VALVE],
  heating_or_ac_fix: [WATER_HEATER, FIXTURE_VALVE],
  plumbing_repair: [OUTDOOR, BLOWER],
  water_heater: [OUTDOOR, BLOWER],
  thermostat: [GAS, BOILER, OUTDOOR, WATER_HEATER, FIXTURE_VALVE, BLOWER],
  boiler_repair: [OUTDOOR, WATER_HEATER, /hose bibb|sillcock|angle stop|quarter-turn stop/i],
  tankless_heater_flush: [OUTDOOR, BOILER, BLOWER],
  sump_pump_install: [GAS, BOILER, OUTDOOR, WATER_HEATER, FIXTURE_VALVE, BLOWER],
};

const mockup = new Set(MOCKUP_PARTS.map((p) => p.code));
const nameOf = new Map(PARTS.map((p) => [p.code, p.name]));

describe('a seeded part line fits its own service (F-440)', () => {
  // why: F-440 (FR-BILL-3) over every line a job of each service can draw (job numbers 24000 to 26999, lines 0 to 3, the range the world
  // seed's pilot and demo-week jobs use), no generated part belongs to another service's equipment
  it("finds no line, over 12,000 job lines per service, whose part belongs to another service's equipment", () => {
    expect(Object.keys(NOT_FOR).sort()).toEqual(SERVICES.map((s) => s.id).sort());
    const off: Record<string, string[]> = {};
    for (const s of SERVICES) {
      const bad = new Set<string>();
      for (let job = 24_000; job < 27_000; job++) {
        for (let k = 0; k < 4; k++) {
          const code = partCodeForLine(job, k, s.id);
          if (mockup.has(code)) continue;
          const name = nameOf.get(code) as string;
          if ((NOT_FOR[s.id] as readonly RegExp[]).some((re) => re.test(name))) bad.add(name);
        }
      }
      if (bad.size > 0) off[s.id] = [...bad].sort().slice(0, 5);
    }
    expect(off).toEqual({});
  });

  // why: F-440 every service still draws from more than 1 family of generated parts, so the fit narrowed the lists without emptying one
  it('leaves every service at least 40 distinct generated parts to draw', () => {
    for (const s of SERVICES) {
      const codes = new Set<string>();
      for (let job = 24_000; job < 27_000; job++) for (let k = 0; k < 4; k++) codes.add(partCodeForLine(job, k, s.id));
      const prefixes = new Set([...codes].filter((c) => !mockup.has(c)).map((c) => c.slice(0, 3)));
      expect([s.id, [...codes].filter((c) => !mockup.has(c)).length >= 40, prefixes.size > 1]).toEqual([s.id, true, true]);
    }
  });
});

describe("a part's price follows its size (F-440)", () => {
  // why: F-440 a noun's specs are listed smallest first, so a bigger size never costs less (the review's cases: copper pipe 1/2 in vs
  // 1-1/2 in, ball valve 5/8 in vs 3 in, compressor 2.5 ton vs 4 ton, expansion tank 2 gal vs 8 gal)
  it("prices the review's 4 pairs in size order", () => {
    const cents = (name: string): number => {
      const p = PARTS.find((q) => q.name === name);
      if (!p) throw new Error(`no part ${name}`);
      return p.cents;
    };
    expect(cents('Copper pipe, type L, 10 ft 1/2 in')).toBeLessThan(cents('Copper pipe, type L, 10 ft 1-1/2 in'));
    expect(cents('Ball valve 5/8 in')).toBeLessThan(cents('Ball valve 3 in'));
    expect(cents('Compressor 2.5 ton, R-410A')).toBeLessThan(cents('Compressor 4 ton, R-410A'));
    expect(cents('Expansion tank 2 gal')).toBeLessThan(cents('Expansion tank 8 gal'));
  });

  // why: F-440 over every noun sold by 1 pipe size (a reducer or a coil names 2 sizes and is left out), the generated prices rise with the size
  it('never prices a larger size of the same part below a smaller one', () => {
    const sizes = ['1/4 in', '3/8 in', '1/2 in', '5/8 in', '3/4 in', '1 in', '1-1/4 in', '1-1/2 in', '2 in', '2-1/2 in', '3 in', '4 in'];
    const out: string[] = [];
    for (const [i, a] of sizes.entries()) {
      for (const b of sizes.slice(i + 1)) {
        for (const p of PARTS) {
          if (mockup.has(p.code) || p.name.includes(' x ') || !p.name.endsWith(` ${a}`)) continue;
          const noun = p.name.slice(0, -a.length - 1);
          const big = PARTS.find((q) => q.name === `${noun} ${b}`);
          if (big && big.cents < p.cents) out.push(`${noun}: ${a} ${p.cents} > ${b} ${big.cents}`);
        }
      }
    }
    expect(out).toEqual([]);
  });
});
