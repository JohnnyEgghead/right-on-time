// SPDX-License-Identifier: AGPL-3.0-or-later
// The reference rows of the seed (SPECIFICATIONS section 3 and SD-20; BUILD_PLAN P2-SEED), as data. Nothing here
// references a customer. The 21 technicians come from packages/generator/technicians.json (the roster the generator
// writes visits and fixture jobs for), so the names, employee numbers and branches have 1 source.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const BRANCHES = [
  { id: 'columbus', zone: 'America/New_York', phone: '(614) 555-0100', area: '614', lon: -82.9988, lat: 39.9612 },
  { id: 'dayton', zone: 'America/New_York', phone: '(937) 555-0101', area: '937', lon: -84.1916, lat: 39.7589 },
  { id: 'springfield', zone: 'America/New_York', phone: '(937) 555-0102', area: '937', lon: -83.8088, lat: 39.9242 },
] as const;
export type BranchId = (typeof BRANCHES)[number]['id'];

export type Skill = 'heating_cooling' | 'plumbing' | 'install';

interface ServiceRow {
  id: string;
  online: boolean;
  /** SD-20 "Invoice price", in cents; 0 where no dollar amount is shown (OI-24). */
  cents: number;
  jobType: 'maintenance' | 'repair' | 'install';
  minutes: number;
  skill: Skill;
}

/** SD-20's 9 services in its order; the ids are the generator README's service ids. The first 6 are bookable online (FR-BOOK-14). */
export const SERVICES: readonly ServiceRow[] = [
  { id: 'furnace_tune_up', online: true, cents: 8900, jobType: 'maintenance', minutes: 60, skill: 'heating_cooling' },
  { id: 'ac_tune_up', online: true, cents: 8900, jobType: 'maintenance', minutes: 60, skill: 'heating_cooling' },
  { id: 'heating_or_ac_fix', online: true, cents: 7900, jobType: 'repair', minutes: 90, skill: 'heating_cooling' },
  { id: 'plumbing_repair', online: true, cents: 7900, jobType: 'repair', minutes: 90, skill: 'plumbing' },
  { id: 'water_heater', online: true, cents: 0, jobType: 'repair', minutes: 120, skill: 'plumbing' },
  { id: 'thermostat', online: true, cents: 0, jobType: 'install', minutes: 60, skill: 'heating_cooling' },
  { id: 'boiler_repair', online: false, cents: 0, jobType: 'repair', minutes: 120, skill: 'heating_cooling' },
  { id: 'tankless_heater_flush', online: false, cents: 0, jobType: 'maintenance', minutes: 60, skill: 'plumbing' },
  { id: 'sump_pump_install', online: false, cents: 0, jobType: 'install', minutes: 180, skill: 'install' },
];

/** The 10 mockup parts (OA-54; FR-BILL-3): code, name, list price in cents. The first 7 are the mockups' parts and prices; these 10 never change. */
export const MOCKUP_PARTS: readonly { code: string; name: string; cents: number }[] = [

  { code: 'FLT-16254', name: 'Furnace filter 16x25x4 MERV 11', cents: 2400 },
  { code: 'FLT-16251', name: 'Furnace filter 16x25x1 MERV 8', cents: 950 },
  { code: 'FLT-20254', name: 'Furnace filter 20x25x4 MERV 11', cents: 2700 },
  { code: 'FLT-20201', name: 'Furnace filter 20x20x1 MERV 8', cents: 900 },
  { code: 'RCK-1625', name: 'Filter rack, 16x25, 4 in', cents: 4600 },
  { code: 'WF-1010', name: 'Water filter cartridge, whole house', cents: 3200 },
  { code: 'CAP-455', name: 'Run capacitor 45/5 MFD', cents: 3800 },
  { code: 'CAP-355', name: 'Run capacitor 35/5 MFD', cents: 3400 },
  { code: 'HOS-0750', name: 'Condensate hose, 3/4 in, per ft', cents: 225 },
  { code: 'CLP-0750', name: 'Hose clamp, 3/4 in', cents: 150 },
];

/**
 * The generated parts catalog (owner ruling 712dd919, Nov 2, 2026: "Grow to about 1,240"; F-339, F-252 item 4; F-428).
 * No document gives the names, prices, count or spread; this is the generator rule, disclosed here (F-252 class):
 *   - Count: PARTS_COUNT = 1,240 = the 10 mockup parts + 1,230 generated parts.
 *   - Seed: PARTS_SEED = 'brightwater-parts-v2'. FNV-1a of it seeds a mulberry32 stream; the stream is read once per
 *     generated part, in order, for its price. Same seed, same rows, on every run.
 *   - Shape: 10 families, 123 parts each. A family lists its nouns, and each noun lists only the specs that fit it (a
 *     heating element has watts and volts, a capacitor has microfarads and volts, a fitting has pipe sizes). The family's
 *     rows go round by round: round r takes spec r of every noun that has one, in the noun order, until 123 rows. Part i
 *     (0-based) is family i % 10, ordinal c = floor(i / 10), the family's row c; its name is the noun, a space and the
 *     spec, so no name repeats; its code is the family prefix, a hyphen and the number 2000 + c (4 digits, so never a
 *     mockup code).
 *   - Price: the noun's own range in cents (a sight glass costs tens of dollars, a compressor hundreds), rising with the
 *     spec (F-440): a noun's specs are listed smallest first, and spec r of n is priced at min + (r + 0.1 + 0.8u) / n of
 *     the range, u the stream's number, rounded to 5 cents. So a 3 in ball valve never costs less than a 5/8 in one.
 *   - Fit to the job: each family lists the services it fits (FAMILIES, services), and a noun whose equipment fits fewer
 *     of them lists its own (Noun, services; F-440: a contactor is an outdoor AC part, an aquastat a boiler part, a hose
 *     bibb a plumbing part). A seeded line draws only from the nouns that fit its job's service, and a mockup part only
 *     where MOCKUP_FITS lists that service; see partCodeForLine.
 */
export const PARTS_COUNT = 1240;
export const PARTS_SEED = 'brightwater-parts-v2';
const GENERATED_COUNT = PARTS_COUNT - MOCKUP_PARTS.length;
const FAMILY_SIZE = GENERATED_COUNT / 10;

