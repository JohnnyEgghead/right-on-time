// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs catalog-parity on the real catalog pair; exit 1 and a line per issue when it fails.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkCatalogFiles } from '../src/parity.ts';

const dir = fileURLToPath(new URL('../catalog/', import.meta.url));
const issues = checkCatalogFiles(readFileSync(`${dir}en.json`, 'utf8'), readFileSync(`${dir}es.json`, 'utf8'));
for (const i of issues) process.stderr.write(`catalog-parity: ${i.kind}: ${i.key}\n`);
if (issues.length > 0) process.exit(1);
process.stdout.write('catalog-parity: en.json and es.json agree\n');
