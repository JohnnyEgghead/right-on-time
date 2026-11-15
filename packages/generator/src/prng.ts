// SPDX-License-Identifier: AGPL-3.0-or-later
// The generator's 1 seeded PRNG (SPECIFICATIONS section 6.7, FR-IMP-5): xoshiro128** seeded through splitmix32.
// Every random choice the generator makes comes from 1 instance of this class, in 1 fixed order, so the export is
// byte-identical on every run. Integer-only arithmetic (Math.imul, >>> 0): no platform floating-point drift.

export const SEED = 20260915;

function splitmix32(state: number): [number, number] {
  const s = (state + 0x9e3779b9) >>> 0;
  let z = s;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return [s, (z ^ (z >>> 16)) >>> 0];
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

export class Prng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number = SEED) {
    let st = seed >>> 0;
    const out: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [next, v] = splitmix32(st);
      st = next;
      out.push(v);
    }
    [this.s0, this.s1, this.s2, this.s3] = out as [number, number, number, number];
  }

  /** The next 32-bit unsigned integer (xoshiro128**). */
  next(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** An integer in [0, n). */
  int(n: number): number {
    if (!Number.isInteger(n) || n <= 0) throw new Error(`Prng.int: n must be a positive integer, got ${n}`);
    return Math.floor((this.next() / 0x100000000) * n);
  }

  /** An integer in [lo, hi], both included. */
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  /** True with probability num/den (integers, so no float drift in the decision). */
  chance(num: number, den: number): boolean {
    return this.int(den) < num;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Prng.pick: empty list');
    return items[this.int(items.length)] as T;
  }

  /** Fisher-Yates in place; returns the same array. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  }
}