const SIZES = ['1/4 in', '3/8 in', '1/2 in', '5/8 in', '3/4 in', '1 in', '1-1/4 in', '1-1/2 in', '2 in', '2-1/2 in', '3 in', '4 in'];
const sz = (from: number, to: number): string[] => SIZES.slice(from, to);
const cross = (a: readonly string[], b: readonly string[], join = ', '): string[] => a.flatMap((x) => b.map((y) => `${x}${join}${y}`));
const TONS = ['1.5 ton', '2 ton', '2.5 ton', '3 ton', '3.5 ton', '4 ton', '5 ton'];
const ALL = ['furnace_tune_up', 'ac_tune_up', 'heating_or_ac_fix', 'plumbing_repair', 'water_heater', 'thermostat', 'boiler_repair', 'tankless_heater_flush', 'sump_pump_install'];
const PLUMB = ['plumbing_repair', 'water_heater', 'tankless_heater_flush', 'sump_pump_install', 'boiler_repair'];
const HVAC = ['furnace_tune_up', 'ac_tune_up', 'heating_or_ac_fix'];
/** F-440: the outdoor AC unit's parts (condenser, compressor side): an AC tune-up or a heating or AC fix. */
const OUTDOOR_AC = ['ac_tune_up', 'heating_or_ac_fix'];
/** F-440: the gas-fired appliance's ignition and safety parts: a furnace tune-up, a heating or AC fix, a boiler repair. */
const GAS_FIRED = ['furnace_tune_up', 'heating_or_ac_fix', 'boiler_repair'];
/** F-440: the air handler's blower parts: the 3 air-side services. */
const AIR_SIDE = HVAC;
/** F-440: the pipe-joining supplies every job but a thermostat install takes. */
const NOT_THERMOSTAT = ALL.filter((s) => s !== 'thermostat');

/** A noun of a family. services, when given, narrows the family's services to the ones this noun's equipment fits, or per spec where the spec names the equipment (a boiler control board) (F-440). */
interface Noun { noun: string; specs: readonly string[]; min: number; max: number; services?: readonly string[] | ((spec: string) => readonly string[]) }
interface Family { prefix: string; services: readonly string[]; nouns: readonly Noun[] }

