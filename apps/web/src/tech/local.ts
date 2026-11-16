// SPDX-License-Identifier: AGPL-3.0-or-later
// What the web technician app keeps on the phone beside the item store (P5-TWA-MAP-ME; SPECIFICATIONS 6.3 "Me screen", UI-SPECIFICATION 4.5
// rule 7, UD-43): the settings the Me screen sets (notices, text size), the parts list (SCR-TEC-16 works with no signal), the saved day
// (the Me screen and the Map tab offline) and the snapshot the day-changed notices are compared against. Every read and write is guarded: a
// private window or blocked storage leaves the app working, with nothing kept.
// The person's copies (the saved day, route, parts and snapshot here, and the job screens' IndexedDB copies, job/store.ts
// bw-tech-jobs) are 1 person's: forgetPerson drops them all at sign-out, and personSignedIn drops them when a different person
// signs in (F-1017 class), so a phone never shows one technician's customers to the next.
import { DexieItemStore } from '@bw/outbox/src/items/index.ts';
import { jobStore } from './job/store.ts';
import type { ShownRoute } from './steps.ts';
import { isTextSize, type DayData, type DaySnapshot, type Part, type RouteData, type TextSize } from './model.ts';

const PREFIX = 'bw.tech.';
export const KEYS = {
  notices: `${PREFIX}notices`,
  textSize: `${PREFIX}textSize`,
  parts: `${PREFIX}parts`,
  day: `${PREFIX}day`,
  route: `${PREFIX}route`,
  /** The last route read for each destination (rule 11), with the day it was read on. */
  routes: `${PREFIX}routes`,
  snapshot: `${PREFIX}snapshot`,
  /** The user id the person's copies belong to (API-03, API-05, API-07). */
  person: `${PREFIX}person`,
  /** The person's name and skill from the who-am-I answer (API-07), so Me draws the profile before the day is read (F-1740). */
  profile: `${PREFIX}profile`,
} as const;

/** The key P5-TWA-TODAY's own saved day used before there was one saved day (F-1018); forgotten like the rest, never read. */
const LEGACY_DAY_KEY = 'bw.tech.today.v1';

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage is full or blocked: nothing is kept, the screen still works from what it read
  }
}

/** A read answer kept with the demo time it was read at (shown as "saved 10:26 AM" offline). */
export interface Saved<T> {
  at: string;
  data: T;
}

export const savedDay = (): Saved<DayData> | null => read<Saved<DayData>>(KEYS.day);
export const saveDay = (v: Saved<DayData>): void => write(KEYS.day, v);
export const savedRoute = (): Saved<RouteData> | null => read<Saved<RouteData>>(KEYS.route);
export const saveRoute = (v: Saved<RouteData>): void => write(KEYS.route, v);
/**
 * The last route read for each destination (UI-SPECIFICATION 4.5 rule 11; P6-WEB-STEPS), by its job number, kept with the saved day of
 * `date`: each new read of a destination's route replaces its entry, and the whole set goes when the saved day goes.
 */
export interface KeptRoutes { date: string; routes: Record<string, ShownRoute> }
export const savedRoutes = (): KeptRoutes | null => read<KeptRoutes>(KEYS.routes);
export const saveRoutes = (v: KeptRoutes | null): void => (v === null ? forgetKey(KEYS.routes) : write(KEYS.routes, v));
export const savedParts = (): Saved<Part[]> | null => read<Saved<Part[]>>(KEYS.parts);
export const saveParts = (v: Saved<Part[]>): void => write(KEYS.parts, v);
/** The signed-in person's profile as Me draws it: from the session, not the saved day (F-1740; plan section 11 item 29, option b). */
export interface Profile { name: string; initials: string; skill: string | null }
export const savedProfile = (): Profile | null => read<Profile>(KEYS.profile);
export const saveProfile = (v: Profile): void => write(KEYS.profile, v);
export const savedSnapshot = (): DaySnapshot | null => read<DaySnapshot>(KEYS.snapshot);
export const saveSnapshot = (v: DaySnapshot): void => write(KEYS.snapshot, v);

