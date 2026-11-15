// SPDX-License-Identifier: AGPL-3.0-or-later
// The native session (SPECIFICATIONS 6.12 and SD-47 "the bearer token in the Keychain through expo-secure-store"; SD-8; FR-AUTH-10
// CTL-TEC-01-08): API-03 with client native answers a bearer token once; it is kept in the Keychain with the server it came from, and
// only for that server. A token of another origin is no session (the Me screen says "Sign out to change the server."), so a changed
// server address never sends one server's token to another. Pure over a SecretStore port; expo-secure-store is the phone's.
import type { Language } from '@bw/i18n/src/language.ts';

/** The phone's Keychain as the session needs it (src/auth/keychain.ts wraps expo-secure-store). */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Session {
  /** The server origin the token belongs to. */
  origin: string;
  /** The bearer token API-03 answered (never logged, never shown). */
  token: string;
  userId: string;
  name: string;
  language: Language;
  /** CTL-TEC-01-08 as it rode on API-03 (keepSignedIn): on, no idle limit; off, the server ends it after the idle limit. */
  staySignedIn: boolean;
}

export const SESSION_KEY = 'bw.session';

export class SessionStore {
  private readonly secrets: SecretStore;

  constructor(secrets: SecretStore) {
    this.secrets = secrets;
  }

  /** The session kept for this server, or null (none, unreadable, or another server's: that one is removed). */
  async load(origin: string): Promise<Session | null> {
    const text = await this.secrets.get(SESSION_KEY);
    if (text === null) return null;
    let s: Partial<Session>;
    try {
      s = JSON.parse(text) as Partial<Session>;
    } catch {
      await this.secrets.remove(SESSION_KEY);
      return null;
    }
    const ok = typeof s.token === 'string' && s.token.length > 0 && typeof s.userId === 'string' && typeof s.origin === 'string';
    if (!ok || s.origin !== origin) {
      await this.secrets.remove(SESSION_KEY);
      return null;
    }
    return s as Session;
  }

  async save(s: Session): Promise<void> {
    await this.secrets.set(SESSION_KEY, JSON.stringify(s));
  }

  async clear(): Promise<void> {
    await this.secrets.remove(SESSION_KEY);
  }
}
