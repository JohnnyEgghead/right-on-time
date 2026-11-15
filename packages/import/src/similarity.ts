// SPDX-License-Identifier: AGPL-3.0-or-later
// Name similarity for likely duplicates (SPECIFICATIONS section 6.7 "Duplicates", C13): Jaro-Winkler over folded name
// tokens. Pure functions, no state.

/** Jaro similarity of 2 strings, 0 to 1. */
export function jaro(s: string, t: string): number {
  if (s === t) return s === '' ? 0 : 1;
  const n = s.length;
  const m = t.length;
  if (n === 0 || m === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(n, m) / 2) - 1);
  const sMatched = new Array<boolean>(n).fill(false);
  const tMatched = new Array<boolean>(m).fill(false);
  let matches = 0;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(m - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (!tMatched[j] && s[i] === t[j]) {
        sMatched[i] = true;
        tMatched[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let k = 0;
  let halfTranspositions = 0;
  for (let i = 0; i < n; i++) {
    if (!sMatched[i]) continue;
    while (!tMatched[k]) k++;
    if (s[i] !== t[k]) halfTranspositions++;
    k++;
  }
  const transpositions = halfTranspositions / 2;
  return (matches / n + matches / m + (matches - transpositions) / matches) / 3;
}

/** Jaro-Winkler similarity (prefix scale 0.1, prefix up to 4 characters), 0 to 1. */
export function jaroWinkler(s: string, t: string): number {
  const j = jaro(s, t);
  let prefix = 0;
  const max = Math.min(4, s.length, t.length);
  while (prefix < max && s[prefix] === t[prefix]) prefix++;
  return j + prefix * 0.1 * (1 - j);
}

/** A folded name split into its first name (first token) and last-name tokens (the rest), as the blocking keys read it. */
export function nameTokens(folded: string): { first: string; last: string[] } {
  const toks = folded.split(' ').filter((t) => t !== '');
  return { first: toks[0] ?? '', last: toks.slice(1) };
}

/**
 * The likely-duplicate name score of 2 folded names, 0 to 1: the mean of the first names' Jaro-Winkler similarity
 * and the best Jaro-Winkler similarity between any last-name token of one and any of the other. A shared surname
 * with a nickname ("robert hale" / "bob hale"), a misspelled surname with the same first name, and an added
 * hyphenated surname ("kathleen obrien miller" / "kathy obrien") all score well above 2 different people who share
 * only a surname, whose first-name term is near 0.
 */
export function nameScore(a: string, b: string): number {
  const x = nameTokens(a);
  const y = nameTokens(b);
  let last = 0;
  for (const p of x.last) for (const q of y.last) last = Math.max(last, jaroWinkler(p, q));
  return (jaroWinkler(x.first, y.first) + last) / 2;
}
