// SPDX-License-Identifier: AGPL-3.0-or-later
// The search fold of SPECIFICATIONS section 3 (street.name_search, customer.name_search): 1 function, used by the
// writers of those columns (the street-list loader, the generator) and by every search that matches them (API-130), so
// a stored key and a typed query always fold alike. Pure: no file, no database (the @bw/db index exports it; F-216).

/** Lowercased, accents and punctuation folded (SPECIFICATIONS section 3, street.name_search). */
export function foldStreetName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
