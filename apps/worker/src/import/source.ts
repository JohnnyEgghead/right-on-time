// SPDX-License-Identifier: AGPL-3.0-or-later
// The export an office import run reads (F-258, F-340; BUILD_PLAN section 11 item 19). The documents name 1 export, the
// generator's, made from its fixed seed and byte-identical on every run (SPECIFICATIONS section 6.7, FR-IMP-5, SD-24;
// UI-SPECIFICATION CTL-OFC-13-10 "the one fixed export of Mon, Aug 31, 5:00 AM"). So there is no folder of export files:
// the worker makes that export in process, exactly as setup's step 2 does (@bw/setup generateChecked: the generator from
// the shipped inputs, refused with generator_manifest on any byte that differs from packages/generator/MANIFEST.json),
// from the street list setup reads (streetListFile: BW_STREET_LIST, else .build/data/street-list.json, which the
// Compose file mounts into the worker as into setup).
import type { ExportFiles } from '@bw/import';
import { generateChecked, streetListFile } from '@bw/setup';

/** The 3 export files of the generator's checked output. Throws SetupError generator_manifest on a changed byte. */
export function officeExport(file: string = streetListFile()): ExportFiles {
  const out = generateChecked(file);
  return { 'customers.csv': out['customers.csv'], 'visits.csv': out['visits.csv'], 'equipment.csv': out['equipment.csv'] };
}
