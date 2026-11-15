// SPDX-License-Identifier: AGPL-3.0-or-later
// File I/O for the generator: the committed inputs, the verified street list and the generated output folder.
// The output folder is under .build/data (git-ignored): the files are regenerated, never committed (D7).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR as DEFAULT_DIR } from '../../db/src/data-asset.ts';
import { readStreetList } from '../../db/src/street-list.ts';
import { FILES, generate, type NamedPerson, type Output, type Technician } from './generate.ts';
import type { Files, Manifest } from './checks.ts';

export const PKG = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const MANIFEST_FILE = path.join(PKG, 'MANIFEST.json');
export const TRUTH_FILE = path.join(PKG, 'truth.json');
export const NAMED_FILE = path.join(PKG, 'named-people.json');
export const ROSTER_FILE = path.join(PKG, 'technicians.json');
export const DEFAULT_OUT = path.join(DEFAULT_DIR, 'generator');

export function loadInputs(opts: { streetList?: string; named?: string; roster?: string } = {}): Parameters<typeof generate>[0] {
  const streets = readStreetList(opts.streetList ?? path.join(DEFAULT_DIR, 'street-list.json'));
  const people = (JSON.parse(readFileSync(opts.named ?? NAMED_FILE, 'utf8')) as { people: NamedPerson[] }).people;
  const technicians = (JSON.parse(readFileSync(opts.roster ?? ROSTER_FILE, 'utf8')) as { technicians: Technician[] }).technicians;
  return { streets, people, technicians };
}

export function writeOutput(dir: string, out: Output): void {
  mkdirSync(dir, { recursive: true });
  for (const n of FILES) writeFileSync(path.join(dir, n), out[n]);
}

export function readOutput(dir: string): Files {
  const f: Files = {};
  for (const n of FILES) {
    const p = path.join(dir, n);
    if (existsSync(p)) f[n] = readFileSync(p);
  }
  return f;
}

export function readManifest(file = MANIFEST_FILE): Manifest {
  return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
}
