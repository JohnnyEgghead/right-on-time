// SPDX-License-Identifier: AGPL-3.0-or-later
// Password hashing and the sample passwords (SPECIFICATIONS SD-8 "Hashed passwords", SD-9). No file, no database: the
// seed writes hashes with it, and sign-in (P2-AUTH) and API-15 use the same functions, so a stored hash and a typed
// password always meet the same rules.
//
// Hash format: `scrypt$N$r$p$salt$hash` (base64 salt and key), N = 2^15, r = 8, p = 1, a 16-byte random salt, a 32-byte
// key, maxmem 64 MiB; verification re-reads N, r and p from the stored string and compares with timingSafeEqual.
import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const MAXMEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keyBytes: number): Promise<Buffer> {
  const options: ScryptOptions = { N: n, r, p, maxmem: MAXMEM };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyBytes, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Hash a password for `user.password_hash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, R, P, KEY_BYTES);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** True when `password` matches the stored hash. A malformed or foreign hash is false, never a throw. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (stored === null) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0)) return false;
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await derive(password, salt, n, r, p, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false; // parameters the runtime refuses (for example N above the memory cap)
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Crockford base32 of the bytes, without padding. */
function crockford(bytes: Buffer): string {
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out;
}

/** SD-9: a sample person's password = the first 10 characters of Crockford base32 of HMAC-SHA256(seed, email). */
export function samplePassword(seed: string, email: string): string {
  return crockford(createHmac('sha256', seed).update(email).digest()).slice(0, 10);
}

/** The shown form of a sample password, `xxxxx-xxxxx` (SD-9). */
export function showSamplePassword(password: string): string {
  return `${password.slice(0, 5)}-${password.slice(5)}`;
}