const FAMILIES: readonly Family[] = [
  { prefix: 'VLV', services: PLUMB, nouns: [
    { noun: 'Ball valve', specs: sz(0, 12), min: 500, max: 8500 }, { noun: 'Gate valve', specs: sz(0, 12), min: 900, max: 9500 },
    { noun: 'Check valve', specs: sz(0, 12), min: 700, max: 7000 }, { noun: 'Angle stop', specs: cross(['3/8 in', '1/2 in'], ['compression', 'sweat', 'IPS'], ' '), services: ['plumbing_repair'], min: 600, max: 2200 },
    { noun: 'Shutoff valve', specs: sz(0, 12), min: 800, max: 6500 }, { noun: 'Pressure relief valve', specs: sz(1, 8), services: ['plumbing_repair', 'water_heater', 'boiler_repair'], min: 1800, max: 6000 },
    { noun: 'Globe valve', specs: sz(1, 11), min: 1500, max: 9000 }, { noun: 'Zone valve', specs: sz(3, 9), services: ['boiler_repair'], min: 7500, max: 16500 },
    { noun: 'Boiler drain valve', specs: sz(2, 5), services: ['plumbing_repair', 'water_heater', 'boiler_repair'], min: 600, max: 1500 }, { noun: 'Press-fit ball valve', specs: sz(2, 11), min: 1500, max: 9500 },
    { noun: 'Backflow preventer', specs: sz(3, 10), services: ['plumbing_repair', 'boiler_repair'], min: 4500, max: 26000 }, { noun: 'Pressure reducing valve', specs: sz(3, 8), services: ['plumbing_repair', 'boiler_repair'], min: 5500, max: 14500 },
    { noun: 'Mixing valve', specs: sz(3, 8), services: ['plumbing_repair', 'water_heater', 'boiler_repair'], min: 4500, max: 15500 }, { noun: 'Butterfly valve', specs: ['2 in', '2-1/2 in', '3 in', '4 in'], services: ['plumbing_repair', 'boiler_repair'], min: 6500, max: 18500 },
    { noun: 'Hose bibb', specs: ['1/2 in', '3/4 in', '1/2 in frost-free', '3/4 in frost-free'], services: ['plumbing_repair'], min: 900, max: 4500 },
    { noun: 'Quarter-turn stop', specs: sz(0, 6), services: ['plumbing_repair'], min: 500, max: 2600 }, { noun: 'Sillcock', specs: ['1/2 in', '3/4 in', '1/2 in anti-siphon', '3/4 in anti-siphon'], services: ['plumbing_repair'], min: 1400, max: 5200 },
  ] },
  { prefix: 'FIT', services: PLUMB, nouns: [
    { noun: 'Coupling', specs: sz(0, 12), min: 150, max: 1800 }, { noun: 'Elbow, 90 degree', specs: sz(0, 12), min: 150, max: 2400 },
    { noun: 'Elbow, 45 degree', specs: sz(0, 12), min: 150, max: 2600 }, { noun: 'Tee', specs: sz(0, 12), min: 200, max: 3200 },
    { noun: 'Union', specs: sz(2, 11), min: 600, max: 3800 }, { noun: 'Male adapter', specs: sz(0, 12), min: 200, max: 1900 },
    { noun: 'Female adapter', specs: sz(0, 12), min: 200, max: 1900 }, { noun: 'End cap', specs: sz(0, 12), min: 100, max: 1400 },
    { noun: 'Reducer', specs: ['3/4 in x 1/2 in', '1 in x 3/4 in', '1 in x 1/2 in', '1-1/4 in x 1 in', '1-1/2 in x 1-1/4 in', '2 in x 1-1/2 in', '2 in x 1 in', '3 in x 2 in', '4 in x 3 in', '1/2 in x 3/8 in'], min: 250, max: 3100 },
    { noun: 'Dielectric union', specs: sz(2, 9), min: 1200, max: 4800 }, { noun: 'Street elbow', specs: sz(1, 10), min: 200, max: 2300 },
    { noun: 'Bushing', specs: sz(2, 11), min: 150, max: 1300 }, { noun: 'Plug', specs: sz(0, 10), min: 100, max: 900 },
  ] },
  { prefix: 'PIP', services: PLUMB, nouns: [
    { noun: 'Copper pipe, type L, 10 ft', specs: sz(2, 11), min: 1800, max: 16500 }, { noun: 'PEX tubing, 100 ft coil', specs: sz(2, 9), min: 3500, max: 22000 },
    { noun: 'CPVC pipe, 10 ft', specs: sz(2, 10), min: 800, max: 6800 }, { noun: 'PVC pipe, schedule 40, 10 ft', specs: sz(2, 12), min: 600, max: 7800 },
    { noun: 'Black iron nipple, 6 in', specs: sz(2, 10), min: 500, max: 3200 }, { noun: 'Flex connector', specs: cross(['1/2 in', '3/4 in'], ['12 in', '18 in', '24 in', '30 in', '36 in', '48 in'], ' x '), min: 900, max: 3800 },
    { noun: 'Braided supply line', specs: cross(['3/8 in', '1/2 in'], ['9 in', '12 in', '16 in', '20 in', '24 in', '30 in', '36 in'], ' x '), services: ['plumbing_repair', 'water_heater', 'tankless_heater_flush'], min: 600, max: 2200 },
    { noun: 'Drain pipe, ABS, 10 ft', specs: sz(6, 12), services: ['plumbing_repair', 'water_heater', 'sump_pump_install'], min: 1500, max: 6500 }, { noun: 'Sump discharge pipe, 10 ft', specs: sz(6, 11), services: ['sump_pump_install'], min: 1200, max: 4800 },
    { noun: 'Soft copper tubing, 50 ft coil', specs: sz(0, 6), min: 4500, max: 21000 }, { noun: 'Gas flex line', specs: cross(['1/2 in', '3/4 in'], ['12 in', '18 in', '24 in', '36 in', '48 in'], ' x '), services: ['plumbing_repair', 'water_heater', 'boiler_repair'], min: 1800, max: 4500 },
    { noun: 'Pipe hanger, split ring', specs: sz(2, 11), min: 150, max: 700 },
    { noun: 'Copper pipe, type M, 10 ft', specs: sz(2, 11), min: 1400, max: 13500 }, { noun: 'PEX-AL-PEX tubing, 100 ft coil', specs: sz(2, 8), min: 6500, max: 38000 },
    { noun: 'Galvanized nipple, 6 in', specs: sz(2, 10), min: 500, max: 3000 },
  ] },
  { prefix: 'ELC', services: ['furnace_tune_up', 'ac_tune_up', 'heating_or_ac_fix', 'thermostat', 'boiler_repair', 'sump_pump_install'], nouns: [
    { noun: 'Contactor', specs: cross(['20 amp', '30 amp', '40 amp', '60 amp'], ['24 V coil', '120 V coil', '240 V coil']), services: OUTDOOR_AC, min: 1800, max: 6500 },
    { noun: 'Relay', specs: cross(['SPDT', 'DPDT'], ['24 V', '120 V', '240 V'], ' '), min: 800, max: 4200 },
    { noun: 'Fuse', specs: ['3 amp', '5 amp', '10 amp', '15 amp', '20 amp', '25 amp', '30 amp', '40 amp', '50 amp', '60 amp'], min: 400, max: 1800 },
    { noun: 'Circuit breaker', specs: cross(['15 amp', '20 amp', '30 amp', '40 amp', '50 amp', '60 amp'], ['1 pole', '2 pole']), min: 900, max: 5200 },
    { noun: 'Transformer', specs: ['20 VA, 120/24 V', '40 VA, 120/24 V', '50 VA, 120/24 V', '75 VA, 120/24 V', '40 VA, 240/24 V', '50 VA, 240/24 V', '75 VA, 240/24 V', '100 VA, 240/24 V'], min: 1800, max: 4800 },
    { noun: 'Disconnect switch', specs: cross(['30 amp', '60 amp', '100 amp'], ['fused', 'non-fused']), services: OUTDOOR_AC, min: 1500, max: 7500 },
    { noun: 'Thermal cutout', specs: ['120 F', '140 F', '160 F', '180 F', '200 F', '250 F', '300 F', '350 F'], min: 600, max: 2200 },
    { noun: 'Wire nut kit', specs: ['25 pack', '50 pack', '100 pack', '200 pack'], min: 500, max: 1900 },
    { noun: 'Terminal block', specs: ['2 position', '3 position', '4 position', '6 position', '8 position', '10 position'], min: 300, max: 1800 },
    { noun: 'Dual run capacitor', specs: cross(['35/5 MFD', '40/5 MFD', '45/5 MFD', '50/5 MFD', '55/5 MFD', '60/5 MFD', '70/5 MFD'], ['370 V', '440 V']), services: OUTDOOR_AC, min: 1900, max: 5200 },
    { noun: 'Start capacitor', specs: ['88-106 MFD', '124-149 MFD', '161-193 MFD', '189-227 MFD', '233-280 MFD', '270-324 MFD'], services: OUTDOOR_AC, min: 1600, max: 4200 },
    { noun: 'Wire harness', specs: ['4 wire', '6 wire', '8 wire', '10 wire', '12 wire', '16 wire'], min: 1500, max: 9500 },
    { noun: 'Thermostat wire, 18 gauge', specs: ['2 conductor', '3 conductor', '4 conductor', '5 conductor', '7 conductor', '8 conductor'], services: ['furnace_tune_up', 'ac_tune_up', 'heating_or_ac_fix', 'thermostat', 'boiler_repair'], min: 1800, max: 8500 },
    { noun: 'Time delay relay', specs: ['1 sec', '5 sec', '10 sec', '30 sec', '60 sec', '5 min'], min: 2200, max: 6800 }, { noun: 'Fused pullout', specs: ['30 amp', '60 amp', '100 amp'], services: OUTDOOR_AC, min: 600, max: 1800 },
    { noun: 'Flexible conduit whip', specs: ['3/8 in x 4 ft', '1/2 in x 4 ft', '1/2 in x 6 ft', '3/4 in x 6 ft', '3/4 in x 10 ft', '1 in x 10 ft'], services: OUTDOOR_AC, min: 1200, max: 4800 },
    { noun: 'Line cord', specs: ['14/3 x 6 ft', '14/3 x 10 ft', '12/3 x 6 ft', '12/3 x 10 ft'], min: 1200, max: 3200 }, { noun: 'Receptacle', specs: ['15 amp', '20 amp', '15 amp GFCI', '20 amp GFCI'], min: 300, max: 2800 },
  ] },
  { prefix: 'MTR', services: ['furnace_tune_up', 'ac_tune_up', 'heating_or_ac_fix', 'boiler_repair'], nouns: [
    { noun: 'Blower motor', specs: cross(['1/6 HP', '1/4 HP', '1/3 HP', '1/2 HP', '3/4 HP', '1 HP'], ['115 V', '208-230 V']), services: AIR_SIDE, min: 12000, max: 38000 },
    { noun: 'Inducer motor', specs: cross(['1/30 HP', '1/20 HP', '1/15 HP', '1/12 HP'], ['115 V', '208-230 V']), services: GAS_FIRED, min: 8500, max: 21000 },
    { noun: 'Condenser fan motor', specs: cross(['1/10 HP', '1/6 HP', '1/4 HP', '1/3 HP', '1/2 HP'], ['208-230 V', '460 V']), services: OUTDOOR_AC, min: 9500, max: 27000 },
    { noun: 'Blower wheel', specs: ['9 x 6 in', '10 x 6 in', '10 x 8 in', '11 x 7 in', '11 x 10 in', '12 x 7 in', '12 x 9 in', '12 x 11 in', '15 x 11 in'], services: AIR_SIDE, min: 3800, max: 9500 },
    { noun: 'Condenser fan blade', specs: cross(['18 in', '20 in', '22 in', '24 in', '26 in', '28 in', '30 in'], ['clockwise', 'counterclockwise']), services: OUTDOOR_AC, min: 2200, max: 7500 },
    { noun: 'Motor mount', specs: ['48 frame', '56 frame', '42 frame', '48 frame, resilient', '56 frame, resilient', '48 frame, band'], services: AIR_SIDE, min: 1200, max: 4200 },
    { noun: 'Drive belt', specs: ['A28', 'A30', 'A32', 'A34', 'A36', 'A38', 'A40', 'A42', 'A44', 'A46', 'A48', 'A50'], services: AIR_SIDE, min: 900, max: 2800 },
    { noun: 'Blower bearing', specs: ['3/8 in bore', '1/2 in bore', '5/8 in bore', '3/4 in bore', '7/8 in bore', '1 in bore'], services: AIR_SIDE, min: 1000, max: 3200 },
    { noun: 'Blower pulley', specs: cross(['3 in', '4 in', '5 in', '6 in', '7 in'], ['1/2 in bore', '5/8 in bore'], ', '), services: AIR_SIDE, min: 1400, max: 4500 },
    { noun: 'Circulator pump', specs: cross(['1/12 HP', '1/6 HP', '1/4 HP', '1/3 HP'], ['cast iron', 'bronze'], ', '), services: ['boiler_repair'], min: 14000, max: 52000 },
    { noun: 'Motor run capacitor bracket', specs: ['small', 'medium', 'large', 'dual small', 'dual medium', 'dual large'], services: OUTDOOR_AC, min: 500, max: 1800 },
    { noun: 'Draft inducer assembly', specs: ['up to 60 kBtu', '60-80 kBtu', '80-100 kBtu', '100-120 kBtu', 'over 120 kBtu'], services: GAS_FIRED, min: 18000, max: 46000 },
    { noun: 'Fan guard', specs: ['18 in', '20 in', '22 in', '24 in', '26 in', '28 in', '30 in', '32 in'], services: OUTDOOR_AC, min: 1500, max: 5500 },
    { noun: 'Hard start kit', specs: ['1/6 HP', '1/4 HP', '1/3 HP', '1/2 HP', '3/4 HP', '1 HP'], services: OUTDOOR_AC, min: 2500, max: 6500 }, { noun: 'Condenser fan motor bracket', specs: ['small', 'medium', 'large', 'universal'], services: OUTDOOR_AC, min: 1200, max: 3800 },
  ] },
  { prefix: 'FLT', services: HVAC, nouns: [
    { noun: 'Pleated filter', specs: cross(['10x20x1', '12x24x1', '14x20x1', '16x20x1', '16x25x1', '20x20x1', '20x25x1', '24x24x1'], ['MERV 8', 'MERV 11', 'MERV 13'], ' '), min: 500, max: 2400 },
    { noun: 'Media filter', specs: cross(['16x25x4', '20x25x4', '16x20x5', '20x25x5', '20x20x4', '25x25x5'], ['MERV 11', 'MERV 13'], ' '), min: 2200, max: 5200 },
    { noun: 'Washable filter', specs: ['10x20x1', '12x24x1', '14x20x1', '16x20x1', '16x25x1', '20x20x1', '20x25x1', '24x24x1', '25x25x1'], min: 1500, max: 3800 },
    { noun: 'Filter grille', specs: ['14x20', '16x20', '16x25', '20x20', '20x25', '20x30', '24x24', '25x25', '30x30'], min: 1800, max: 4800 },
    { noun: 'Filter cabinet', specs: ['16x25x4', '20x25x4', '16x25x5', '20x25x5', '25x25x5'], min: 3200, max: 5200 },
    { noun: 'Humidifier pad', specs: ['model 35', 'model 45', 'model 600', 'model 700', 'model 10', 'model 12', 'model 14'], min: 1100, max: 2600 },
    { noun: 'Air cleaner cell', specs: ['16x25', '20x25', '20x20', '14x25', '16x20', '24x24'], min: 2400, max: 5200 },
    { noun: 'UV bulb', specs: ['9 in', '12 in', '14 in', '16 in', '18 in', '21 in'], min: 3200, max: 5100 },
    { noun: 'Return air grille', specs: ['14x20', '16x20', '16x25', '20x20', '20x25', '20x30', '24x24', '25x25', '30x30'], min: 1200, max: 4900 },
    { noun: 'Filter rack kit', specs: ['16x20', '16x25', '20x20', '20x25', '25x25', '20x30'], min: 3200, max: 5000 },
    { noun: 'Filter media roll', specs: ['14 in', '16 in', '20 in', '24 in', '25 in', '30 in'], min: 2000, max: 4800 },
    { noun: 'HEPA filter', specs: ['16x25x5', '20x25x5', '16x25x4', '20x25x4', '20x20x4', '25x25x5'], min: 4800, max: 5200 }, { noun: 'Carbon filter', specs: ['16x25x1', '20x25x1', '16x20x1', '20x20x1', '24x24x1', '25x25x1'], min: 1400, max: 3800 },
    { noun: 'Electrostatic filter', specs: ['10x20x1', '12x24x1', '14x20x1', '16x20x1', '16x25x1', '20x20x1', '20x25x1', '24x24x1'], min: 2800, max: 5000 },
    { noun: 'Filter gasket tape', specs: ['small', 'medium', 'large', 'extra large', '2 pack', '4 pack'], min: 800, max: 2800 },
  ] },
  { prefix: 'WTR', services: ['water_heater', 'tankless_heater_flush', 'plumbing_repair'], nouns: [
    { noun: 'Anode rod', specs: cross(['magnesium', 'aluminum', 'powered'], ['3/4 in x 34 in', '3/4 in x 42 in', '3/4 in x 44 in'], ', '), services: ['water_heater'], min: 2200, max: 9500 },
    { noun: 'Heating element', specs: cross(['screw-in', 'flange'], ['1500 W, 120 V', '3800 W, 240 V', '4500 W, 240 V', '5500 W, 240 V', '3000 W, 240 V']), services: ['water_heater'], min: 1400, max: 4200 },
    { noun: 'Water heater thermostat', specs: cross(['upper', 'lower', 'combination'], ['120 V', '240 V', 'non-resettable', 'resettable']), services: ['water_heater'], min: 1500, max: 4800 },
    { noun: 'T&P relief valve', specs: cross(['3/4 in', '1/2 in'], ['100 psi', '125 psi', '150 psi', '210 psi'], ', '), services: ['water_heater', 'plumbing_repair'], min: 1200, max: 3600 },
    { noun: 'Dip tube', specs: ['30 gal', '40 gal', '50 gal', '75 gal', '80 gal', '30 gal, 1/2 in', '50 gal, 1/2 in', '80 gal, 1/2 in'], services: ['water_heater'], min: 600, max: 1800 },
    { noun: 'Water heater drain valve', specs: ['1/2 in brass', '3/4 in brass', '3/4 in plastic', '1 in brass', '3/4 in full-port', '1 in full-port'], services: ['water_heater'], min: 800, max: 2400 },
    { noun: 'Expansion tank', specs: ['2 gal', '2.1 gal', '2.6 gal', '4.5 gal', '5 gal', '8 gal', '10 gal', '14 gal'], services: ['water_heater', 'plumbing_repair'], min: 3800, max: 17500 },
    { noun: 'Water heater burner assembly', specs: cross(['30 gal', '40 gal', '50 gal', '75 gal'], ['natural gas', 'propane']), services: ['water_heater'], min: 7500, max: 21000 },
    { noun: 'Gas control valve', specs: cross(['natural gas', 'propane'], ['standard', 'top-mount', 'side-mount', 'with pilot']), services: ['water_heater'], min: 9500, max: 24000 },
    { noun: 'Tankless isolation valve kit', specs: ['3/4 in', '1 in', '3/4 in with pressure relief', '1 in with pressure relief', '3/4 in press', '3/4 in sweat'], services: ['tankless_heater_flush'], min: 4200, max: 12500 },
    { noun: 'Tankless descaler', specs: ['1 gal', '2.5 gal', '5 gal', '1 gal pump kit', '2.5 gal pump kit'], services: ['tankless_heater_flush'], min: 2200, max: 9500 },
    { noun: 'Flush pump', specs: ['1/6 HP', '1/4 HP', '1/3 HP', '1/2 HP', '3/4 HP'], services: ['tankless_heater_flush'], min: 8500, max: 21000 },
    { noun: 'Water heater pilot assembly', specs: cross(['natural gas', 'propane'], ['thermocouple style', 'thermopile style', 'piezo igniter']), services: ['water_heater'], min: 2800, max: 7500 },
    { noun: 'Water heater flue damper', specs: ['3 in', '4 in', '5 in', '6 in'], services: ['water_heater'], min: 3200, max: 8800 },
    { noun: 'Water heater pan', specs: ['20 in', '22 in', '24 in', '26 in', '28 in', '30 in', '32 in'], services: ['water_heater'], min: 1500, max: 4800 },
    { noun: 'Water heater blanket', specs: ['30 gal', '40 gal', '50 gal', '75 gal'], services: ['water_heater'], min: 1800, max: 4500 }, { noun: 'Water heater strap kit', specs: ['30 gal', '40-50 gal', '75-80 gal'], services: ['water_heater'], min: 1800, max: 4200 },
    { noun: 'Water heater supply connector', specs: ['3/4 in x 12 in', '3/4 in x 18 in', '3/4 in x 24 in'], services: ['water_heater', 'tankless_heater_flush'], min: 1400, max: 3200 }, { noun: 'Pilot orifice', specs: ['natural gas, 0.020', 'natural gas, 0.027', 'propane, 0.014', 'propane, 0.018'], services: ['water_heater'], min: 600, max: 1800 },
  ] },
  { prefix: 'CTL', services: ['furnace_tune_up', 'ac_tune_up', 'heating_or_ac_fix', 'thermostat', 'boiler_repair'], nouns: [
    { noun: 'Thermostat', specs: ['non-programmable', 'programmable 7-day', 'programmable 5-2', 'Wi-Fi smart', 'heat pump 2H/1C', 'heat pump 3H/2C', 'line voltage', 'millivolt', 'zoning'], min: 2400, max: 28000 },
    { noun: 'Hot surface igniter', specs: ['silicon carbide', 'silicon nitride', 'universal', 'with 6 in leads', 'with 12 in leads', 'with 18 in leads', 'with 24 in leads'], services: GAS_FIRED, min: 2200, max: 6500 },
    { noun: 'Flame sensor', specs: ['6 in', '8 in', '10 in', '12 in', 'universal', 'universal, long', 'with bracket'], services: GAS_FIRED, min: 1200, max: 3800 },
    { noun: 'Control board', specs: cross(['single-stage', 'two-stage', 'variable-speed', 'universal'], ['furnace', 'air handler', 'boiler'], ', '), services: (spec) => (spec.endsWith(', boiler') ? ['boiler_repair'] : AIR_SIDE), min: 9500, max: 52000 },
    { noun: 'Pressure switch', specs: cross(['0.35 in WC', '0.50 in WC', '0.65 in WC', '0.80 in WC', '1.10 in WC'], ['single port', 'dual port'], ', '), services: GAS_FIRED, min: 2400, max: 8200 },
    { noun: 'Limit switch', specs: ['L130', 'L140', 'L150', 'L160', 'L170', 'L180', 'L190', 'L200', 'L210', 'L220'], services: GAS_FIRED, min: 1500, max: 5200 },
    { noun: 'Gas valve', specs: cross(['natural gas', 'propane'], ['single-stage', 'two-stage', 'modulating', 'with regulator']), services: GAS_FIRED, min: 11500, max: 36000 },
    { noun: 'Thermocouple', specs: ['18 in', '24 in', '30 in', '36 in', '48 in'], services: GAS_FIRED, min: 800, max: 2200 },
    { noun: 'Temperature sensor', specs: ['10K ohm', '12K ohm', '20K ohm', '10K ohm, outdoor', '10K ohm, supply air', '10K ohm, return air', '10K ohm, strap-on'], min: 1400, max: 4800 },
    { noun: 'Boiler aquastat', specs: ['immersion', 'strap-on', 'high limit', 'low limit', 'dual', 'with relay'], services: ['boiler_repair'], min: 5200, max: 16500 },
    { noun: 'Defrost control', specs: ['standard', 'universal', 'time and temperature', 'demand'], services: OUTDOOR_AC, min: 5800, max: 14500 },
    { noun: 'Fan control', specs: ['1 speed', '2 speed', '3 speed', '4 speed', 'variable', 'adjustable'], services: AIR_SIDE, min: 1800, max: 7500 },
    { noun: 'Zone control panel', specs: ['2 zone', '3 zone', '4 zone', '5 zone', '6 zone', '8 zone'], min: 9500, max: 38000 },
    { noun: 'Low water cutoff', specs: ['probe type', 'float type', 'electronic', 'with test button', '120 V', '24 V'], services: ['boiler_repair'], min: 8500, max: 34000 },
    { noun: 'Humidity sensor', specs: ['wall', 'duct', 'outdoor', 'wall, with display'], min: 3800, max: 14500 }, { noun: 'Spark ignitor', specs: ['natural gas', 'propane', 'universal', 'with 12 in lead', 'with 24 in lead'], services: GAS_FIRED, min: 1200, max: 4200 },
    { noun: 'Flame rollout switch', specs: ['150 F', '170 F', '190 F', '210 F', '230 F', '250 F', '270 F'], services: GAS_FIRED, min: 1000, max: 2800 }, { noun: 'Remote sensor', specs: ['indoor', 'outdoor', 'wired', 'wireless'], min: 3200, max: 9500 },
    { noun: 'Control knob', specs: ['gas valve', 'thermostat', 'limit', 'fan'], services: GAS_FIRED, min: 300, max: 1500 },
  ] },
  { prefix: 'REF', services: ['ac_tune_up', 'heating_or_ac_fix'], nouns: [
    { noun: 'Compressor', specs: cross(TONS, ['R-410A', 'R-454B'], ', '), min: 38000, max: 98000 },
    { noun: 'Filter drier', specs: cross(['1/4 in', '3/8 in', '1/2 in', '5/8 in', '3/4 in'], ['liquid line', 'suction line'], ', '), min: 2200, max: 7500 },
    { noun: 'Expansion valve', specs: cross(TONS, ['R-410A', 'R-454B'], ', '), min: 4800, max: 17500 },
    { noun: 'Evaporator coil', specs: cross(TONS, ['A-coil', 'slab'], ', '), min: 28000, max: 78000 },
    { noun: 'Condenser coil', specs: cross(TONS, ['aluminum', 'copper'], ', '), min: 32000, max: 88000 },
    { noun: 'Line set', specs: cross(['3/8 x 3/4 in', '3/8 x 7/8 in', '1/4 x 3/8 in', '1/4 x 1/2 in'], ['15 ft', '25 ft', '35 ft', '50 ft'], ', '), min: 8500, max: 32000 },
    { noun: 'Refrigerant service valve', specs: cross(['1/4 in', '3/8 in', '1/2 in', '5/8 in', '3/4 in'], ['liquid', 'suction'], ', '), min: 1800, max: 7500 },
    { noun: 'Sight glass', specs: ['1/4 in', '3/8 in', '1/2 in', '5/8 in', '3/4 in', '7/8 in'], min: 1500, max: 5500 },
    { noun: 'Refrigerant cylinder', specs: cross(['R-410A', 'R-454B', 'R-32', 'R-22', 'R-407C', 'R-404A', 'R-134a'], ['11 lb', '25 lb'], ', '), min: 9500, max: 48000 },
    { noun: 'Reversing valve', specs: cross(TONS, ['R-410A', 'R-454B'], ', '), min: 14500, max: 36000 },
    { noun: 'Access valve core', specs: ['1/4 in', '5/16 in', '3/8 in', '1/4 in, 10 pack', '5/16 in, 10 pack', '3/8 in, 10 pack'], min: 200, max: 2200 },
    { noun: 'Suction line accumulator', specs: TONS, min: 6500, max: 14500 },
    { noun: 'Gauge manifold hose', specs: ['36 in', '48 in', '60 in', '72 in', '84 in', '96 in'], min: 600, max: 2400 },
  ] },
  { prefix: 'MSC', services: ALL, nouns: [
    { noun: 'Cable tie', specs: cross(['4 in', '6 in', '8 in', '11 in', '14 in'], ['100 pack', '1000 pack']), min: 300, max: 2800 },
    { noun: 'Hanger strap', specs: ['3/4 in x 10 ft', '1 in x 10 ft', '1 in x 25 ft', '1-1/2 in x 10 ft', '1-1/2 in x 25 ft', '2 in x 10 ft', '2 in x 25 ft', '3/4 in x 100 ft'], services: NOT_THERMOSTAT, min: 600, max: 4500 },
    { noun: 'Pipe sealant', specs: cross(['2 oz', '4 oz', '8 oz', '16 oz'], ['white', 'gray', 'yellow']), services: NOT_THERMOSTAT, min: 450, max: 2400 },
    { noun: 'PTFE tape', specs: cross(['1/2 in', '3/4 in'], ['260 in', '520 in', '1000 in', 'gas rated', 'oil rated']), services: NOT_THERMOSTAT, min: 100, max: 700 },
    { noun: 'Pipe insulation, 6 ft', specs: cross(['3/8 in', '1/2 in', '3/4 in', '1 in', '1-1/4 in', '1-1/2 in'], ['1/2 in wall', '3/4 in wall']), services: NOT_THERMOSTAT, min: 250, max: 1500 },
    { noun: 'Solder', specs: ['1/2 lb lead-free', '1 lb lead-free', '1/2 lb silver', '1 lb silver', '1 lb 95-5', '4 oz lead-free', '4 oz silver'], services: NOT_THERMOSTAT, min: 700, max: 4500 },
    { noun: 'Soldering flux', specs: ['2 oz', '4 oz', '8 oz', '16 oz', '2 oz lead-free', '4 oz lead-free', '8 oz lead-free'], services: NOT_THERMOSTAT, min: 400, max: 1800 },
    { noun: 'Mounting screw kit', specs: ['#8 x 1/2 in', '#8 x 3/4 in', '#10 x 1 in', '#10 x 1-1/2 in', '#12 x 2 in', '1/4 in x 1 in', '1/4 in x 2 in', '5/16 in x 2 in'], min: 300, max: 1800 },
    { noun: 'Wire label set', specs: ['numbers 0-9', 'letters A-Z', 'blank 100 pack', 'color coded', 'thermostat set', 'breaker set'], min: 500, max: 1500 },
    { noun: 'Electrical tape', specs: cross(['3/4 in x 66 ft'], ['black', 'red', 'white', 'blue', 'green', 'yellow', 'gray', 'orange', 'brown']), min: 200, max: 700 },
    { noun: 'Shop towel pack', specs: ['10 pack', '25 pack', '50 pack', '100 pack', '200 pack', '10 pack heavy duty', '25 pack heavy duty'], min: 400, max: 2500 },
    { noun: 'Nitrile gloves', specs: ['small', 'medium', 'large', 'extra large'], min: 800, max: 1800 },
    { noun: 'Fastener assortment', specs: ['small', 'medium', 'large', 'sheet metal', 'machine screw', 'self-drilling'], min: 900, max: 3800 },
    { noun: 'Bucket of absorbent', specs: ['5 lb', '10 lb', '25 lb'], min: 700, max: 3000 },
    { noun: 'Drop cloth', specs: ['9 x 12 ft', '12 x 15 ft'], min: 700, max: 2200 }, { noun: 'Pipe wrap tape', specs: ['2 in', '3 in', '4 in', '2 in, 100 ft'], services: NOT_THERMOSTAT, min: 600, max: 2400 },
    { noun: 'Foam sealant', specs: ['12 oz', '16 oz', '24 oz', '12 oz fire rated'], min: 700, max: 2200 }, { noun: 'Silicone caulk', specs: ['clear', 'white', 'black', 'gray', '10 oz clear', '10 oz white'], min: 500, max: 1400 },
  ] },
];

