// SPDX-License-Identifier: AGPL-3.0-or-later
// The process logins (F-150; migration 0008) and the start-up step that migrates and provisions them.
//
// Each process gets its own login (bw_web, bw_worker: members of role app; bw_pbs: a member of role pbs) and reads its
// password from a file in its own volume, which only it and the migrate step mount (infra/compose.yaml). The migrate
// step runs as the schema owner, applies the migrations (migrate.ts) and sets each login's password.
//
// Re-run semantics, at each durable write:
//   - the password file: written once, when absent, with a fresh random value (create-exclusive, mode 0400); a later
//     run reads it and never rewrites it, so a running process's password never changes under it;
//   - the role password: ALTER ROLE ... PASSWORD with the SCRAM verifier of the file's value (never the value) on every run, so the database converges to the
//     files even after a database restore or a lost volume (a lost volume gets a new file and the role follows it);
//   - the migrations: migrate.ts (each file and its ledger row in 1 transaction; a second run applies nothing).
// The durable completion record is the ledger (system.schema_migration) plus the role passwords matching the files.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, writeSync, closeSync } from 'node:fs';
import path from 'node:path';
import type { Queryable } from './client.ts';

export const PROCESS_LOGINS = [
  { role: 'bw_web', process: 'web' },
  { role: 'bw_worker', process: 'worker' },
  { role: 'bw_pbs', process: 'pbs' },
] as const;
export type ProcessLogin = (typeof PROCESS_LOGINS)[number];

/** A generated password: 32 random bytes as base64url, so it never needs SQL quoting beyond a plain literal. */
const PASSWORD = /^[A-Za-z0-9_-]{43}$/;

/** The password file of a process under the logins directory: <dir>/<process>/password. */
export const passwordFile = (dir: string, process: string): string => path.join(dir, process, 'password');

/** Read the process's password file, or create it with a fresh password when it does not exist yet. */
export function ensurePasswordFile(dir: string, process: string): string {
  const file = passwordFile(dir, process);
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = openSync(file, 'wx', 0o400);
    try {
      writeSync(fd, `${randomBytes(32).toString('base64url')}\n`);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const pw = readFileSync(file, 'utf8').trim();
  if (!PASSWORD.test(pw)) throw new Error(`the password file of process ${process} does not hold a generated password`);
  return pw;
}

/**
 * The SCRAM-SHA-256 verifier of a password (RFC 7677; PostgreSQL's stored form): SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>.
 * The server keeps this and never learns the password (F-222). Salt and iterations are arguments for the tests; the
 * defaults are a fresh 16-byte salt and PostgreSQL's 4096 iterations.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const hmac = (key: Buffer, text: string): Buffer => createHmac('sha256', key).update(text).digest();
  const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${hmac(salted, 'Server Key').toString('base64')}`;
}

const VERIFIER = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/;

/**
 * Set a login's password (owner connection). The password is checked against the generated form, then only its SCRAM
 * verifier is sent: a failed ALTER ROLE writes the statement into the database log (log_min_error_statement), and that
 * line must never hold the password itself (F-222).
 */
export async function setLoginPassword(owner: Queryable, login: ProcessLogin, password: string): Promise<void> {
  if (!PASSWORD.test(password)) throw new Error(`refused: the password for ${login.role} is not a generated password`);
  const verifier = scramVerifier(password);
  if (!VERIFIER.test(verifier)) throw new Error(`refused: the verifier for ${login.role} is malformed`);
  await owner.query(`ALTER ROLE ${login.role} LOGIN PASSWORD '${verifier}'`);
}

/** Provision every process login from its file under dir (creating missing files). Returns the logins set. */
export async function provisionLogins(owner: Queryable, dir: string): Promise<string[]> {
  const done: string[] = [];
  for (const login of PROCESS_LOGINS) {
    await setLoginPassword(owner, login, ensurePasswordFile(dir, login.process));
    done.push(login.role);
  }
  return done;
}
