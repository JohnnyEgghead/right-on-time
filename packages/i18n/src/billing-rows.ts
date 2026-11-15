// SPDX-License-Identifier: AGPL-3.0-or-later
// The words of the billing list's rows (SCR-OFC-10: CTL-OFC-10-03 waiting, CTL-OFC-10-10 Fixed in the last 7 days), shared by the page
// and its export, API-159, so the export says each row in the page's own words (FR-BILL-12: the export equals the on-screen rows; F-591).
// Pure: the caller passes its formatter (the page's useT, the server's formatterFor), so 1 composition serves both sides.
import type { MessageKey } from './catalog.ts';

export type RowT = (key: MessageKey, values?: Record<string, string | number>) => string;

type ReasonKind = 'timeout' | 'down' | 'data_error' | null;

/** The fields of an API-60 waiting row these words read. */
export interface WaitingWords {
  reasonKind: ReasonKind;
  reason: string | null;
}

/** The fields of an API-60 leftLast7Days row these words read. */
export interface LeftWords {
  reasonKind: ReasonKind;
  reason: string | null;
  how: 'automatic_retry' | 'sent_again' | 'corrected' | 'marked_fixed';
  tries: number;
  by: string | null;
  markedReason: string | null;
}

/** "Keisha Thompson" -> "Keisha T."; a single name stays as it is. */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length < 2 ? name.trim() : `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

/** A waiting row's reason: billing's own words for a data error, else the catalog's for its kind ("Billing system did not answer"). */
export function waitingReasonText(r: WaitingWords, t: RowT): string {
  if (r.reasonKind === null) return t('billing.reason.none');
  return r.reasonKind === 'data_error' && r.reason ? r.reason : t(`billing.reason.${r.reasonKind}` as MessageKey);
}

/** A Fixed row's "Reason" cell: why the job was listed, in the table's short words ("Did not answer"). */
export function leftReasonText(r: LeftWords, t: RowT): string {
  if (r.reasonKind === null) return '';
  return r.reasonKind === 'data_error' && r.reason ? r.reason : t(`billing.fixedReason.${r.reasonKind}` as MessageKey);
}

/** A Fixed row's chip: "Marked fixed" or "Sent". */
export function leftChipText(r: LeftWords, t: RowT): string {
  return t(r.how === 'marked_fixed' ? 'billing.fixed.marked' : 'billing.fixed.sent');
}

/**
 * A Fixed row's "How it reached billing, and who" text after its chip: "Automatic retry, try 2", "Sent again by Keisha T.", or for
 * Mark fixed the reason the person typed and the person (FR-BILL-11: "Paid by phone, Keisha T."). Every Mark fixed writer records a
 * reason (API-158 requires one); a row without one says only the person, never a catalog sentence standing in for what was typed.
 */
export function leftHowText(r: LeftWords, t: RowT): string {
  const who = r.by ? shortName(r.by) : null;
  if (r.how === 'automatic_retry') return t('billing.how.automatic_retry', { tries: r.tries });
  if (r.how === 'marked_fixed') {
    const reason = r.markedReason?.trim() ?? '';
    if (reason === '') return who ?? '';
    return who ? t('billing.how.marked_fixed', { reason, who }) : reason;
  }
  return who ? t(`billing.how.${r.how}` as MessageKey, { who }) : t(`billing.how.${r.how}.nobody` as MessageKey);
}
