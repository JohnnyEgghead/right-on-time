// SPDX-License-Identifier: AGPL-3.0-or-later
// Setup's named errors (BUILD_PLAN P2-SETUP, D-3). Every stop is 1 of these codes, so a test and an operator can tell
// which rule stopped it; the message adds which rows (refs and counts only, never a customer's name or address).
export const SETUP_ERRORS = {
  /** Another setup holds the setup lock on this database. */
  setup_running: 'another setup is running on this database',
  /** An office import run is marked running (requested, or being executed by the worker): setup does not take its world. */
  import_run_running: 'an office import run is running',
  /** The world already holds an import run or a customer, or the snapshot exists: setup writes a world once. */
  world_not_fresh: 'the world is not fresh',
  /** The generated export or fixture differs from packages/generator/MANIFEST.json. */
  generator_manifest: 'the generated files differ from the committed manifest',
  /** fixture.json does not hold the shape the world seed reads. */
  fixture_invalid: 'the fixture is malformed',
  /** A fixture customer's exact-match key (name_search, street_id, house_number) finds no customer (R-BP1). */
  customer_not_found: 'a fixture customer resolves to no customer',
  /** A fixture customer's exact-match key finds 2 or more customers (R-BP1). */
  customer_not_unique: 'a fixture customer resolves to more than 1 customer',
  /** A fixture customer's key finds a merged record B. */
  customer_merged: 'a fixture customer resolves to a merged record',
  /** A fixture row names a technician, service or arrival window the reference seed did not write. */
  reference_missing: 'a fixture row names a reference row that does not exist',
  /** A simulated pilot call's past visit is not exactly 1 imported visit, or that visit has no technician. */
  visit_not_found: 'a pilot call resolves to no single past visit',
  /** FR-MAP-4: a map file or the track set differs from packages/maps/MANIFEST.json (size, SHA-256, bounding box or zoom range). */
  map_hash_mismatch: 'a map file differs from the committed map manifest',
  /** FR-MAP-4: a file the map manifest names is not in the map folder. */
  map_missing: 'a map file the manifest names is missing',
  /** C6: a map file is over the 2 GiB size gate. */
  map_size_gate: 'a map file is over the size gate',
} as const;

export type SetupErrorCode = keyof typeof SETUP_ERRORS;

export class SetupError extends Error {
  readonly code: SetupErrorCode;
  constructor(code: SetupErrorCode, detail: string) {
    super(`${SETUP_ERRORS[code]}: ${detail}`);
    this.code = code;
    this.name = 'SetupError';
  }
}