/**
 * The mockup parts that fit each service (F-428). Prefix families that are not listed fit nothing, so a thermostat or
 * boiler job takes no mockup part: the filters, rack, capacitors and condensate hose are air-side furnace and AC parts,
 * the water filter is a plumbing part, and the hose clamp fits any job with a hose.
 */
const AIR = ['furnace_tune_up', 'ac_tune_up', 'heating_or_ac_fix'];
export const MOCKUP_FITS: Readonly<Record<string, readonly string[]>> = {
  'FLT-16254': AIR, 'FLT-16251': AIR, 'FLT-20254': AIR, 'FLT-20201': AIR, 'RCK-1625': AIR,
  'WF-1010': ['plumbing_repair'],
  'CAP-455': AIR, 'CAP-355': AIR,
  'HOS-0750': AIR,
  'CLP-0750': [...AIR, 'plumbing_repair', 'water_heater', 'tankless_heater_flush', 'sump_pump_install'],
};

/** FNV-1a (32 bit) of a string, the seed of the stream below. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** mulberry32: a small seeded stream of numbers in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A family's FAMILY_SIZE rows: round r takes spec r of every noun that has one, in noun order (F-428). */
function familyRows(f: Family): { noun: Noun; spec: string }[] {
  const rows: { noun: Noun; spec: string }[] = [];
  for (let r = 0; rows.length < FAMILY_SIZE; r++) {
    const before = rows.length;
    for (const noun of f.nouns) if (r < noun.specs.length) rows.push({ noun, spec: noun.specs[r] as string });
    if (rows.length === before) throw new Error(`parts family ${f.prefix} has fewer than ${FAMILY_SIZE} noun and spec rows`);
  }
  return rows.slice(0, FAMILY_SIZE);
}

