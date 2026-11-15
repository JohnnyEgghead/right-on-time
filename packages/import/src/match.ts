// SPDX-License-Identifier: AGPL-3.0-or-later
// The match stage (SPECIFICATIONS section 6.7 "Duplicates", C13, FR-IMP-3). Pure: customers in, pairs out.
//
// Exact: the same folded name, the same street and house number, and the same mobile digits (2 rows with no mobile
// share the empty digits). Likely: 2 customers who share a blocking key and whose name score reaches
// LIKELY_THRESHOLD, and are not an exact pair. The blocking keys and the fold are the generator's model, the 1 model
// the planted-truth file is complete under (packages/generator/README.md "Blocking"; finding F-205): each folded
// last-name token plus the ZIP cell as the file holds it, and the folded first name plus the street. The fold is
// @bw/db's foldStreetName, the customer.name_search fold (apostrophes dropped, hyphens split; SPECIFICATIONS
// section 3, customer.name_search), so "Kathleen O'Brien-Miller" and "Kathy OBrien" share the block obrien + 43221.
// A blank name joins no pair: an empty name is no evidence of anything.
//
// Record A of every pair is the customer whose row comes first in customers.csv (OI-50): the lower index.
import { nameScore, nameTokens } from './similarity.ts';

export interface MatchCustomer {
  /** Index in customers.csv order (0 = the first data row). */
  index: number;
  /** The folded name (customer.name_search). */
  nameSearch: string;
  streetId: string;
  houseNumber: number;
  /** The ZIP cell as the file holds it ('' for a row with no ZIP). */
  zipCell: string;
  /** The mobile cell's digits ('' for no mobile). */
  mobileDigits: string;
}

/**
 * Why a likely pair was listed (owner ruling ba125b81, F-265): the key spells the approved review page's sentence
 * "Listed because the phone number and house number match, but the name and street spelling differ." It names what
 * matches, then what differs, each list in the order phone, house number, name, street, joined by `_and_`:
 * `phone_and_house_number_match_name_and_street_differ`. The phone is compared only when a record has a mobile (2
 * records with none are silent on it). An exact pair, where everything matches, is `exact_match`.
 */
export type LikelyWhy = string;
export type PairWhy = 'exact_match' | LikelyWhy;

/** The 4 facts a why key names, in the sentence's order. */
export const WHY_FIELDS = ['phone', 'house_number', 'name', 'street'] as const;

export interface MatchPair {
  kind: 'exact' | 'likely';
  /** Index of record A (the earlier row). */
  a: number;
  /** Index of record B. */
  b: number;
  why: PairWhy;
  /** The name score (1 for an exact pair). */
  score: number;
}

/** The lowest name score a likely pair needs. Measured margins: docs/build/spikes/P2-IMPORT.md. */
export const LIKELY_THRESHOLD = 0.6;

export function exactKey(c: MatchCustomer): string {
  return `${c.nameSearch}#${c.streetId}#${c.houseNumber}#${c.mobileDigits}`;
}

/** The blocking keys of 1 customer, each once (the generator's model; F-205). "Ana Ruiz Ruiz" holds 1 Ruiz block. */
export function blockingKeys(c: MatchCustomer): string[] {
  const { first, last } = nameTokens(c.nameSearch);
  if (first === '') return [];
  return [...new Set([`F|${first}|${c.streetId}`, ...last.map((t) => `L|${t}|${c.zipCell}`)])];
}

export function likelyWhy(a: MatchCustomer, b: MatchCustomer): LikelyWhy {
  const facts: Record<(typeof WHY_FIELDS)[number], boolean | null> = {
    phone: a.mobileDigits === '' && b.mobileDigits === '' ? null : a.mobileDigits === b.mobileDigits,
    house_number: a.houseNumber === b.houseNumber,
    name: a.nameSearch === b.nameSearch,
    street: a.streetId === b.streetId,
  };
  const match = WHY_FIELDS.filter((f) => facts[f] === true);
  const differ = WHY_FIELDS.filter((f) => facts[f] === false);
  return [match.length > 0 ? `${match.join('_and_')}_match` : '', differ.length > 0 ? `${differ.join('_and_')}_differ` : '']
    .filter((x) => x !== '').join('_');
}

export interface MatchResult {
  pairs: MatchPair[];
  /** How many candidate pairs the blocks produced (each scored once): C13's comparisons, after blocking. */
  comparisons: number;
}

/**
 * Exact and likely pairs among the customers, sorted by record A's index then B's. A customer can be in more than 1
 * pair only if the data holds a block of 3 or more look-alikes; every pair is still reported.
 */
export function matchCustomers(customers: readonly MatchCustomer[], threshold = LIKELY_THRESHOLD): MatchResult {
  const pairs: MatchPair[] = [];
  const named = customers.filter((c) => c.nameSearch !== '');
  const exactSeen = new Set<string>();

  const byExact = new Map<string, MatchCustomer[]>();
  for (const c of named) {
    const k = exactKey(c);
    const g = byExact.get(k);
    if (g) g.push(c);
    else byExact.set(k, [c]);
  }
  for (const g of byExact.values()) {
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const [a, b] = sortPair(g[i] as MatchCustomer, g[j] as MatchCustomer);
        exactSeen.add(`${a.index}:${b.index}`);
        pairs.push({ kind: 'exact', a: a.index, b: b.index, why: 'exact_match', score: 1 });
      }
    }
  }

  const blocks = new Map<string, MatchCustomer[]>();
  for (const c of named) {
    for (const k of blockingKeys(c)) {
      const g = blocks.get(k);
      if (g) g.push(c);
      else blocks.set(k, [c]);
    }
  }
  const scored = new Set<string>();
  let comparisons = 0;
  for (const g of blocks.values()) {
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const [a, b] = sortPair(g[i] as MatchCustomer, g[j] as MatchCustomer);
        const id = `${a.index}:${b.index}`;
        if (scored.has(id) || exactSeen.has(id)) continue;
        scored.add(id);
        comparisons++;
        const score = nameScore(a.nameSearch, b.nameSearch);
        if (score >= threshold) pairs.push({ kind: 'likely', a: a.index, b: b.index, why: likelyWhy(a, b), score });
      }
    }
  }
  pairs.sort((x, y) => x.a - y.a || x.b - y.b);
  return { pairs, comparisons };
}

function sortPair(x: MatchCustomer, y: MatchCustomer): [MatchCustomer, MatchCustomer] {
  return x.index < y.index ? [x, y] : [y, x];
}
