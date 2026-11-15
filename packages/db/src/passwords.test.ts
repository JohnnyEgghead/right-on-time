// SPDX-License-Identifier: AGPL-3.0-or-later
// SD-8 (hashed passwords) and SD-9 (sample passwords): the hash format, the verify rules and the sample derivation.
import { describe, expect, it } from 'vitest';
import { hashPassword, samplePassword, showSamplePassword, verifyPassword } from './passwords.ts';

describe('hashPassword and verifyPassword', () => {
  // why: SD-8 scrypt$N$r$p$salt$hash with N = 2^15, r = 8, p = 1, a 16-byte salt and a 32-byte key, verified by the stored parameters
  it('writes the SD-8 format and verifies the right password only', async () => {
    const h = await hashPassword('correct horse battery');
    const [tag, n, r, p, salt, key] = h.split('$');
    expect([tag, n, r, p]).toEqual(['scrypt', '32768', '8', '1']);
    expect(Buffer.from(salt ?? '', 'base64')).toHaveLength(16);
    expect(Buffer.from(key ?? '', 'base64')).toHaveLength(32);
    expect(h).not.toContain('correct horse');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('correct horse batterz', h)).toBe(false);
  });

  // why: SD-8 each hash has its own random salt
  it('gives the same password a different hash each time', async () => {
    expect(await hashPassword('same-password-1')).not.toBe(await hashPassword('same-password-1'));
  });

  // why: SD-8 a null (Invited) or malformed hash never verifies and never throws
  it('answers false for a null, foreign or malformed stored hash', async () => {
    for (const bad of [null, '', 'plain', 'bcrypt$1$2$3$4$5', 'scrypt$x$8$1$AA==$AA==', 'scrypt$32768$8$1$$', 'scrypt$1073741824$8$1$AAAA$AAAA']) {
      expect(await verifyPassword('anything-at-all', bad)).toBe(false);
    }
  });
});

describe('samplePassword', () => {
  // why: SD-9 the first 10 characters of Crockford base32 of HMAC-SHA256(seed, email), shown as xxxxx-xxxxx
  it('derives 10 Crockford characters from the seed and the email, and shows them as 5-5', () => {
    const p = samplePassword('test-seed-0123456789ab', 'maria.santos@brightwater.example');
    expect(p).toBe('72F1782QC9'); // computed apart from this code (Python hmac + base32, Crockford alphabet)
    expect(p).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(showSamplePassword(p)).toBe('72F17-82QC9');
  });

  // why: SD-9 a seed change changes every password; 2 people never share one
  it('differs by seed and by email', () => {
    const a = samplePassword('test-seed-0123456789ab', 'a@brightwater.example');
    expect(samplePassword('test-seed-0123456789ac', 'a@brightwater.example')).not.toBe(a);
    expect(samplePassword('test-seed-0123456789ab', 'b@brightwater.example')).not.toBe(a);
  });
});