/** The services a noun fits: its own list (a subset of its family's, checked here), else the family's (F-440). */
function nounServices(f: Family, noun: Noun, spec: string): readonly string[] {
  const own = typeof noun.services === 'function' ? noun.services(spec) : (noun.services ?? f.services);
  const stray = own.filter((s) => !f.services.includes(s));
  if (stray.length > 0) throw new Error(`parts noun ${noun.noun} fits ${stray.join(', ')}, outside family ${f.prefix}`);
  return own;
}

function generateParts(): { code: string; name: string; cents: number; services: readonly string[] }[] {
  const next = mulberry32(fnv1a(PARTS_SEED));
  const rows = FAMILIES.map(familyRows);
  return Array.from({ length: GENERATED_COUNT }, (_, i) => {
    const f = FAMILIES[i % FAMILIES.length] as Family;
    const c = Math.floor(i / FAMILIES.length);
    const { noun, spec } = (rows[i % FAMILIES.length] as { noun: Noun; spec: string }[])[c] as { noun: Noun; spec: string };
    // F-440: spec r of n sits in the r-th of n equal slices of the noun's range, at a stream-drawn point in the middle 80%
    // of the slice, so a later (bigger) spec never costs less than an earlier one.
    const n = noun.specs.length;
    const at = (noun.specs.indexOf(spec) + 0.1 + 0.8 * next()) / n;
    const cents = Math.round((noun.min + at * (noun.max - noun.min)) / 5) * 5;
    return { code: `${f.prefix}-${2000 + c}`, name: `${noun.noun} ${spec}`, cents, services: nounServices(f, noun, spec) };
  });
}

