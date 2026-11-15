// SPDX-License-Identifier: AGPL-3.0-or-later
// The page a person is sent back to after signing in (the page gate's `return` query value).
/** A path on this origin only: `/x`, never `//host` or a backslash form (an open redirect). */
export function safeReturn(value: string | null | undefined): string | null {
  return value && /^\/(?![/\\])[^\s\\]*$/.test(value) ? value : null;
}
