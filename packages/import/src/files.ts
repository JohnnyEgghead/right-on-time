// SPDX-License-Identifier: AGPL-3.0-or-later
// Read the export's 3 files from a folder (the generator's output folder at setup, D-3 step 2).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EXPORT_FILES, type ExportFiles } from './layout.ts';

export function readExport(dir: string): ExportFiles {
  const out = {} as ExportFiles;
  for (const f of EXPORT_FILES) out[f] = readFileSync(path.join(dir, f), 'utf8');
  return out;
}