const GENERATED = generateParts();

/** The parts list the reference seed writes (OA-54; FR-BILL-3): the 10 mockup parts, then the generated catalog. */
export const PARTS: readonly { code: string; name: string; cents: number }[] = [...MOCKUP_PARTS, ...GENERATED.map(({ code, name, cents }) => ({ code, name, cents }))];

/** For each service, the generated parts (indexes into the generated catalog) whose noun fits it, and the mockup parts that fit it. */
const SERVICE_GENERATED = new Map<string, number[]>();
const SERVICE_MOCKUPS = new Map<string, string[]>();
for (const service of ALL) {
  SERVICE_GENERATED.set(service, GENERATED.flatMap((p, i) => (p.services.includes(service) ? [i] : [])));
  SERVICE_MOCKUPS.set(service, MOCKUP_PARTS.filter((p) => MOCKUP_FITS[p.code]?.includes(service)).map((p) => p.code));
}

/**
 * The spread rule (F-339, F-428): which part line k (0-based) of the seeded job jobNumber, a job of the given service,
 * names. With h = jobNumber * 7 + k * 13, a line whose h is a multiple of 4 (about 1 line in 4) is a mockup part that fits
 * the service, number (h / 4) mod the count of those (when the service has none, the line is a generated part like the
 * others); every other line is a generated part whose noun fits the service, number (h * 37) mod the count of
 * those parts, in catalog order. The world seed (packages/setup) applies it.
 */
