// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Queryable } from './client.ts';
import { PROCESS_LOGINS, scramVerifier, setLoginPassword } from './logins.ts';

const hmac = (key: Buffer, text: string): Buffer => createHmac('sha256', key).update(text).digest();

// why: F-222 the verifier is a correct SCRAM-SHA-256 one, checked against the RFC 7677 example exchange
describe('scramVerifier (RFC 7677)', () => {
  it('reproduces the RFC 7677 client proof and server signature for the password "pencil"', () => {
    const v = scramVerifier('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'), 4096);
    const m = /^SCRAM-SHA-256\$4096:(.+)\$(.+):(.+)$/.exec(v) as RegExpExecArray;
    expect(m[1]).toBe('W22ZaJ0SNY7soEsUEjb6gQ==');
    const storedKey = Buffer.from(m[2]!, 'base64');
    const serverKey = Buffer.from(m[3]!, 'base64');
    const authMessage = [
      'n=user,r=rOprNGfwEbeRWgbNEkqO',
      'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096',
      'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0',
    ].join(',');
    // ClientProof = ClientKey XOR HMAC(StoredKey, AuthMessage); the stored key must be the hash of the client key it yields.
    const signature = hmac(storedKey, authMessage);
    const proof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64');
    const clientKey = Buffer.from(proof.map((b, i) => b ^ signature[i]!));
    expect(createHash('sha256').update(clientKey).digest().equals(storedKey)).toBe(true);
    expect(hmac(serverKey, authMessage).toString('base64')).toBe('6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
  });
});

// why: F-222 the plain password never reaches the server, so a failed ALTER ROLE cannot log it
describe('setLoginPassword (F-222)', () => {
  it('sends a SCRAM verifier and never the password', async () => {
    const sent: string[] = [];
    const owner = { query: async (sql: string) => { sent.push(sql); return { rows: [] }; } } as unknown as Queryable;
    const password = 'A'.repeat(20) + 'b'.repeat(20) + '_-9';
    await setLoginPassword(owner, PROCESS_LOGINS[0], password);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^ALTER ROLE bw_web LOGIN PASSWORD 'SCRAM-SHA-256\$4096:/);
    expect(sent[0]).not.toContain(password);
  });

  it('still refuses a value that is not a generated password', async () => {
    const owner = { query: async () => ({ rows: [] }) } as unknown as Queryable;
    await expect(setLoginPassword(owner, PROCESS_LOGINS[0], "x'; DROP ROLE app; --")).rejects.toThrow(/not a generated password/);
  });
});
