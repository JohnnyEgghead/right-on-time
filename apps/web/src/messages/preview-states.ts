// SPDX-License-Identifier: AGPL-3.0-or-later
// The states of the Messages preview routes. Their own module: the previews are client components, and a server page cannot read a value exported from one.
export const LOG_STATES = ['success', 'loading', 'empty-day', 'empty-filter', 'error', 'trying', 'added', 'exporting', 'live'] as const;
export const CALL_STATES = ['success', 'loading', 'empty', 'recording', 'correcting', 'error', 'script-es'] as const;