export function partCodeForLine(jobNumber: number, k: number, service: string): string {
  const generated = SERVICE_GENERATED.get(service);
  const mockups = SERVICE_MOCKUPS.get(service);
  if (!generated || !mockups) throw new Error(`partCodeForLine: unknown service ${service}`);
  const h = jobNumber * 7 + k * 13;
  if (h % 4 === 0 && mockups.length > 0) return mockups[(h / 4) % mockups.length] as string;
  return (PARTS[MOCKUP_PARTS.length + (generated[(h * 37) % generated.length] as number)] as { code: string }).code;
}

/** The 5 two-hour windows of a branch (FR-BOOK-1) and the 4 overlapping four-hour windows (FR-BOOK-7), as local start and end hours. */
export const TWO_HOUR_WINDOWS: readonly (readonly [number, number])[] = [[8, 10], [10, 12], [12, 14], [14, 16], [16, 18]];
export const FOUR_HOUR_WINDOWS: readonly (readonly [number, number])[] = [[8, 12], [10, 14], [12, 16], [14, 18]];
/** Columbus's 2-hour window capacities in time order (FR-BOOK-6); the other branches get 5 per seeded technician (FR-BOOK-5). */
export const COLUMBUS_CAPACITIES: readonly number[] = [12, 12, 11, 11, 10];
export const TECHNICIAN_DAY_CAPACITY = 5;

/** The sample peak days (OA-29 row 18): Columbus is switched to four-hour windows on Wed, Sep 16 and Fri, Sep 18, 2026, by Dana R. on Mon, Sep 14, 4:10 PM (windows page, week board, CTL-OFC-34-09). */
export const PEAK_DAYS = { branch: 'columbus', dates: ['2026-09-16', '2026-09-18'], reason: 'Heat advisory', switchedAt: '2026-09-14T20:10:00Z' } as const;

/** The clock row setup writes (SD-12, D11): Tue, Sep 15, 2026, 7:00 AM America/New_York, paused, world epoch 1. */
export const CLOCK_START = '2026-09-15T07:00:00-04:00';

export interface StaffUser {
  name: string;
  email: string;
  role: 'manager' | 'office';
  branch: BranchId;
  title: string;
  language: 'en' | 'es';
  off?: boolean;
}

/** Staff from the approved users page (mockups/pages/admin-users.html) that exist on the booklet day. */
export const STAFF: readonly StaffUser[] = [
  { name: 'Dana Ruiz', email: 'dana.ruiz@brightwater.example', role: 'manager', branch: 'columbus', title: 'Director of Operations', language: 'en' },
  { name: 'Pat Kessler', email: 'pat.kessler@brightwater.example', role: 'manager', branch: 'dayton', title: 'Branch manager', language: 'en' },
  { name: 'Keisha Thompson', email: 'keisha.t@brightwater.example', role: 'office', branch: 'columbus', title: 'Dispatcher', language: 'en' },
  { name: 'Ana Gutierrez', email: 'ana.gutierrez@brightwater.example', role: 'office', branch: 'columbus', title: 'Customer service (Spanish)', language: 'es' },
  { name: 'Omar Haddad', email: 'omar.haddad@brightwater.example', role: 'office', branch: 'dayton', title: 'Customer service', language: 'en', off: true },
];

// F-252 item 7 (P2-AUTH): the reviewer is a technician-role user with no technician row, by design; HC-05's working account must therefore
// meet an empty day, not an error, on the technician app's day reads (an acceptance obligation of P5-TWA-TODAY and P6-NATIVE-TODAY).
export const REVIEWER = { name: 'App Reviewer', email: 'reviewer@brightwater.example', branch: 'columbus' } as const;

interface RosterEntry {
  employeeNumber: string;
  name: string;
  branch: BranchId;
  installer: boolean;
}

/** The generator's technician roster, read from its file (21 technicians, employee numbers from 40701; SD-29). */
export function readRoster(file = path.resolve(import.meta.dirname, '..', '..', '..', 'generator', 'technicians.json')): RosterEntry[] {
  return (JSON.parse(readFileSync(file, 'utf8')) as { technicians: RosterEntry[] }).technicians;
}

