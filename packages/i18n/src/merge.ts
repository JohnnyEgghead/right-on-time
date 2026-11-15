// SPDX-License-Identifier: AGPL-3.0-or-later
// Three-way key-union merge of a catalog file (D-16). Pure; the git driver script calls it.
// It never picks a value: two sides that set 1 key to different values stop the merge.
import type { CatalogMap, CollisionSides } from './catalog-format.ts';

export class CatalogKeyCollision extends Error {
  readonly keys: string[];
  /** The keys that merged cleanly, so the driver can write a conflict file that holds everything else (F-137). */
  readonly merged: CatalogMap;
  /** Each colliding key with the value on each side (undefined = removed on that side). */
  readonly sides: CollisionSides;
  constructor(keys: string[], merged: CatalogMap = {}, sides: CollisionSides = {}) {
    super(`catalog key collision: ${keys.join(', ')}`);
    this.name = 'CatalogKeyCollision';
    this.keys = keys;
    this.merged = merged;
    this.sides = sides;
  }
}

/**
 * Union of both sides' keys. A key one side removed and the other left unchanged from the
 * base stays removed (otherwise a deliberate delete would come back). A key the sides set to
 * different values, or one side removed while the other changed, is a collision.
 */
export function mergeCatalogs(base: CatalogMap, ours: CatalogMap, theirs: CatalogMap): CatalogMap {
  const keys = new Set([...Object.keys(ours), ...Object.keys(theirs)]);
  const merged: CatalogMap = {};
  const collisions: string[] = [];
  for (const key of [...keys].sort()) {
    const o = ours[key];
    const t = theirs[key];
    const b = base[key];
    if (o === t) {
      if (o !== undefined) merged[key] = o;
    } else if (o === undefined || t === undefined) {
      // One side lacks the key.
      const present = (o ?? t) as string;
      if (b === undefined) merged[key] = present; // the other side added it
      else if (b === present) continue; // the other side removed it, this side left it alone
      else collisions.push(key); // removed on one side, changed on the other
    } else if (b === o) {
      merged[key] = t;
    } else if (b === t) {
      merged[key] = o;
    } else {
      collisions.push(key);
    }
  }
  // A key only the base had is gone on both sides: nothing to do.
  if (collisions.length > 0) {
    const sides = Object.fromEntries(collisions.map((k) => [k, { ours: ours[k], theirs: theirs[k] }]));
    throw new CatalogKeyCollision(collisions, merged, sides);
  }
  return merged;
}
