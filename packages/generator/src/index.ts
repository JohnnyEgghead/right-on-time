// SPDX-License-Identifier: AGPL-3.0-or-later
// @bw/generator (SPECIFICATIONS section 6.7, SD-24, SD-25): the old system's export and the world seed's fixture.
export { generate, TARGETS, EXPORTED_AT, FILES, CUSTOMER_COLUMNS, VISIT_COLUMNS, EQUIPMENT_COLUMNS, exactKey, lookupKey, blockingKeys } from './generate.ts';
export type { Output, FileName, StreetRow, Technician, NamedPerson } from './generate.ts';
export {
  checkManifest, phoneRangeScan, shareNoneCheck, truthCheck, targetCountsCheck, ratesCheck, sd25Rates, plantedCounts,
} from './checks.ts';
export type { Fixture, Manifest, Files } from './checks.ts';
export { loadInputs, readOutput, writeOutput, DEFAULT_OUT } from './io.ts';
export { SEED } from './prng.ts';
export { chainVisits } from './chain.ts';
export type { ChainedVisit, ChainVisit, VisitScript } from './chain.ts';
