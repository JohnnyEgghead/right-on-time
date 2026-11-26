// SPDX-License-Identifier: AGPL-3.0-or-later
// The reason a person finds the access code screen or the sign-in page after a world reset ended their session (FR-DEMO-4, FR-DEMO-7).
// A signed-in page keeps the world epoch of its last answer to who-am-I (the call that fails once the session is gone) (sessionStorage, this tab only). The two screens read the public app info once and
// compare: an epoch that rose since means a reset happened, and the reset is what ended the session. A tab that never held a session has
// nothing kept, so a first visit shows no reason. Only the epoch (a counter the app info already answers to anyone) is kept: no account,
// no token and no name.
import type { Reader } from '../shell/reads.ts';

const SESSION_EPOCH_KEY = 'bw.session.epoch';

/** A signed-in page read the world at this epoch. */
export function rememberSessionEpoch(epoch: number): void {
  try {
    window.sessionStorage.setItem(SESSION_EPOCH_KEY, String(epoch));
  } catch {
    // storage is off: the 2 screens then show no reason, which is what they showed before
  }
}

/** The person ended the session: nothing is left to explain. */
export function forgetSessionEpoch(): void {
  try {
    window.sessionStorage.removeItem(SESSION_EPOCH_KEY);
  } catch {
    // storage is off: nothing was kept
  }
}

function keptEpoch(): number | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_EPOCH_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** True only when this tab held a signed-in page and the world epoch is higher now. A failed read answers false: no reason is claimed. */
export async function resetEndedSession(reader: Reader): Promise<boolean> {
  const kept = keptEpoch();
  if (kept === null) return false;
  const r = await reader.read<unknown>('API-02');
  return r.ok && typeof r.epoch === 'number' && r.epoch > kept;
}
