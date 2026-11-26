// SPDX-License-Identifier: AGPL-3.0-or-later
// The calls of the account pages (P4-ACCOUNTS): each names its contract row from @bw/api and goes through the typed client
// (SPECIFICATIONS section 4.1: page code calls only @bw/api). A refusal answers its code and status, never a stand-in.
// Link tokens travel only in the path of their own row; nothing here logs or stores one.
import {
  ApiError, createClient, emailByLink, inviteUser, passwordLink, requestReset, roleAccess, searchUsers, setPassword, setUserRole, turnUserOff,
  turnUserOn, userChanges, z, type ContractRow,
} from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { dateParts, fromWire, type Instant, type Language } from '@bw/time';
import { shortText } from '../shell/clock.ts';

export type Answer<T> = { ok: true; data: T } | { ok: false; code: string; status: number };

export async function callRow<R extends ContractRow>(row: R, input: Record<string, unknown> = {}): Promise<Answer<z.output<R['response']>>> {
  try {
    const a = await createClient({ baseUrl: typeof window === 'undefined' ? '' : window.location.origin }).call(row, input);
    return { ok: true, data: a.data as z.output<R['response']> };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, code: e.problem.code, status: e.status };
    return { ok: false, code: 'offline', status: 0 };
  }
}

export const rows = { searchUsers, inviteUser, setUserRole, turnUserOff, turnUserOn, roleAccess, userChanges, requestReset, emailByLink, passwordLink, setPassword };

export type UserItem = z.output<typeof searchUsers.response>['users'][number];
export type UserSearch = z.output<typeof searchUsers.response>;
export type RoleAreas = z.output<typeof roleAccess.response>['areas'];
export type UserChange = z.output<typeof userChanges.response>['changes'][number];
export type OpenedEmail = z.output<typeof emailByLink.response>;
export type PasswordLinkInfo = z.output<typeof passwordLink.response>;
export type InviteAnswer = z.output<typeof inviteUser.response>;

type T = (key: MessageKey, values?: Record<string, string | number>) => string;
const ZONE = 'America/New_York';
const at = (wire: string): Instant => fromWire(wire).toInstant();

/** "Tue, Sep 15, 10:26 AM" in the branches' zone, words from the catalog. */
export const whenText = (wire: string, lang: Language, t: T): string => shortText(at(wire), ZONE, lang, t);

/** "Sep 14": the month and day of a status date (CTL-OFC-43-15). */
export function dayText(wire: string, t: T): string {
  const p = dateParts(at(wire), ZONE);
  return t('accounts.users.monthDay', { month: t(`time.month.${p.month}` as MessageKey), day: p.day });
}

/** Initials for the avatar: first letters of the first 2 words. */
export const initialsOf = (name: string): string =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
