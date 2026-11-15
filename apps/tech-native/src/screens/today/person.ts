// SPDX-License-Identifier: AGPL-3.0-or-later
// The person the phone last signed in (SCR-TEC-01 "Items waiting", UD-20): when the session ends while items wait, the sign-in name is the
// waiting technician's and cannot be changed, so the phone keeps who that is: the user id the items carry, the name for the notice, and
// the sign-in the person typed (what API-03 takes). 1 small file in the app's own directory; pure over StoreDir, so the tests run it on node.
import type { StoreDir } from '@bw/outbox/src/items/native.ts';

export interface Person {
  userId: string;
  name: string;
  login: string;
}

const FILE = 'person.json';

export class PersonFile {
  constructor(private readonly dir: StoreDir) {}

  read(): Person | null {
    try {
      const text = this.dir.readText(FILE);
      if (text === null) return null;
      const v = JSON.parse(text) as Partial<Person>;
      return typeof v.userId === 'string' && typeof v.name === 'string' && typeof v.login === 'string' ? { userId: v.userId, name: v.name, login: v.login } : null;
    } catch {
      return null;
    }
  }

  /** Nothing waits any more (F-1115): who the phone last signed in is not kept. */
  clear(): void {
    this.dir.remove(FILE);
  }

  write(p: Person): void {
    this.dir.remove(FILE);
    this.dir.create(FILE, JSON.stringify(p));
  }
}

/** The waiting technician when items wait for 1 person the phone knows; null when none waits or the waiting items are of someone it does not know. */
export function waitingPerson(waiting: readonly { userId: string }[], person: Person | null): { person: Person; count: number } | null {
  if (!person) return null;
  const mine = waiting.filter((w) => w.userId === person.userId);
  return mine.length > 0 ? { person, count: mine.length } : null;
}
