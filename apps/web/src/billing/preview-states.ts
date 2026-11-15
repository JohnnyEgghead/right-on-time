// SPDX-License-Identifier: AGPL-3.0-or-later
// The states of the billing preview routes. Their own module: the previews are client components, and a server page cannot read a value exported from one.
export const BILLING_STATES = ['success', 'loading', 'error', 'empty', 'retrying', 'sending', 'exporting', 'live', 'dialog', 'asking', 'saving', 'done'] as const;
export const PBS_LIST_STATES = ['success', 'loading', 'empty', 'error', 'applying'] as const;
export const PBS_INVOICE_STATES = ['success', 'loading', 'hand'] as const;