export interface TechnicianPlan {
  employeeNumber: string;
  name: string;
  branch: BranchId;
  installer: boolean;
  nameInTexts: string;
  phone: string;
  email: string;
  primarySkill: Skill;
  skills: Skill[];
  vanNumber: string;
  vehicle: string;
  saturdays: 'none' | 'even_weeks' | 'odd_weeks';
  since: string;
  language: 'en' | 'es';
  status: 'active' | 'invited';
  shiftStart: string;
  shiftEnd: string;
  workingDays: number[];
}

// Primary skill, van, phone, Saturdays and hours are the approved technicians page's for the 12 Columbus technicians
// (mockups/pages/office-technicians.html: its Skills, Alt. Saturdays and Hours columns, the Van under each name, PHONE).
// The other 9 are not on that page: they keep the earlier choices (plumbers, 08:00 to 17:00).
const PLUMBERS = new Set(['40701', '40702', '40703', '40704', '40714', '40720']);
// Alt. Saturdays on the page: Carter, Hoffman, Mitchell, Ortega, Santos (the page does not say which weeks; even or odd is chosen).
const SATURDAYS: Record<string, 'even_weeks' | 'odd_weeks'> = {
  '40702': 'even_weeks', '40704': 'odd_weeks', '40706': 'odd_weeks', '40708': 'even_weeks', '40712': 'odd_weeks',
  '40714': 'even_weeks', '40720': 'odd_weeks',
};
// The date each technician started, after the company's founding in 1987 (STORY section 1); Maria Santos's is in 2016.
const SINCE: Record<string, string> = {
  '40701': '2009-04-13', '40702': '2014-06-02', '40703': '2011-01-10', '40704': '2019-03-18', '40705': '2007-08-20', '40706': '2021-05-03',
  '40707': '2022-09-12', '40708': '2018-02-05', '40709': '2012-10-29', '40710': '2015-07-13', '40711': '2013-04-01', '40712': '2016-03-01',
  '40713': '2017-11-06', '40714': '2020-01-13', '40715': '2023-04-24', '40716': '2016-09-19', '40717': '2019-08-12', '40718': '2024-02-26',
  '40719': '2015-05-18', '40720': '2018-10-08', '40721': '2022-03-07',
};
// Van numbers and the last 4 digits of the phone, from the approved technicians page (Columbus); the rest follow in roster order.
const VAN_NUMBERS: Record<string, string> = {
  '40701': '21', '40702': '9', '40703': '27', '40704': '5', '40705': '7', '40706': '11',
  '40707': '24', '40708': '18', '40709': '3', '40710': '15', '40711': '30', '40712': '12',
};
const PHONE_TAIL: Record<string, string> = {
  '40701': '0121', '40702': '0109', '40703': '0127', '40704': '0105', '40705': '0107', '40706': '0111',
  '40707': '0124', '40708': '0118', '40709': '0103', '40710': '0115', '40711': '0130', '40712': '0112',
};
// Chris Yoder works Mon-Thu, 7:30 to 6 and is Invited on the page (the invite is not opened, so no password hash).
const YODER = '40711';
// Luis Ortega is Spanish on the approved start page's sign-in list; every other roster technician is English.
const SPANISH = new Set(['40708']);

/**
 * Technician users with no technician row: no past visits exist for them, so they are seed-only (F-254).
 * P2-AUTH decision (F-270): the sign-in list needs no technician row for Teresa Molina. API-03, API-05 and API-15 read the user row only,
 * and API-07 answers user.name; a row would raise Springfield's window capacity from 15 to 20 and need generator and past-visit changes.
 * What a technician-role user with no technician row sees on the technician app's day reads is P5-TWA-TODAY's to answer as an empty day.
 */
export interface ExtraUser { name: string; email: string; branch: BranchId; language: 'en' | 'es'; status: 'active' | 'invited' }
export const EXTRA_USERS: readonly ExtraUser[] = [
  // Derek Simmons: invited Dayton technician. The users page says Van 41, the start page's sign-in list says Van 40; the users page
  // is chosen (it is the page that shows his state). No van or technician row is written, so the number is not stored.
  { name: 'Derek Simmons', email: 'derek.simmons@brightwater.example', branch: 'dayton', language: 'en', status: 'invited' },
  { name: 'Teresa Molina', email: 'teresa.molina@brightwater.example', branch: 'springfield', language: 'es', status: 'active' },
];

/** The users page's Recent changes (mockups/pages/admin-users.html), as user_change rows: who, what, by whom, when. */
export const USER_CHANGES: readonly { email: string; what: 'invited' | 'turned_off'; byEmail: string; at: string }[] = [
  { email: 'derek.simmons@brightwater.example', what: 'invited', byEmail: 'dana.ruiz@brightwater.example', at: '2026-09-14T14:10:00-04:00' },
  { email: 'omar.haddad@brightwater.example', what: 'turned_off', byEmail: 'pat.kessler@brightwater.example', at: '2026-09-04T17:02:00-04:00' },
];

/** Everything the seed writes per technician beyond the roster: contact, skills, van, Saturdays and start date. */
export function planTechnicians(roster: readonly RosterEntry[]): TechnicianPlan[] {
  const taken = new Set(Object.values(VAN_NUMBERS));
  let next = 1;
  const nextVan = () => {
    while (taken.has(String(next))) next += 1;
    taken.add(String(next));
    return String(next);
  };
  return roster.map((t, i) => {
    const first = t.name.split(' ')[0] ?? t.name;
    const area = BRANCHES.find((b) => b.id === t.branch)?.area ?? '614';
    const primarySkill: Skill = t.installer ? 'install' : PLUMBERS.has(t.employeeNumber) ? 'plumbing' : 'heating_cooling';
    return {
      employeeNumber: t.employeeNumber,
      name: t.name,
      branch: t.branch,
      installer: t.installer,
      nameInTexts: first.slice(0, 10),
      phone: `(${area}) 555-${PHONE_TAIL[t.employeeNumber] ?? `01${String(20 + i).padStart(2, '0')}`}`, // 555-0100 to 555-0140, inside FR-IMP-7's range
      email: `${t.name.toLowerCase().replace(/[^a-z ]/g, '').replace(/ +/g, '.')}@brightwater.example`,
      primarySkill,
      skills: t.installer ? ['install', 'heating_cooling'] : [primarySkill],
      vanNumber: VAN_NUMBERS[t.employeeNumber] ?? nextVan(),
      vehicle: i % 3 === 1 ? 'Ram ProMaster 2500' : 'Ford Transit 250',
      saturdays: SATURDAYS[t.employeeNumber] ?? 'none',
      since: SINCE[t.employeeNumber] ?? '2020-01-06',
      language: SPANISH.has(t.employeeNumber) ? 'es' : 'en',
      status: t.employeeNumber === YODER ? 'invited' : 'active',
      shiftStart: t.employeeNumber === YODER ? '07:30' : '08:00',
      shiftEnd: t.employeeNumber === YODER ? '18:00' : t.branch === 'columbus' ? '17:30' : '17:00',
      workingDays: t.employeeNumber === YODER ? [1, 2, 3, 4] : [1, 2, 3, 4, 5],
    };
  });
}