/** CTL-TEC-10-08: on unless the technician turned it off (UD-43). */
export const noticesOn = (): boolean => read<boolean>(KEYS.notices) !== false;
export const setNoticesOn = (on: boolean): void => write(KEYS.notices, on);

/** CTL-TEC-10-09: the text size, Standard until set. */
export function textSize(): TextSize {
  const v = read<unknown>(KEYS.textSize);
  return isTextSize(v) ? v : 'standard';
}
export const setTextSize = (v: TextSize): void => write(KEYS.textSize, v);

function forgetKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // blocked storage keeps nothing to drop
  }
}

let forgets = 0;
/** How many times the person's copies were forgotten; a read round compares it before and after its calls (F-1006). */
export const forgetCount = (): number => forgets;

/**
 * Sign-out forgets the person's own copies; the phone's settings stay (they belong to the phone, not the person). The kept keys go
 * at once; the job screens' copies go in 1 IndexedDB transaction, which the returned promise waits for (await it before the page
 * moves on). The item store is not touched: what a technician entered sends under their own session (UD-20 refuses a sign-out
 * while anything waits).
 */
export async function forgetPerson(): Promise<void> {
  forgets += 1; // before any await: a read round that started earlier sees a different count and never saves what it read (F-1006)
  for (const k of [KEYS.parts, KEYS.day, KEYS.route, KEYS.routes, KEYS.snapshot, KEYS.person, KEYS.profile, LEGACY_DAY_KEY]) {
    try {
      window.localStorage.removeItem(k);
    } catch {
      // nothing to remove
    }
  }
  try {
    await jobStore().forgetAll();
  } catch {
    // no IndexedDB (a private window, blocked storage): nothing was kept there
  }
}

/** The user id the phone's copies belong to, recorded at sign-in (null when none): the person the screens show waiting items for (F-1041). */
export const signedInPerson = (): string | null => read<string>(KEYS.person);

/**
 * A person is signed in (the sign-in answer, or API-07 on a job screen): when the copies on the phone are not theirs (another
 * user id, or none recorded), they are forgotten before anything of this person's is shown or saved. True when they were.
 */
export async function personSignedIn(userId: string): Promise<boolean> {
  if (read<string>(KEYS.person) === userId) return false;
  await forgetPerson();
  write(KEYS.person, userId);
  return true;
}

/**
 * A sign-in answer (API-03, either way in): personSignedIn, and the item store's user is saved with it (F-1127, F-1041's own 2nd option).
 * The engine stamps each new item with the store's user, which lags the person who signed in until the first sync's API-07 answers; with
 * the signal gone right after sign-in, the next On the way, note or finish would be stamped the previous technician's and never sent.
 * A failed save (no IndexedDB, blocked storage, a full disk, a write error) never blocks the landing; `onUnsaved` is called so the sign-in
 * screen says so in its own message line, the way the note screen says a failed write (F-1241).
 */
export async function signInRecorded(userId: string, onUnsaved?: () => void): Promise<boolean> {
  const changed = await personSignedIn(userId);
  try {
    await new DexieItemStore().saveUser(userId);
  } catch {
    // F-1247: the landing follows at once, and the message set by `onUnsaved` would be gone with the page. The landing waits a bounded few
    // seconds, only on this failure, so the technician can read it (no new control, no flag to the next screen). Nothing is logged: a log
    // line is `@bw/log` fields only (SPECIFICATIONS 11.4, F-1416), the browser has no such logger, and the screen carries the message.
    if (onUnsaved) {
      onUnsaved();
      await new Promise<void>((resolve) => setTimeout(resolve, UNSAVED_HOLD_MS));
    }
  }
  return changed;
}

/** How long a sign-in whose item-store save failed waits, with its message on screen, before the page lands (F-1247). */
export const UNSAVED_HOLD_MS = 4000;
