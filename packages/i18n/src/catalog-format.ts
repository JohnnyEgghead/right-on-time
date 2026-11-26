// SPDX-License-Identifier: AGPL-3.0-or-later
// The on-disk shape of a catalog file (D-16): a flat object, keys sorted, 1 key per line.
// Shared by the merge driver, the parity check and the tests so they cannot disagree.

export type CatalogMap = Record<string, string>;

function sortedKeys(map: CatalogMap): string[] {
  return Object.keys(map).sort();
}

/** Serialize a catalog: key-sorted, 2-space indent, 1 key per line, trailing newline. */
export function serializeCatalog(map: CatalogMap): string {
  const keys = sortedKeys(map);
  if (keys.length === 0) return '{}\n';
  const lines = keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(map[k])}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

export type CollisionSides = Record<string, { ours?: string | undefined; theirs?: string | undefined }>;

/**
 * The file the merge driver leaves on a key collision (F-137): the cleanly merged keys plus, for each colliding
 * key, a git-style conflict block holding both sides' lines. It is deliberately not valid JSON.
 */
export function conflictText(merged: CatalogMap, sides: CollisionSides): string {
  const line = (k: string, v: string) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`;
  const out: string[] = [];
  for (const k of [...new Set([...Object.keys(merged), ...Object.keys(sides)])].sort()) {
    const side = sides[k];
    if (!side) {
      out.push(line(k, merged[k] as string));
      continue;
    }
    out.push('<<<<<<< ours', ...(side.ours === undefined ? [] : [line(k, side.ours)]), '=======');
    out.push(...(side.theirs === undefined ? [] : [line(k, side.theirs)]), '>>>>>>> theirs');
  }
  return `{\n${out.join('\n')}\n}\n`;
}

/** Parse a catalog file; throws on anything but a flat object of strings. */
export function parseCatalog(text: string, label = 'catalog'): CatalogMap {
  const raw: unknown = JSON.parse(text);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label}: top level must be an object`);
  }
  const out: CatalogMap = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string') throw new Error(`${label}: value of "${k}" must be a string`);
    out[k] = v;
  }
  return out;
}
